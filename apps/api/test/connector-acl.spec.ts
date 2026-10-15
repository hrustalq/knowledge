import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Connector ACL mirroring (issue #76, phase 6).
 *
 * What is pinned:
 * 1. **The plan.** A source-wide page mirrors as open; a restricted one as a
 *    restriction to the mapped people and mirrored groups. `mirror` drops the
 *    unmapped, `mirror_strict` also admits the owner, and an unreadable ACL
 *    fails closed to the owner in both.
 * 2. **Inheritance folds before anything is written.** One restricted layer
 *    keeps its groups; several are intersected person by person, and a group
 *    whose members cannot be read narrows the page rather than widening it.
 * 3. **GitHub normalization.** A public repository is source-wide; a private
 *    one is its collaborators (push → edit, pull → view) plus its teams.
 * 4. **Writing.** A changed plan rewrites only this connector's grants and
 *    never a manual one; the connector lifts only a restriction it placed and
 *    only while no manual grant is left; a failed re-read keeps the page as it
 *    was; a restriction lifted by hand is put back.
 */
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));

const { safeFetch } = await import('../src/common/safe-fetch.js');
const { combineLayers } = await import('../src/connectors/adapters/acl-layers.js');
const { githubRepoAcl } = await import('../src/connectors/adapters/github-acl.js');
const { aclPlanHash, aclSyncDue, planAcl } = await import('../src/connectors/connector-acl.js');
const { ConnectorAclService } = await import('../src/connectors/connector-acl.service.js');
type ExternalPrincipal = import('../src/connectors/adapters/connector.types.js').ExternalPrincipal;
type ConnectorContext = import('../src/connectors/adapters/connector.types.js').ConnectorContext;
type StoredAcl = import('../src/connectors/connector-acl.js').StoredAcl;

const mockFetch = vi.mocked(safeFetch);

const OWNER = '11111111-1111-4111-8111-111111111111';
const ALICE = '22222222-2222-4222-8222-222222222222';
const BOB = '33333333-3333-4333-8333-333333333333';
const GROUP_X = '44444444-4444-4444-8444-444444444444';
const AUDIENCE = '55555555-5555-4555-8555-555555555555';

const user = (externalId: string, level: 'view' | 'edit' = 'view', name?: string): ExternalPrincipal => ({
  type: 'user',
  externalId,
  level,
  ...(name ? { name } : {}),
});
const group = (externalId: string, level: 'view' | 'edit' = 'view'): ExternalPrincipal => ({ type: 'group', externalId, level });

const base = {
  mode: 'mirror' as const,
  audienceGroupId: null,
  ownerId: OWNER,
  users: new Map([['acc-alice', ALICE]]),
  groups: new Map([['grp-x', GROUP_X]]),
};

