import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import type { AgentRun } from '@prisma/client';
import type { AgentFinding, GlossaryTermSuggestion } from '@knowledge/contracts';
import { AgentExecutor } from '../src/agents/agent.executor.js';
import { AgentFindingsService } from '../src/ai/agent-findings.service.js';

/**
 * Glossary from content (#74, phase 6).
 *
 * What is pinned:
 * 1. **The glossarist carries the term.** A finding holds the entry `suggest`
 *    drafted, in the project of the page it was found on, so adding it needs
 *    no second model call. A term already in that glossary is not proposed.
 * 2. **It walks the workspace.** A page whose head an earlier run read is
 *    skipped; a page named on the run is read anyway; a page `suggest` failed
 *    on is not recorded as read.
 * 3. **Add to glossary writes once**, through `GlossaryService.create`, as the
 *    caller, into the finding's project. A second press is a 409, and a
 *    failed write releases the claim so it can be retried.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const P1 = '22222222-2222-4222-8222-222222222222';
const P2 = '33333333-3333-4333-8333-333333333333';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const PROJECT_OF: Record<string, string> = { [A]: P1, [B]: P2, [C]: P1 };
const HEAD: Record<string, string> = { [A]: 'rev-a', [B]: 'rev-b', [C]: 'rev-c' };

const suggestion = (term: string, over: Partial<GlossaryTermSuggestion> = {}): GlossaryTermSuggestion => ({
  term,
  aliases: [],
  definition: `${term} means something.`,
  occurrences: 2,
  existingTermId: null,
  ...over,
});

describe('the glossarist run', () => {
  function harness(over: { scanned?: string[]; failOn?: string; input?: Record<string, unknown> } = {}) {
    const prisma = {
      document: {
        findMany: vi.fn(async () =>
          [A, B, C].map((id) => ({ id, title: `Page ${id[0]}`, defaultBranch: 'main', branches: [{ name: 'main', headRevisionId: HEAD[id] }] })),
        ),
      },
      $queryRaw: vi.fn(async () => (over.scanned ?? []).map((id) => ({ id }))),
    };
    const glossary = {
      suggest: vi.fn(async ({ documentId }: { documentId: string }) => {
        if (documentId === over.failOn) throw new Error('model timed out');
        const suggestions: Record<string, GlossaryTermSuggestion[]> = {
          [A]: [suggestion('Merge base', { aliases: ['base'] }), suggestion('Branch', { existingTermId: 'term-1' })],
          [B]: [suggestion('Merge base'), suggestion('Outbox')],
          [C]: [suggestion('Sweeper')],
        };
        return { enabled: true, projectId: PROJECT_OF[documentId], suggestions: suggestions[documentId] ?? [] };
      }),
    };
    const exec = new AgentExecutor(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      glossary as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { scopeFor: async () => ({ workspaceId: WS, bypass: true }), audienceScope: async (s: unknown) => s } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const run = { id: 'run-1', workspaceId: WS, agentKey: 'glossarist', createdBy: 'u1', locale: 'en', input: over.input ?? {} } as unknown as AgentRun;
    const agent = { key: 'glossarist', instructions: '', skillIds: [], config: { enabled: true }, missing: [], enabled: true };
    const go = () => exec.run(run, agent as never, { userId: 'u1' } as never, vi.fn(async () => undefined));
    return { go, glossary, prisma };
  }

  it('carries each new term with the project of the page it was found on, once per run', async () => {
    const res = await harness().go();
    expect(res.findings.map((f) => f.title)).toEqual(['Merge base', 'Outbox', 'Sweeper']);
    expect(res.findings[0].term).toEqual({ term: 'Merge base', aliases: ['base'], definition: 'Merge base means something.', projectId: P1 });
    expect(res.findings[1].term?.projectId).toBe(P2);
    // "Branch" is already defined in that project: proposing it again is noise.
    expect(res.findings.some((f) => f.title === 'Branch')).toBe(false);
    expect(res.details?.glossaryScanned).toEqual(['rev-a', 'rev-b', 'rev-c']);
  });

  it('skips a page whose head an earlier run read, and says so when nothing is left', async () => {
    const h = harness({ scanned: ['rev-a', 'rev-c'] });
    const res = await h.go();
    expect(h.glossary.suggest).toHaveBeenCalledTimes(1);
    expect(h.glossary.suggest.mock.calls[0][0]).toMatchObject({ documentId: B });
    expect(res.details?.glossaryScanned).toEqual(['rev-b']);

    const done = harness({ scanned: ['rev-a', 'rev-b', 'rev-c'] });
    const none = await done.go();
    expect(done.glossary.suggest).not.toHaveBeenCalled();
    expect(none.findings).toEqual([]);
    expect(none.details).toBeUndefined();
  });

  it('reads a page named on the run even if it was read before', async () => {
    const h = harness({ scanned: ['rev-a', 'rev-b', 'rev-c'], input: { documentIds: [A] } });
    await h.go();
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(h.glossary.suggest).toHaveBeenCalled();
  });

  it('does not record a page it could not read, so the next run tries it again', async () => {
    const res = await harness({ failOn: B }).go();
    expect(res.details?.glossaryScanned).toEqual(['rev-a', 'rev-c']);
  });
});

describe('Add to glossary', () => {
  const termFinding = (over: Partial<AgentFinding> = {}): AgentFinding => ({
    kind: 'gap',
    severity: 'info',
    title: 'Merge base',
    detail: 'The nearest common ancestor.',
    documentIds: [B],
    documentTitles: ['Page b'],
    term: { term: 'Merge base', aliases: ['base'], definition: 'The nearest common ancestor.', projectId: P2 },
    ...over,
  });

  /** An agent_runs row whose findings the guarded `jsonb_set` statements really update. */
  function service(finding: AgentFinding, create?: (dto: Record<string, unknown>) => Promise<unknown>) {
    const findings: Array<Record<string, unknown>> = [{ ...finding }];
    const prisma = {
      agentRun: { findUnique: vi.fn(async () => ({ id: 'run-1', workspaceId: WS, agentKey: 'glossarist', findings: structuredClone(findings) })) },
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        const f = findings[Number(values[0])];
        if (sql.includes("'proposedAt'") && sql.includes('COALESCE')) {
          if (f.proposedAt || f.mergeRequestId) return 0;
          f.proposedAt = values[1];
          return 1;
        }
        if (sql.includes("'termId'")) f.termId = values[1];
        else if (sql.includes("'proposedAt'")) f.proposedAt = null;
        return 1;
      }),
    };
    const glossary = {
      create: vi.fn(create ?? (async (dto: Record<string, unknown>) => ({ termId: 'term-new', term: dto.term, projectId: dto.projectId }))),
    };
    const svc = new AgentFindingsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      glossary as never,
    );
    return { svc, glossary, findings };
  }

  it('creates an AI-sourced term in the cited page\'s project, as the caller, with the person\'s edits', async () => {
    const { svc, glossary, findings } = service(termFinding());
    const res = await svc.addTerm(WS, 'run-1', 0, { userId: 'u2' } as never, { definition: 'Edited.' });
    expect(glossary.create).toHaveBeenCalledWith(
      { workspaceId: WS, projectId: P2, term: 'Merge base', definition: 'Edited.', aliases: ['base'], source: 'ai' },
      'u2',
    );
    expect(res).toEqual({ termId: 'term-new', term: 'Merge base', projectId: P2 });
    expect(findings[0].termId).toBe('term-new');
  });

  it('refuses a second press with a 409 naming the term', async () => {
    const { svc, glossary } = service(termFinding());
    await svc.addTerm(WS, 'run-1', 0, { userId: 'u2' } as never);
    await expect(svc.addTerm(WS, 'run-1', 0, { userId: 'u2' } as never)).rejects.toMatchObject({
      response: { reason: 'already-added', termId: 'term-new' },
    });
    expect(glossary.create).toHaveBeenCalledTimes(1);
  });

  it('passes the glossary\'s own 409 through and releases the claim, so a retry is possible', async () => {
    let calls = 0;
    const { svc, findings } = service(termFinding(), async (dto) => {
      if (calls++ === 0) throw new ConflictException(`"${String(dto.term)}" is already in this glossary`);
      return { termId: 'term-2', term: dto.term, projectId: dto.projectId };
    });
    await expect(svc.addTerm(WS, 'run-1', 0, { userId: 'u2' } as never)).rejects.toBeInstanceOf(ConflictException);
    expect(findings[0].proposedAt).toBeNull();
    await expect(svc.addTerm(WS, 'run-1', 0, { userId: 'u2' } as never, { term: 'Merge-base' })).resolves.toMatchObject({ termId: 'term-2' });
  });

  it('refuses a finding that proposes no term', async () => {
    const { svc } = service(termFinding({ term: undefined }));
    await expect(svc.addTerm(WS, 'run-1', 0, { userId: 'u2' } as never)).rejects.toMatchObject({ status: 400 });
  });
});
