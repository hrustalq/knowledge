import { describe, expect, it, vi } from 'vitest';
import { headingSections } from '@knowledge/editor-schema/markdown';
import { operationAnchor, sourceSyncHealthy, verificationStateFor } from '@knowledge/contracts';
import { anchorChanges, SourceDependentsService } from '../src/connectors/source-dependents.service.js';

/**
 * Dependent pages and healthy-sync trust (#674, phase 5a).
 *
 * Pinned:
 * 1. A source-backed page's trust is its sync's health: `verified` while not
 *    paused, held or failing and checked within two intervals, else `expired`.
 *    A person's flag and an open report still outrank it; a stamp is ignored.
 * 2. `headingSections` gives h1–h3 the read view's deduped ids.
 * 3. `anchorChanges` names the anchors a new version dropped, and maps one
 *    whose section text reappears under a new id to it (renamed).
 * 4. Once a new version is indexed, a page linking a dropped anchor, or
 *    naming a dropped entity key, is flagged `requested` with no model call —
 *    unless it is already flagged, archived or itself source-backed.
 */

const NOW = new Date('2026-11-01T12:00:00Z');
const healthy = { pausedAt: null, heldAt: null, failures: 0, lastPulledAt: new Date(NOW.getTime() - 90 * 60_000), intervalMinutes: 60 };

describe('source-backed trust', () => {
  it('reads sync health, under a person flag and an open report', () => {
    expect(sourceSyncHealthy(healthy, NOW)).toBe(true);
    expect(sourceSyncHealthy({ ...healthy, lastPulledAt: new Date(NOW.getTime() - 121 * 60_000) }, NOW)).toBe(false);
    expect(sourceSyncHealthy({ ...healthy, pausedAt: NOW }, NOW)).toBe(false);
    expect(sourceSyncHealthy({ ...healthy, heldAt: NOW }, NOW)).toBe(false);
    expect(sourceSyncHealthy({ ...healthy, failures: 1 }, NOW)).toBe(false);
    // Manual only: no clock to fall behind.
    expect(sourceSyncHealthy({ ...healthy, intervalMinutes: null, lastPulledAt: null }, NOW)).toBe(true);

    expect(verificationStateFor({ verifiedRevisionId: null, source: healthy }, 'r1', 0, NOW)).toBe('verified');
    expect(verificationStateFor({ verifiedRevisionId: 'r0', source: { ...healthy, failures: 3 } }, 'r1', 0, NOW)).toBe('expired');
    expect(verificationStateFor({ verifiedRevisionId: null, verificationFlag: 'requested', source: healthy }, 'r1', 0, NOW)).toBe('requested');
    expect(verificationStateFor({ verifiedRevisionId: null, source: healthy }, 'r1', 1, NOW)).toBe('flagged');
    expect(verificationStateFor({ verifiedRevisionId: null, verificationFlag: 'outdated', source: healthy }, 'r1', 0, NOW)).toBe('outdated');
  });
});

describe('anchors', () => {
  it('ids h1–h3 the way the reader does', () => {
    const md = '# Setup\n\nIntro.\n\n## Install & run\n\nSteps.\n\n## Setup\n\nAgain.\n\n#### Deep\n\nkept in body\n';
    expect(headingSections(md)).toEqual([
      { id: 'setup', body: 'Intro.' },
      { id: 'install-run', body: 'Steps.' },
      { id: 'setup-1', body: 'Again.\n\n#### Deep\n\nkept in body' },
    ]);
  });

  it('splits removed from renamed', () => {
    const before = [
      { id: 'auth', body: 'Use a token.' },
      { id: 'limits', body: '100 per minute.' },
      { id: 'keep', body: 'Same.' },
    ];
    const after = [
      { id: 'authentication', body: 'Use a token.' },
      { id: 'keep', body: 'Same.' },
    ];
    expect([...anchorChanges(before, after)]).toEqual([
      ['auth', 'authentication'],
      ['limits', null],
    ]);
    // A spec operation has no body: never "renamed".
    expect([...anchorChanges([{ id: 'op-a', body: null }], [{ id: 'op-b', body: null }])]).toEqual([['op-a', null]]);
  });
});