describe('planAcl', () => {
  it('mirrors a source-wide page as open', () => {
    const plan = planAcl({ ...base, stored: { kind: 'acl', acl: { audience: 'source-wide', principals: [] } } });
    expect(plan).toEqual({ restricted: false, grants: [], unmapped: [] });
  });

  it('restricts to the mirrored group and the mapped people, dropping the unmapped', () => {
    const plan = planAcl({
      ...base,
      stored: {
        kind: 'acl',
        acl: { audience: 'restricted', principals: [group('grp-x'), user('acc-alice', 'edit'), user('acc-carol', 'view', 'Carol')] },
      },
    });
    expect(plan.restricted).toBe(true);
    expect(plan.grants).toEqual([
      { subjectType: 'group', subjectId: GROUP_X, level: 'view' },
      { subjectType: 'user', subjectId: ALICE, level: 'edit' },
    ]);
    expect(plan.unmapped).toEqual(['Carol']);
  });

  it('admits the owner when anyone is unmapped, under mirror_strict only', () => {
    const stored: StoredAcl = { kind: 'acl', acl: { audience: 'restricted', principals: [user('acc-carol')] } };
    expect(planAcl({ ...base, stored }).grants).toEqual([]);
    expect(planAcl({ ...base, mode: 'mirror_strict', stored }).grants).toEqual([
      { subjectType: 'user', subjectId: OWNER, level: 'view' },
    ]);
    // Everyone mapped: strict adds nobody.
    const mapped: StoredAcl = { kind: 'acl', acl: { audience: 'restricted', principals: [user('acc-alice')] } };
    expect(planAcl({ ...base, mode: 'mirror_strict', stored: mapped }).grants).toEqual([
      { subjectType: 'user', subjectId: ALICE, level: 'view' },
    ]);
  });

  it('fails closed to the owner when the ACL could not be read', () => {
    for (const mode of ['mirror', 'mirror_strict'] as const) {
      expect(planAcl({ ...base, mode, stored: { kind: 'error', message: '503' } })).toEqual({
        restricted: true,
        grants: [{ subjectType: 'user', subjectId: OWNER, level: 'view' }],
        unmapped: [],
      });
    }
  });

  it('restricts a kind without per-item ACLs to the connector audience', () => {
    expect(planAcl({ ...base, audienceGroupId: AUDIENCE, stored: { kind: 'audience' } }).grants).toEqual([
      { subjectType: 'group', subjectId: AUDIENCE, level: 'view' },
    ]);
  });

  it('hashes the restriction as written, so a new mapping is a change', () => {
    const stored: StoredAcl = { kind: 'acl', acl: { audience: 'restricted', principals: [user('acc-bob')] } };
    const before = aclPlanHash(planAcl({ ...base, stored }));
    const after = aclPlanHash(planAcl({ ...base, users: new Map([['acc-bob', BOB]]), stored }));
    expect(after).not.toBe(before);
    expect(aclPlanHash(planAcl({ ...base, stored }))).toBe(before);
  });

  it('is due when never synced or once the interval has passed', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    expect(aclSyncDue(null, 60, now)).toBe(true);
    expect(aclSyncDue(new Date(now - 59 * 60_000), 60, now)).toBe(false);
    expect(aclSyncDue(new Date(now - 60 * 60_000), 60, now)).toBe(true);
  });
});

describe('combineLayers', () => {
  it('is source-wide with no restricted layer', async () => {
    expect(await combineLayers([[], []], undefined)).toEqual({ audience: 'source-wide', principals: [] });
  });

  it('keeps one layer as it is, groups included', async () => {
    const acl = await combineLayers([[], [group('grp-x'), user('acc-alice')]], undefined);
    expect(acl.audience).toBe('restricted');
    expect(acl.principals.map((p) => `${p.type}:${p.externalId}`)).toEqual(['group:grp-x', 'user:acc-alice']);
  });

  it('intersects several layers person by person, the weaker level winning', async () => {
    const members = vi.fn(async (g: ExternalPrincipal) =>
      g.externalId === 'grp-x' ? [{ externalId: 'acc-alice' }, { externalId: 'acc-bob' }] : [],
    );
    // Parent: group X (Alice, Bob). Page: Alice (edit), Carol.
    const acl = await combineLayers([[group('grp-x', 'view')], [user('acc-alice', 'edit'), user('acc-carol')]], members);
    expect(acl).toEqual({ audience: 'restricted', principals: [{ type: 'user', externalId: 'acc-alice', level: 'view' }] });
  });

  it('narrows rather than widens when a group cannot be read', async () => {
    const members = vi.fn(async () => {
      throw new Error('403');
    });
    const acl = await combineLayers([[group('grp-x')], [user('acc-alice')]], members);
    expect(acl).toEqual({ audience: 'restricted', principals: [] });
  });
});

