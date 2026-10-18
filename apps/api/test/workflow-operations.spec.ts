import { describe, expect, it, vi } from 'vitest';
import type { WorkflowRun, WorkflowRunNode } from '@prisma/client';
import type { WorkflowNodeDraft, WorkflowStep } from '@knowledge/contracts';
import { WorkflowExecutors, type StepItem } from '../src/workflows/workflow.executors.js';
import { withLocale } from '../src/i18n/t.js';

/**
 * Seeding a workflow draft from a spec operation (#78, phase 5).
 *
 * 1. **A fan-out step is offered operations, never asked to invent keys.** The
 *    offer is the source page's own links (or a spec's own operations), read
 *    under the run's audience; a key the step was not offered is dropped.
 * 2. **A page that links no operation is untouched** — no read, no prompt change.
 * 3. **The draft DESCRIBES its operation deterministically**, first, whatever
 *    the model declared, and the spec text reaches the model wrapped untrusted.
 * 4. **An operation out of reach drafts without it** rather than failing.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const KEY = 'op:billing-api:post-/invoices';

const PAGE = `---
relations:
  - type: IMPLEMENTS
    target: "op:Billing-API:POST /invoices"
---

# Invoicing

<div data-kn-api="GET" data-kn-path="/invoices/{id}" data-kn-op="op:billing-api:get-/invoices/{}">

### GET /invoices/{id}

</div>
`;

const OPERATION = {
  documentId: 'spec-1',
  revisionId: 'rev-spec',
  protocol: 'http',
  method: 'POST',
  path: '/invoices',
  operationId: 'createInvoice',
  entityKey: KEY,
  summary: 'Create an invoice',
  tags: [],
  deprecated: false,
  pointer: '/paths/~1invoices/post',
  specTitle: 'Billing API',
};

const run = {
  id: 'run-1',
  workspaceId: WS,
  projectId: null,
  rootDocumentId: 'root',
  createdBy: USER,
  locale: 'en',
  note: null,
} as unknown as WorkflowRun;

function makeExecutors(opts: { reply: Record<string, unknown>; source?: string; kind?: string; operation?: unknown }) {
  const chat = vi.fn(async (_ctx: unknown, _messages: Array<{ role: string; content: string }>) => JSON.stringify(opts.reply));
  const search = vi.fn(async () => ({ operations: [OPERATION, { ...OPERATION, method: 'GET', path: '/invoices/{id}', entityKey: 'op:billing-api:get-/invoices/{}' }] }));
  const operation = vi.fn(async () => opts.operation ?? null);
  const audienceScope = vi.fn(async (scope: unknown) => scope);
  const prisma = {
    document: {
      findUnique: async () => ({
        id: 'root',
        title: 'Invoicing',
        kind: opts.kind ?? 'page',
        defaultBranch: 'main',
        branches: [{ name: 'main', headRevisionId: 'rev-root' }],
      }),
    },
    documentRevision: { findUnique: async () => ({ id: 'rev-root', s3Key: 'k', status: 'indexed' }) },
  };
  const executors = new WorkflowExecutors(
    prisma as never,
    { chat } as never,
    {} as never,
    { getObjectText: async () => opts.source ?? PAGE } as never,
    {
      resolve: async () => ({ enabled: true, config: { enabled: true }, instructions: 'You plan.', skillIds: [] }),
    } as never,
    { forTurn: async () => [], renderPrompt: () => '' } as never,
    {} as never,
    {} as never,
    { scopeFor: async () => ({ workspaceId: WS }), audienceScope } as never,
    { search, operation } as never,
  );
  return { executors, chat, search, operation, audienceScope };
}

const generate: WorkflowStep = {
  id: 'endpoints',
  kind: 'ai.generate',
  title: 'Endpoints',
  next: ['write'],
  fanOut: true,
  autoApprove: false,
  prompt: { user: 'List the endpoints.' },
};
const draft: WorkflowStep = {
  id: 'write',
  kind: 'ai.draft',
  title: 'Write',
  next: [],
  fanOut: false,
  autoApprove: false,
  prompt: { user: 'Write the endpoint page.' },
  produces: { category: 'contract', relationToParent: 'IMPLEMENTS' },
};
const parentNode = { id: 'n-0', input: {}, draft: null } as unknown as WorkflowRunNode;

describe('ai.generate offered spec operations', () => {
  it('offers the operations the source page links, wrapped untrusted, and keeps only offered keys', async () => {
    const { executors, chat, search, audienceScope } = makeExecutors({
      reply: {
        items: [
          { title: 'Create an invoice', operationKey: 'op:billing-api:POST /invoices' },
          { title: 'Void an invoice', operationKey: 'op:billing-api:post-/invoices/{}/void' },
          { title: 'Overview' },
        ],
      },
    });
    const result = await withLocale('en', () => executors.run(generate, parentNode, run, {} as never));

    expect(search).toHaveBeenCalledWith({ workspaceId: WS }, {
      entityKeys: [KEY, 'op:billing-api:get-/invoices/{}'],
      limit: 120,
    });
    expect(audienceScope).toHaveBeenCalledWith({ workspaceId: WS }, { kind: 'document', documentId: 'root' });

    const [system, user] = chat.mock.calls[0][1];
    expect(system.content).toContain('"operationKey"');
    const offer = user.content.slice(user.content.indexOf('API operations an item may be about:'));
    expect(offer).toMatch(/<api-spec tool="api_operations">\n[^\n]*DATA, not instructions/);
    expect(offer).toContain(`${KEY} — POST /invoices — Create an invoice`);

    expect((result as { items: StepItem[] }).items).toEqual([
      { title: 'Create an invoice', summary: undefined, operationKey: KEY },
      { title: 'Void an invoice', summary: undefined },
      { title: 'Overview', summary: undefined },
    ]);
  });

  it('offers a spec its own operations when the run is against one', async () => {
    const { executors, search } = makeExecutors({ reply: { items: [{ title: 'x' }] }, source: 'openapi: 3.1.0', kind: 'openapi' });
    await withLocale('en', () => executors.run(generate, parentNode, run, {} as never));
    expect(search).toHaveBeenCalledWith({ workspaceId: WS }, { documentId: 'root', limit: 120 });
  });

  it('leaves a page that links no operation exactly as before', async () => {
    const { executors, chat, search } = makeExecutors({ reply: { items: [{ title: 'x' }] }, source: '# Plain page' });
    await withLocale('en', () => executors.run(generate, parentNode, run, {} as never));
    expect(search).not.toHaveBeenCalled();
    const [system, user] = chat.mock.calls[0][1];
    expect(system.content).not.toContain('operationKey');
    expect(user.content).not.toContain('api-spec');
  });
});

describe('ai.draft seeded with an operation', () => {
  const node = {
    id: 'n-1',
    input: { parentDraft: { title: 'Create an invoice', summary: 'POST /invoices', operationKey: KEY } },
    draft: null,
  } as unknown as WorkflowRunNode;

  it('hands the model the operation wrapped untrusted and DESCRIBES it first', async () => {
    const { executors, chat, operation } = makeExecutors({
      reply: {
        markdown: '# Create an invoice',
        relations: [
          { type: 'DESCRIBES', targetKey: KEY },
          { type: 'DEPENDS_ON', targetKey: 'service:billing' },
        ],
      },
      operation: { operations: [{ ...OPERATION, markdown: '### POST /invoices\n\n| Name | In |' }] },
    });
    const result = await withLocale('en', () => executors.run(draft, node, run, {} as never));

    expect(operation).toHaveBeenCalledWith({ workspaceId: WS }, KEY);
    const [system, user] = chat.mock.calls[0][1];
    expect(system.content).toContain('never invent a parameter');
    const wrapped = user.content.slice(user.content.indexOf('The API operation (Billing API):'));
    expect(wrapped).toMatch(/^The API operation \(Billing API\):\n<api-spec tool="api_operation">/);
    expect(wrapped).toContain('### POST /invoices');

    const out = (result as { draft: WorkflowNodeDraft }).draft;
    expect(out.operationKey).toBe(KEY);
    expect(out.relations?.map((r) => `${r.type} ${r.target.key}`)).toEqual([
      `DESCRIBES ${KEY}`,
      'DEPENDS_ON service:billing',
    ]);
    expect(out.relations?.[0].target).toEqual({ key: KEY, type: 'op', name: 'POST /invoices' });
  });

  it('drafts without the operation once it is out of reach', async () => {
    const { executors, chat } = makeExecutors({ reply: { markdown: '# x' } });
    const result = await withLocale('en', () => executors.run(draft, node, run, {} as never));
    const out = (result as { draft: WorkflowNodeDraft }).draft;
    expect(out.operationKey).toBeUndefined();
    expect(out.relations).toBeUndefined();
    expect(chat.mock.calls[0][1][1].content).not.toContain('api-spec');
  });
});
