import { describe, expect, it, vi } from 'vitest';
import type { AssistantFormPrompt, AssistantMessageInfo } from '@knowledge/contracts';
import { FLOW_NO_LINK, FLOW_SCOPE_SUBTREE } from '@knowledge/contracts';
import { AssistantToolsService } from '../src/assistant/assistant.tools.js';
import { acceptsAnswer, openFlow } from '../src/assistant/flow-chain.js';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';
import { FlowsService } from '../src/flows/flows.service.js';
import type { AccessScope } from '../src/permissions/access-scope.js';

/**
 * Question flows in the assistant (#425, phase 2).
 *
 * What is pinned:
 * 1. **The flow is rebuilt from the thread**, not stored: a run of one flow's
 *    prompts and answers, broken by anything else.
 * 2. **Only the open question — or the one answered last — takes an answer.**
 *    An older form submitted late is refused.
 * 3. **A flow tool with an argument missing asks instead of running**, one
 *    question with server-built options, and runs once nothing is open.
 * 4. **Answers come from the harness, never the model**: a projectId the model
 *    restates inside a flow is ignored.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';
const CHILD_A = '33333333-3333-4333-8333-333333333333';
const CHILD_B = '44444444-4444-4444-8444-444444444444';
const PROJECT = '55555555-5555-4555-8555-555555555555';
const OWNER = '66666666-6666-4666-8666-666666666666';
const scope = { workspaceId: WS, bypass: true, denied: new Set<string>() } as unknown as AccessScope;

type Msg = Pick<AssistantMessageInfo, 'role' | 'prompt' | 'answer'>;
const ask = (questionId: string): Msg => ({
  role: 'assistant',
  prompt: { kind: 'form', question: questionId, fields: [], flow: 'capture-decision', questionId },
  answer: null,
});
const reply = (questionId: string, value: string | null): Msg => ({
  role: 'user',
  prompt: null,
  answer: { flow: 'capture-decision', questionId, value },
});
const typed: Msg = { role: 'user', prompt: null, answer: null };

describe('openFlow', () => {
  it('rebuilds the answers of the current run, a later answer to a question winning', () => {
    const open = openFlow([typed, ask('project'), reply('project', 'a'), ask('relatedPage'), reply('relatedPage', 'x'), reply('relatedPage', FLOW_NO_LINK), ask('reviewer')]);
    expect(open).toEqual({
      flow: 'capture-decision',
      answers: { project: 'a', relatedPage: FLOW_NO_LINK },
      open: 'reviewer',
      lastAnswered: 'relatedPage',
    });
  });

  it('is closed when the newest message asked nothing, and a typed message ends the run', () => {
    expect(openFlow([ask('project'), reply('project', 'a'), { role: 'assistant', prompt: null, answer: null }])).toBeNull();
    expect(openFlow([ask('project'), reply('project', 'a'), typed, ask('project')])?.answers).toEqual({});
  });

  it('takes an answer to the open question or the last answered one, nothing older', () => {
    const open = openFlow([ask('project'), reply('project', 'a'), ask('relatedPage'), reply('relatedPage', 'x'), ask('reviewer')]);
    const answer = (questionId: string) => ({ flow: 'capture-decision' as const, questionId, value: 'v' });
    expect(acceptsAnswer(open, answer('reviewer'))).toBe(true);
    expect(acceptsAnswer(open, answer('relatedPage'))).toBe(true);
    expect(acceptsAnswer(open, answer('project'))).toBe(false);
    expect(acceptsAnswer(open, { flow: 'mark-outdated', questionId: 'reviewer', value: 'v' })).toBe(false);
    expect(acceptsAnswer(null, answer('project'))).toBe(false);
  });
});

function tools() {
  const captures = {
    capture: vi.fn(async () => ({
      captureId: 'c-1',
      state: 'proposed',
      outcome: 'new-page',
      mergeRequestId: 'mr-1',
      targetDocumentId: null,
      glossaryTermId: null,
      webUrl: null,
      similar: [],
    })),
  };
  const mergeRequests = { setReviewers: vi.fn(async () => ({})) };
  const health = {
    bulk: vi.fn(async (_s: AccessScope, input: { documentIds: string[] }) => ({
      action: 'outdated',
      results: input.documentIds.map((documentId) => ({ documentId, ok: true })),
    })),
  };
  const prisma = {
    project: { findMany: vi.fn(async () => [{ id: PROJECT, name: 'Platform' }]) },
    document: {
      findUnique: vi.fn(async () => ({ id: PAGE, workspaceId: WS, title: 'Search' })),
      findMany: vi.fn(async (q: { where: { path?: unknown } }) =>
        q.where.path
          ? [
              { id: CHILD_A, title: 'Ranking' },
              { id: CHILD_B, title: 'Indexing' },
            ]
          : [{ id: PAGE, title: 'Search', ownerId: OWNER }],
      ),
    },
    workspaceMember: { findMany: vi.fn(async () => [{ userId: OWNER, user: { displayName: 'Owner' } }]) },
  };
  const permissions = { scopeFor: vi.fn(async () => scope), levelFor: vi.fn(async () => 'edit') };
  const search = { search: vi.fn(async () => ({ results: [{ documentId: PAGE }] })) };
  const flows = new FlowsService(prisma as never, permissions as never, search as never, captures as never, mergeRequests as never, health as never);
  const svc = Object.create(AssistantToolsService.prototype) as AssistantToolsService;
  Object.assign(svc, {
    access: { requireRole: vi.fn(async () => undefined) },
    prisma,
    permissions,
    flows,
    logger: { warn: vi.fn() },
  });
  return { svc, captures, mergeRequests, health };
}

const decision = { title: 'Use RRF', context: 'Two rankers', decision: 'Fuse with RRF', projectId: PROJECT };
const ctx = { principal: DEV_PRINCIPAL, workspaceId: WS };
const formOf = (res: { prompt?: unknown }) => res.prompt as AssistantFormPrompt;

describe('capture_decision', () => {
  it('asks for the project when none was named, and writes nothing', async () => {
    const { svc, captures } = tools();
    const { projectId: _named, ...unnamed } = decision;
    const res = await svc.execute('capture_decision', unnamed, ctx);
    const form = formOf(res);
    expect(form).toMatchObject({ kind: 'form', flow: 'capture-decision', questionId: 'project', step: 1, of: 3 });
    expect(form.fields[0]).toMatchObject({ type: 'choice', options: [{ value: PROJECT, recommended: true }] });
    expect(captures.capture).not.toHaveBeenCalled();
  });

  it('runs on the answers the harness hands it, assigning the picked reviewer', async () => {
    const { svc, captures, mergeRequests } = tools();
    const answers = { project: PROJECT, relatedPage: PAGE, reviewer: OWNER };
    // The model restates a different project; inside the flow the answer wins.
    const res = await svc.execute(
      'capture_decision',
      { ...decision, projectId: '77777777-7777-4777-8777-777777777777' },
      { ...ctx, flow: { flow: 'capture-decision', answers } },
    );
    expect(res.ok).toBe(true);
    expect(captures.capture).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT, relatedDocumentIds: [PAGE], session: { client: 'assistant' } }),
      DEV_PRINCIPAL,
    );
    expect(mergeRequests.setReviewers).toHaveBeenCalledWith('mr-1', [OWNER], DEV_PRINCIPAL.userId);
  });

  it('asks the next question, not the task, while one is open', async () => {
    const { svc, captures } = tools();
    const res = await svc.execute('capture_decision', decision, { ...ctx, flow: { flow: 'capture-decision', answers: { project: PROJECT } } });
    expect(formOf(res)).toMatchObject({ questionId: 'relatedPage', step: 2, of: 3 });
    expect(captures.capture).not.toHaveBeenCalled();
  });

  it('drops the reviewer once the page answer becomes "No link", and says so', async () => {
    const { svc, captures, mergeRequests } = tools();
    const answers = { project: PROJECT, relatedPage: FLOW_NO_LINK, reviewer: OWNER };
    const res = await svc.execute('capture_decision', decision, { ...ctx, flow: { flow: 'capture-decision', answers } });
    expect(JSON.parse(res.content).dropped).toEqual([{ question: 'reviewer', reason: 'not-applicable' }]);
    expect(captures.capture).toHaveBeenCalledWith(expect.not.objectContaining({ relatedDocumentIds: expect.anything() }), DEV_PRINCIPAL);
    expect(mergeRequests.setReviewers).not.toHaveBeenCalled();
  });

  it('asks nothing when the project was named', async () => {
    const { svc, captures } = tools();
    const res = await svc.execute('capture_decision', decision, ctx);
    expect(res.prompt).toBeUndefined();
    expect(captures.capture).toHaveBeenCalledOnce();
  });
});

describe('mark_outdated', () => {
  it('asks the scope first when the page has subpages', async () => {
    const { svc, health } = tools();
    const res = await svc.execute('mark_outdated', { documentId: PAGE, reason: 'Replaced' }, ctx);
    // Three while the scope is open: the exclusions apply until "this page only" rules them out.
    expect(formOf(res)).toMatchObject({ flow: 'mark-outdated', questionId: 'scope', step: 1, of: 3 });
    expect(JSON.parse(res.content).dropped).toBeUndefined();
    expect(health.bulk).not.toHaveBeenCalled();
  });

  it('marks the subtree minus the exclusions once answered', async () => {
    const { svc, health } = tools();
    const answers = { scope: FLOW_SCOPE_SUBTREE, exclusions: [CHILD_B] };
    const res = await svc.execute('mark_outdated', { documentId: PAGE, reason: 'Replaced' }, { ...ctx, flow: { flow: 'mark-outdated', answers } });
    expect(res.ok).toBe(true);
    expect(health.bulk).toHaveBeenCalledWith(scope, { action: 'outdated', documentIds: [PAGE, CHILD_A], note: 'Replaced' }, DEV_PRINCIPAL.userId);
  });
});

describe('ask_user', () => {
  it('keeps one recommended option per field', async () => {
    const { svc } = tools();
    const res = await svc.execute(
      'ask_user',
      {
        question: 'Which?',
        fields: [
          {
            type: 'choice',
            name: 'pick',
            label: 'Pick',
            options: [
              { value: 'a', label: 'A', recommended: true },
              { value: 'b', label: 'B', recommended: true },
            ],
          },
        ],
      },
      ctx,
    );
    const field = formOf(res).fields[0] as { options: Array<{ recommended?: boolean }> };
    expect(field.options.map((o) => o.recommended === true)).toEqual([true, false]);
  });
});