describe('githubRepoAcl', () => {
  const ctx = (): ConnectorContext =>
    ({
      connectorId: 'c',
      workspaceId: 'w',
      config: { repoUrl: 'https://github.com/acme/handbook' },
      credential: 'token',
      onStage: async () => undefined,
      debug: () => undefined,
      allowPrivate: false,
      userId: null,
      locale: 'en',
    }) as ConnectorContext;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('reads a public repository as source-wide, without listing anyone', async () => {
    mockFetch.mockResolvedValueOnce(json({ private: false }));
    expect(await githubRepoAcl(ctx())).toEqual({ audience: 'source-wide', principals: [] });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reads a private repository as its collaborators and teams', async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/repos/acme/handbook')) return json({ private: true, owner: { type: 'Organization' } });
      if (u.includes('/collaborators')) {
        return json([
          { id: 7, login: 'alice', permissions: { pull: true, push: true } },
          { id: 8, login: 'bob', permissions: { pull: true } },
        ]);
      }
      if (u.includes('/teams')) return json([{ slug: 'docs', name: 'Docs', permission: 'pull' }]);
      throw new Error(`unexpected ${u}`);
    });
    const acl = await githubRepoAcl(ctx());
    expect(acl.audience).toBe('restricted');
    expect(acl.principals).toEqual([
      { type: 'group', externalId: 'docs', name: 'Docs', level: 'view' },
      { type: 'user', externalId: '7', name: 'alice', level: 'edit' },
      { type: 'user', externalId: '8', name: 'bob', level: 'view' },
    ]);
  });

  it('refuses a repository that is not on GitHub', async () => {
    const c = ctx();
    c.config = { repoUrl: 'https://gitlab.com/acme/handbook' };
    await expect(githubRepoAcl(c)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Writing: ConnectorAclService.applyToPage against an in-memory store.
// ---------------------------------------------------------------------------

interface Grant {
  resourceType: string;
  resourceId: string;
  subjectType: string;
  subjectId: string;
  level: string;
  origin: string;
  connectorId: string | null;
}

const PAGE = '66666666-6666-4666-8666-666666666666';
const CONNECTOR = '77777777-7777-4777-8777-777777777777';
const LINK = '88888888-8888-4888-8888-888888888888';

function harness() {
  const store = {
    doc: { workspaceId: 'w', restricted: false },
    grants: [] as Grant[],
    link: { id: LINK, documentId: PAGE, aclHash: null as string | null, aclRestricted: false },
    identities: [{ externalId: 'acc-alice', userId: ALICE }],
    groups: [{ id: GROUP_X, externalId: 'grp-x' }],
  };
  const match = (g: Grant, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (g as unknown as Record<string, unknown>)[k] === v);
  const prisma = {
    withTransaction: async <T>(fn: () => Promise<T>) => fn(),
    onCommit: vi.fn(),
    document: {
      findUnique: vi.fn(async () => ({ ...store.doc })),
      update: vi.fn(async ({ data }: { data: { restricted: boolean } }) => {
        store.doc.restricted = data.restricted;
      }),
    },
    accessGrant: {
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        store.grants = store.grants.filter((g) => !match(g, where));
      }),
      createMany: vi.fn(async ({ data }: { data: Grant[] }) => {
        store.grants.push(...data);
      }),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => store.grants.filter((g) => match(g, where)).length),
    },
    connectorLink: {
      update: vi.fn(async ({ data }: { data: { aclHash: string; aclRestricted: boolean } }) => {
        Object.assign(store.link, data);
      }),
    },
    externalIdentity: {
      findMany: vi.fn(async ({ where }: { where: { externalId: { in: string[] } } }) =>
        store.identities.filter((i) => where.externalId.in.includes(i.externalId)),
      ),
    },
    userGroup: {
      findMany: vi.fn(async ({ where }: { where: { externalId: { in: string[] } } }) =>
        store.groups.filter((g) => where.externalId.in.includes(g.externalId)),
      ),
    },
  };
  const permissions = { recomputeRestrictedBy: vi.fn(async () => 1) };
  const service = new ConnectorAclService(
    prisma as never,
    { get: () => 60 } as never,
    {} as never,
    permissions as never,
    { changed: vi.fn() } as never,
  );
  const row = { id: CONNECTOR, workspaceId: 'w', aclMode: 'mirror', aclAudienceGroupId: null, createdBy: OWNER } as never;
  const apply = (stored: StoredAcl | null) => service.applyToPage(row, { ...store.link }, stored);
  return { store, prisma, permissions, apply };
}

const restrictedTo = (...principals: ExternalPrincipal[]): StoredAcl => ({
  kind: 'acl',
  acl: { audience: 'restricted', principals },
});
const sourceWide: StoredAcl = { kind: 'acl', acl: { audience: 'source-wide', principals: [] } };