describe('SourceDependentsService.revisionIndexed', () => {
  function setup(opts: { kind?: string; before: string; after: string; keys?: [string[], string[]]; holders?: Map<string, string[]> }) {
    const flagged: Array<[string, string, string]> = [];
    const revisions: Record<string, unknown> = {
      r2: { id: 'r2', documentId: 'src', branchId: 'b', revisionNumber: 2, s3Key: 'k2', document: { id: 'src', workspaceId: 'w', title: 'Vendor API', kind: opts.kind ?? 'page' } },
    };
    const prisma = {
      documentRevision: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => revisions[where.id] ?? null),
        findFirst: vi.fn(async () => ({ id: 'r1', s3Key: 'k1' })),
      },
      connectorLink: {
        findFirst: vi.fn(async () => ({ connector: { createdBy: 'owner' } })),
        // dep3 is itself source-backed.
        findMany: vi.fn(async () => [{ documentId: 'dep3' }]),
      },
      pageLink: {
        findMany: vi.fn(async ({ where }: { where: { targetAnchor: { in: string[] } } }) =>
          [
            { sourceDocumentId: 'dep1', targetAnchor: 'limits' },
            { sourceDocumentId: 'dep1', targetAnchor: 'auth' },
            { sourceDocumentId: 'dep3', targetAnchor: 'limits' },
            { sourceDocumentId: 'flagged', targetAnchor: 'limits' },
            { sourceDocumentId: 'op-linker', targetAnchor: operationAnchor({ entityKey: 'op:pets:GET /pets/{}', method: 'GET' }) },
          ].filter((l) => where.targetAnchor.in.includes(l.targetAnchor)),
        ),
      },
      // `flagged` already carries a flag, so the query leaves it out.
      document: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => id !== 'flagged').map((id) => ({ id }))) },
      apiOperation: {
        findMany: vi.fn(async ({ where }: { where: { revisionId: string } }) =>
          where.revisionId === 'r1'
            ? [{ entityKey: 'op:pets:GET /pets/{}', method: 'GET' }, { entityKey: 'op:pets:GET /owners', method: 'GET' }]
            : [{ entityKey: 'op:pets:GET /owners', method: 'GET' }],
        ),
      },
    };
    const storage = { getObjectText: vi.fn(async (key: string) => (key === 'k1' ? opts.before : opts.after)) };
    const [kb, ka] = opts.keys ?? [[], []];
    const graph = {
      revisionEntityKeys: vi.fn(async (_w: string, _d: string, rev: string) => new Set(rev === 'r1' ? kb : ka)),
      documentsNamingKeys: vi.fn(async () => opts.holders ?? new Map()),
    };
    const verification = { flag: vi.fn(async (id: string, flag: string, o: { note: string }) => flagged.push([id, flag, o.note])) };
    // The sentinel is off here: phase 5b's judge is pinned in source-judge.spec.ts.
    const registry = { resolve: async () => ({ enabled: false, config: { enabled: false }, missing: [] }) };
    const svc = new SourceDependentsService(prisma as never, storage as never, graph as never, verification as never, registry as never, {} as never);
    return { svc, flagged, graph };
  }

  it('flags a page linking a removed or renamed section, with no model involved', async () => {
    const { svc, flagged } = setup({
      before: '## Auth\n\nUse a token.\n\n## Limits\n\n100 per minute.\n',
      after: '## Authentication\n\nUse a token.\n',
    });
    expect(await svc.revisionIndexed('r2')).toBe(1);
    expect(flagged.map(([id, flag]) => [id, flag])).toEqual([['dep1', 'requested']]);
    // t() returns the key without a loaded catalogue.
    expect(flagged[0]![2]).toBe('connector.sourceChangedNote');
  });

  it('flags a page naming an entity key the new version dropped', async () => {
    const { svc, flagged, graph } = setup({
      before: '# Same\n',
      after: '# Same\n',
      keys: [['service:billing', 'service:auth'], ['service:auth']],
      holders: new Map([['dep2', ['service:billing']], ['src', ['service:billing']]]),
    });
    expect(await svc.revisionIndexed('r2')).toBe(1);
    expect(graph.documentsNamingKeys).toHaveBeenCalledWith('w', ['service:billing'], { kind: 'all' });
    expect(flagged.map(([id]) => id)).toEqual(['dep2']);
  });

  it("reads a spec page's anchors from its operations", async () => {
    const { svc, flagged } = setup({ kind: 'openapi', before: '', after: '' });
    expect(await svc.revisionIndexed('r2')).toBe(1);
    expect(flagged.map(([id]) => id)).toEqual(['op-linker']);
  });

  it('does nothing when no anchor or key was dropped', async () => {
    const { svc, flagged, graph } = setup({ before: '## A\n\nx\n', after: '## A\n\ny\n\n## B\n\nz\n' });
    expect(await svc.revisionIndexed('r2')).toBe(0);
    expect(graph.documentsNamingKeys).not.toHaveBeenCalled();
    expect(flagged).toEqual([]);
  });
});