describe('ConnectorAclService.applyToPage', () => {
  it('restricts the page to the mirrored group and recomputes restricted_by', async () => {
    const h = harness();
    expect((await h.apply(restrictedTo(group('grp-x')))).changed).toBe(true);
    expect(h.store.doc.restricted).toBe(true);
    expect(h.store.link.aclRestricted).toBe(true);
    expect(h.store.grants).toEqual([
      expect.objectContaining({ subjectType: 'group', subjectId: GROUP_X, origin: 'connector', connectorId: CONNECTOR }),
    ]);
    expect(h.permissions.recomputeRestrictedBy).toHaveBeenCalledWith({ documentId: PAGE });
  });

  it('does nothing when the plan has not changed', async () => {
    const h = harness();
    await h.apply(restrictedTo(group('grp-x')));
    h.prisma.accessGrant.deleteMany.mockClear();
    expect((await h.apply(restrictedTo(group('grp-x')))).changed).toBe(false);
    expect(h.prisma.accessGrant.deleteMany).not.toHaveBeenCalled();
  });

  it('rewrites its own grants on a change and leaves manual ones alone', async () => {
    const h = harness();
    await h.apply(restrictedTo(group('grp-x')));
    h.store.grants.push({
      resourceType: 'document',
      resourceId: PAGE,
      subjectType: 'user',
      subjectId: BOB,
      level: 'view',
      origin: 'manual',
      connectorId: null,
    });
    await h.apply(restrictedTo(user('acc-alice')));
    expect(h.store.grants.map((g) => `${g.origin}:${g.subjectId}`).sort()).toEqual([`connector:${ALICE}`, `manual:${BOB}`]);
  });

  it('lifts its own restriction when the source opens up, unless a manual grant is left', async () => {
    const lifted = harness();
    await lifted.apply(restrictedTo(group('grp-x')));
    await lifted.apply(sourceWide);
    expect(lifted.store.doc.restricted).toBe(false);
    expect(lifted.store.grants).toEqual([]);

    const kept = harness();
    await kept.apply(restrictedTo(group('grp-x')));
    kept.store.grants.push({
      resourceType: 'document',
      resourceId: PAGE,
      subjectType: 'user',
      subjectId: BOB,
      level: 'manage',
      origin: 'manual',
      connectorId: null,
    });
    await kept.apply(sourceWide);
    expect(kept.store.doc.restricted).toBe(true);
    expect(kept.store.link.aclRestricted).toBe(false);
  });

  it('never lifts a restriction a person placed', async () => {
    const h = harness();
    h.store.doc.restricted = true; // restricted by hand before mirroring
    await h.apply(restrictedTo(group('grp-x')));
    expect(h.store.link.aclRestricted).toBe(false);
    await h.apply(sourceWide);
    expect(h.store.doc.restricted).toBe(true);
  });

  it('keeps a mirrored page as it was when a re-read fails', async () => {
    const h = harness();
    await h.apply(restrictedTo(group('grp-x')));
    const before = [...h.store.grants];
    const outcome = await h.apply({ kind: 'error', message: '503' });
    expect(outcome.changed).toBe(false);
    expect(h.store.grants).toEqual(before);
  });

  it('restricts a new page to its owner when its ACL could not be read', async () => {
    const h = harness();
    await h.apply({ kind: 'error', message: '503' });
    expect(h.store.doc.restricted).toBe(true);
    expect(h.store.grants).toEqual([expect.objectContaining({ subjectType: 'user', subjectId: OWNER })]);
  });

  it('puts back a mirrored restriction somebody lifted by hand', async () => {
    const h = harness();
    await h.apply(restrictedTo(group('grp-x')));
    h.store.doc.restricted = false;
    expect((await h.apply(restrictedTo(group('grp-x')))).changed).toBe(true);
    expect(h.store.doc.restricted).toBe(true);
  });

  it('is a no-op while mirroring is off', async () => {
    const h = harness();
    expect((await h.apply(null)).changed).toBe(false);
    expect(h.prisma.document.findUnique).not.toHaveBeenCalled();
  });
});
