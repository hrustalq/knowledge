import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import { AgentRunsService } from '../src/ai/ai-agents.service.js';
import { AgentScheduleSweeper } from '../src/agents/agent-schedule.sweeper.js';
import { AgentProcessor } from '../src/agents/agent.processor.js';
import { AgentFindingsService } from '../src/ai/agent-findings.service.js';
import { ApiDriftCheckService } from '../src/api-specs/api-drift-check.service.js';
import { CaptureService } from '../src/captures/capture.service.js';
import { ComponentDraftsService } from '../src/components/component-drafts.service.js';
import { ConnectorsService } from '../src/connectors/connectors.service.js';
import { MergeRequestsService } from '../src/documents/merge-requests.service.js';
import { ProjectsService } from '../src/projects/projects.service.js';
import { SiteDomainsService } from '../src/publishing/site-domains.service.js';
import { SITE_MAX_VERSIONS, SitesService } from '../src/publishing/sites.service.js';
import { TemplatesService } from '../src/templates/templates.service.js';
import { WorkflowTriggerService } from '../src/workflows/workflow-trigger.service.js';
import { WorkflowsService } from '../src/workflows/workflows.service.js';
import { WorkItemHandoffService } from '../src/connectors/handoff/work-item-handoff.service.js';

/**
 * #815: every "is there one already?" read and its insert run under
 * `withSubjectLock`. The rig is a stateful in-memory Prisma that yields on every
 * query, so two calls fired together interleave exactly where the old code
 * raced, and models `pg_advisory_xact_lock` as a mutex per key held until the
 * transaction that took it ends (re-entrant within it, a no-op outside one).
 * Writes do not roll back, so each case counts rows a refused call never wrote.
 */
type Row = Record<string, any>;
const tick = () => new Promise((r) => setImmediate(r));
const isPlain = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
/** Column defaults the schema fills in that the code under test reads back. */
const DEFAULTS: Record<string, Row> = { agentRun: { status: 'pending' }, mergeRequest: { status: 'open' } };
const OPS = ['in', 'notIn', 'not', 'startsWith', 'equals', 'gte', 'hasSome'];

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (k === 'AND') return (v as Row[]).every((w) => matches(row, w));
    if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
    if (!(k in row)) return isPlain(v) && k.includes('_') ? matches(row, v) : true; // compound unique, or a relation filter (ignored)
    const x = row[k];
    if (isPlain(v) && isPlain(x) && !Object.keys(v).some((o) => OPS.includes(o))) return matches(x, v); // a nested relation row
    if (!isPlain(v) || !Object.keys(v).some((o) => OPS.includes(o))) return x === v;
    const ci = v.mode === 'insensitive';
    const norm = (s: unknown) => (ci && typeof s === 'string' ? s.toLowerCase() : s);
    if ('in' in v && !(v.in as unknown[]).includes(x)) return false;
    if ('notIn' in v && (v.notIn as unknown[]).includes(x)) return false;
    if ('not' in v && x === v.not) return false;
    if ('startsWith' in v && !String(x).startsWith(v.startsWith)) return false;
    if ('equals' in v && norm(x) !== norm(v.equals)) return false;
    if ('gte' in v && !(x >= v.gte)) return false;
    return true;
  });
}

function rig(seed: Record<string, Row[]> = {}, include: Record<string, (row: Row, t: Record<string, Row[]>) => Row> = {}) {
  const t: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
  const table = (m: string) => (t[m] ??= []);
  const out = (m: string, r: Row | undefined) => (r ? { ...r, ...include[m]?.(r, t) } : null);
  let n = 0;

  const als = new AsyncLocalStorage<{ keys: Set<string>; releases: Array<() => void>; after: Array<() => unknown> }>();
  const locks = new Map<string, Promise<void>>();
  const withTransaction = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (als.getStore()) return fn();
    const scope = { keys: new Set<string>(), releases: [] as Array<() => void>, after: [] as Array<() => unknown> };
    const result = await als.run(scope, async () => {
      try {
        return await fn();
      } finally {
        scope.releases.forEach((r) => r());
      }
    });
    for (const fn of scope.after) await fn();
    return result;
  };

  const delegate = (m: string) => ({
    count: async ({ where }: Row = {}) => (await tick(), table(m).filter((r) => matches(r, where)).length),
    findFirst: async ({ where }: Row = {}) => (await tick(), out(m, table(m).find((r) => matches(r, where)))),
    findUnique: async ({ where }: Row) => (await tick(), out(m, table(m).find((r) => matches(r, where)))),
    findMany: async ({ where }: Row = {}) => (await tick(), table(m).filter((r) => matches(r, where)).map((r) => out(m, r)!)),
    create: async ({ data }: Row) => {
      await tick();
      const row = { id: `${m}-${++n}`, createdAt: new Date(), ...DEFAULTS[m], ...data };
      table(m).push(row);
      return out(m, row)!;
    },
    createMany: async ({ data }: Row) => (await tick(), (data as Row[]).forEach((d) => table(m).push({ id: `${m}-${++n}`, ...d })), { count: data.length }),
    update: async ({ where, data }: Row) => (await tick(), out(m, Object.assign(table(m).find((r) => matches(r, where))!, data))!),
    updateMany: async ({ where, data }: Row) => {
      await tick();
      const hit = table(m).filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    delete: async ({ where }: Row) => {
      await tick();
      const i = table(m).findIndex((r) => matches(r, where));
      if (i < 0) throw new Error(`P2025 ${m} not found`);
      return table(m).splice(i, 1)[0];
    },
    deleteMany: async ({ where }: Row = {}) => {
      await tick();
      const keep = table(m).filter((r) => !matches(r, where));
      const count = table(m).length - keep.length;
      t[m] = keep;
      return { count };
    },
  });

  const base: Row = {
    withTransaction,
    onCommit: (fn: () => unknown) => {
      const scope = als.getStore();
      if (scope) scope.after.push(fn);
      else void fn();
    },
    $executeRaw: async (_sql: TemplateStringsArray, key: string) => {
      const scope = als.getStore();
      if (!scope || scope.keys.has(key)) return 1;
      scope.keys.add(key);
      const prev = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      scope.releases.push(release);
      locks.set(key, prev.then(() => mine));
      await prev;
      return 1;
    },
    $transaction: (fn: unknown) =>
      typeof fn === 'function' ? withTransaction(() => (fn as (tx: unknown) => Promise<unknown>)(prisma)) : Promise.all(fn as unknown[]),
  };
  const prisma: Row = new Proxy(base, { get: (o, k: string) => (k in o ? o[k] : (o[k] = delegate(k))) });
  return { prisma, t: (m: string) => table(m) };
}

/** Fire `call` twice at once; both settle. */
const twice = <T>(call: () => Promise<T>) => Promise.allSettled([call(), call()]);
const outcomes = (r: PromiseSettledResult<unknown>[]) => r.map((x) => x.status).sort();

const WS = 'ws-1';
const principal = { userId: 'u1', locale: 'en', mode: 'dev' } as never;
const producer = () => ({ enqueue: vi.fn(async () => undefined) });
const activity = { record: vi.fn(async () => undefined) };

describe('one agent run at a time (#815)', () => {
  const registry = { resolve: async () => ({ enabled: true, surfaces: ['background'], name: 'Reviewer' }) };
  const usage = { assertWithinBudget: async () => undefined };

  it('two clicks on Run queue one run and 409 the other', async () => {
    const { prisma, t } = rig();
    const runs = new AgentRunsService(prisma as never, registry as never, usage as never, producer() as never);
    const res = await twice(() => runs.start(WS, 'reviewer', principal));
    expect(outcomes(res)).toEqual(['fulfilled', 'rejected']);
    expect(t('agentRun')).toHaveLength(1);
  });

  it('a schedule tick and a click at once start one run', async () => {
    const { prisma, t } = rig({
      aiAgent: [{ id: 'a1', workspaceId: WS, key: 'reviewer', enabled: true, scheduleEnabled: true, scheduleMinutes: 60, scheduleTime: null, scheduleOwner: 'u1', lastRunAt: null, scheduleNote: null }],
      user: [{ id: 'u1', locale: 'en' }],
    });
    const sweeper = new AgentScheduleSweeper(prisma as never, producer() as never, { get: () => true } as never);
    const runs = new AgentRunsService(prisma as never, registry as never, usage as never, producer() as never);
    await Promise.allSettled([(sweeper as any).startDue(), runs.start(WS, 'reviewer', principal)]);
    expect(t('agentRun')).toHaveLength(1);
  });

  it('two sweepers (two API replicas) on one due schedule start one run', async () => {
    const { prisma, t } = rig({
      aiAgent: [{ id: 'a1', workspaceId: WS, key: 'reviewer', enabled: true, scheduleEnabled: true, scheduleMinutes: 60, scheduleTime: null, scheduleOwner: 'u1', lastRunAt: null, scheduleNote: null }],
      user: [{ id: 'u1', locale: 'en' }],
    });
    const sweeper = () => new AgentScheduleSweeper(prisma as never, producer() as never, { get: () => true } as never);
    await Promise.all([(sweeper() as any).startDue(), (sweeper() as any).startDue()]);
    expect(t('agentRun')).toHaveLength(1);
  });

  it('two drift checks on one spec start one run; the second joins it', async () => {
    const { prisma, t } = rig({
      document: [{ id: 'spec', workspaceId: WS, kind: 'openapi' }],
      connectorLink: [{ documentId: 'spec', externalId: 'openapi.yaml', connector: { id: 'c1', kind: 'markdown-git' } }],
    });
    const drift = new ApiDriftCheckService(prisma as never, { resolve: async () => ({ enabled: true }) } as never, producer() as never);
    const res = await twice(() => drift.start(principal, 'spec'));
    expect(res.map((r) => (r as PromiseFulfilledResult<{ existing: boolean }>).value.existing).sort()).toEqual([false, true]);
    expect(t('agentRun')).toHaveLength(1);
  });

  it('two component drafts of one file queue one run', async () => {
    const { prisma, t } = rig({ project: [{ id: 'p1', workspaceId: WS }] });
    const drafts = new ComponentDraftsService(
      prisma as never,
      { resolve: async () => ({ enabled: true, config: { enabled: true }, missing: [] }) } as never,
      usage as never,
      producer() as never,
      { codeConnectors: async () => [{ id: 'c1', repoUrl: 'https://github.com/acme/app' }] } as never,
      { scopeFor: async () => ({ workspaceId: WS, bypass: true }) } as never,
    );
    const res = await twice(() => drafts.start(principal, { workspaceId: WS, paths: ['src/Popover.vue'], projectId: 'p1' } as never));
    expect(outcomes(res)).toEqual(['fulfilled', 'rejected']);
    expect(t('agentRun')).toHaveLength(1);
  });
});

describe('one live workflow run per (definition, page) (#815)', () => {
  const GRAPH = { steps: [{ id: 's1', kind: 'review', title: 'Review', next: [], fanOut: false, autoApprove: false }] };
  const seed = () => ({
    workflowDefinition: [
      { id: 'def', workspaceId: WS, projectId: null, enabled: true, version: 1, name: 'Flow', graph: GRAPH, createdBy: 'u1', trigger: { autoStart: true, events: ['document.indexed'] } },
    ],
    document: [{ id: 'd1', workspaceId: WS, projectId: 'p1', title: 'Page', category: null }],
    user: [{ id: 'u1', locale: 'en' }],
  });
  const manual = (prisma: unknown) =>
    Object.assign(Object.create(WorkflowsService.prototype), {
      prisma,
      activity,
      producer: producer(),
      compileOrThrow: () => ({ entry: GRAPH.steps }),
      toRunInfo: (run: unknown) => run,
      statsFor: async () => new Map(),
    }) as WorkflowsService;
  const trigger = (prisma: unknown) =>
    new WorkflowTriggerService(prisma as never, { all: () => ({ subscribe: () => undefined }) } as never, activity as never, producer() as never, {
      get: () => undefined,
    } as never);
  const event = { type: 'document.indexed', workspaceId: WS, documentId: 'd1' } as never;

  it('two manual starts make one run and 409 the other', async () => {
    const { prisma, t } = rig(seed());
    const res = await twice(() => manual(prisma).startRun({ workspaceId: WS, definitionId: 'def', rootDocumentId: 'd1' }, 'u1'));
    expect(outcomes(res)).toEqual(['fulfilled', 'rejected']);
    expect(t('workflowRun')).toHaveLength(1);
  });

  it('a burst of events and a manual start make one run', async () => {
    const { prisma, t } = rig(seed());
    const service = trigger(prisma);
    await Promise.allSettled([
      (service as any).handle(event),
      (service as any).handle(event),
      manual(prisma).startRun({ workspaceId: WS, definitionId: 'def', rootDocumentId: 'd1' }, 'u1'),
    ]);
    expect(t('workflowRun')).toHaveLength(1);
  });
});

describe('capture dedupe (#815)', () => {
  it('the same capture twice at once stages one and answers the other as its duplicate', async () => {
    const { prisma, t } = rig();
    const drive = vi.fn(async (id: string) => ({ id }));
    const captures = Object.assign(Object.create(CaptureService.prototype), {
      prisma,
      config: { get: () => 100_000 },
      aiConfig: { captureSettings: async () => ({ enabled: { effective: true } }) },
      permissions: { scopeFor: async () => ({ workspaceId: WS, bypass: true }) },
      stage: async () => ({ projectId: 'p1', kind: 'note', title: 'Retry on 429', payload: { body: 'back off' }, linked: [] }),
      assertProjectAllowed: async () => undefined,
      assertReadable: async () => undefined,
      assertWithinRate: async () => undefined,
      mergeRequestStatuses: async () => new Map(),
      mergeRequestStatus: async () => null,
      toResult: (row: unknown) => row,
      drive,
    }) as CaptureService;
    await twice(() => captures.capture({ workspaceId: WS, session: { client: 'test' } } as never, principal));
    expect(t('knowledgeCapture').map((r) => r.status).sort()).toEqual(['duplicate', 'staged']);
    expect(drive).toHaveBeenCalledTimes(1);
  });
});

describe('one connector run in flight (#815)', () => {
  const connector = { id: 'c1', workspaceId: WS, kind: 'markdown-git', enabled: true, direction: 'both', syncMode: 'auto', locale: 'en' } as never;
  const service = (prisma: unknown) =>
    Object.assign(Object.create(ConnectorsService.prototype), {
      prisma,
      assertKindEnabled: () => undefined,
      adapterFor: () => ({ capabilities: { pull: true, push: true } }),
      webSourcesEnabled: true,
    }) as ConnectorsService;

  it('two Sync clicks queue one run and 409 the other', async () => {
    const { prisma, t } = rig();
    const res = await twice(() => service(prisma).createRun(connector, 'pull', 'manual'));
    expect(outcomes(res)).toEqual(['fulfilled', 'rejected']);
    expect(t('connectorRun')).toHaveLength(1);
  });

  it('two webhooks at once fold into one queued run', async () => {
    const { prisma, t } = rig();
    await Promise.all([service(prisma).queueWebhookRefs(connector, ['a']), service(prisma).queueWebhookRefs(connector, ['b'])]);
    expect(t('connectorRun')).toHaveLength(1);
    expect([...(t('connectorRun')[0].scope as string[])].sort()).toEqual(['a', 'b']);
  });
});

describe('one open merge request per branch pair (#815)', () => {
  const source = { id: 'b-src', name: 'draft', headRevisionId: 'r1', projectBranchId: null };
  const target = { id: 'b-main', name: 'main', headRevisionId: 'r0', projectBranchId: null };
  const service = (prisma: unknown) =>
    Object.assign(Object.create(MergeRequestsService.prototype), {
      prisma,
      getBranchOrThrow: async (_doc: string, name: string) => (name === 'main' ? target : source),
      changedPages: async () => [],
      assertTargetsExist: () => undefined,
      recordActivity: async () => null,
      toDetail: async (mr: unknown) => mr,
    }) as MergeRequestsService;

  it('two creates open one and 409 the other with the alreadyOpen body', async () => {
    const { prisma, t } = rig({ document: [{ id: 'd1', defaultBranch: 'main', archivedAt: null }] });
    const res = await twice(() => service(prisma).create('d1', { sourceBranch: 'draft', title: 'Fix' } as never));
    expect(outcomes(res)).toEqual(['fulfilled', 'rejected']);
    expect((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.getStatus()).toBe(409);
    // openFrom filters by relation, which the rig ignores: count the rows instead.
    expect(t('mergeRequest')).toHaveLength(1);
  });
});

describe('template names (#815)', () => {
  const CUSTOM = '---\ntemplate:\n  category: architecture\n---\n# {{title}}\n';
  it('two creates of one name make one template and 409 the other', async () => {
    const { prisma, t } = rig();
    const templates = new TemplatesService(prisma as never, activity as never, { requireProjectInWorkspace: async () => undefined } as never);
    (templates as any).get = async (id: string) => ({ id });
    const res = await twice(() => templates.create({ workspaceId: WS, name: 'Decision', source: CUSTOM }));
    expect(outcomes(res)).toEqual(['fulfilled', 'rejected']);
    expect(t('pageTemplate')).toHaveLength(1);
  });
});

describe('the last project (#815)', () => {
  it('deleting the last two projects at once keeps one', async () => {
    const { prisma, t } = rig({
      project: [
        { id: 'p1', workspaceId: WS, name: 'One' },
        { id: 'p2', workspaceId: WS, name: 'Two' },
      ],
    });
    const projects = new ProjectsService(prisma as never, activity as never, {} as never, {} as never);
    (projects as any).recordDeletion = async () => undefined;
    await Promise.allSettled([projects.remove('p1'), projects.remove('p2')]);
    expect(t('project')).toHaveLength(1);
  });
});

describe('published site caps (#815)', () => {
  it('two versions at once past SITE_MAX_VERSIONS - 1 make one', async () => {
    const versions = Array.from({ length: SITE_MAX_VERSIONS - 1 }, (_, i) => ({ id: `v${i}`, siteId: 's1', slug: `v${i}`, kind: 'frozen' }));
    const { prisma, t } = rig({ publishedSite: [{ id: 's1', workspaceId: WS, defaultVersionId: null }], siteVersion: versions }, {
      publishedSite: (row, tables) => ({ versions: tables.siteVersion.filter((v) => v.siteId === row.id), domains: [] }),
    });
    const sites = Object.assign(Object.create(SitesService.prototype), {
      prisma,
      activity,
      builds: { enqueue: async () => undefined },
      toVersionSummary: (v: unknown) => v,
    }) as SitesService;
    const res = await Promise.allSettled([
      sites.createVersion('s1', { name: 'A', slug: 'a', kind: 'frozen' } as never),
      sites.createVersion('s1', { name: 'B', slug: 'b', kind: 'frozen' } as never),
    ]);
    expect(outcomes(res)).toEqual(['fulfilled', 'rejected']);
    expect(t('siteVersion')).toHaveLength(SITE_MAX_VERSIONS);
  });

  it('two domains at once past SITE_MAX_DOMAINS - 1 add one', async () => {
    const { SITE_MAX_DOMAINS } = await import('@knowledge/contracts');
    const domains = Array.from({ length: SITE_MAX_DOMAINS - 1 }, (_, i) => ({ id: `d${i}`, siteId: 's1', hostname: `d${i}.example.org`, verifiedAt: null }));
    const { prisma, t } = rig({ publishedSite: [{ id: 's1', workspaceId: WS, slug: 'docs' }], siteDomain: domains }, {
      publishedSite: (row, tables) => ({ domains: tables.siteDomain.filter((d) => d.siteId === row.id) }),
    });
    const service = new SiteDomainsService(prisma as never, activity as never, { get: (k: string) => (k === 'SITES_CUSTOM_DOMAINS' ? true : undefined) } as never);
    Object.assign(service, { requireEnabled: () => undefined, isPlatformHost: () => false, summary: (d: unknown) => d });
    const res = await Promise.allSettled([service.add('s1', 'a.example.org'), service.add('s1', 'b.example.org')]);
    expect(outcomes(res)).toEqual(['fulfilled', 'rejected']);
    expect(t('siteDomain')).toHaveLength(SITE_MAX_DOMAINS);
  });
});

describe('one ticket per anchor (#816)', () => {
  function handoffs() {
    const { prisma, t } = rig({
      projectTrackerRoute: [{ projectId: 'p1', connectorId: 'c1', externalProject: null, issueType: null, boardNodeId: null, boardFieldId: null }],
      connector: [{ id: 'c1', workspaceId: WS, enabled: true, locale: 'en', name: 'GitHub', config: {} }],
    });
    // The tracker call is where the old code raced: both callers were past their "is there one?" read.
    const createIssue = vi.fn(async () => (await tick(), { kind: 'issue', number: createIssue.mock.calls.length, url: 'https://t/1' }));
    const workItems = {
      trackerOf: () => ({ createIssue }),
      upsertFrom: (row: Row, issue: Row, { documentId, anchor }: Row) =>
        prisma.connectorWorkItem.create({ data: { connectorId: row.id, kind: issue.kind, number: issue.number, documentId, sourceKind: anchor.kind, sourceId: anchor.id } }),
    };
    const anchors = { ticketText: async () => ({ title: 'T', body: 'B' }) };
    const svc = new WorkItemHandoffService(prisma as never, {} as never, workItems as never, anchors as never, {} as never, activity as never);
    return { svc, t, createIssue };
  }
  const view = { kind: 'issue', id: 'i1', documentId: 'd1', projectId: 'p1' } as never;

  it('two rule handoffs of one object at once open one ticket', async () => {
    const h = handoffs();
    const res = await Promise.all([h.svc.handoffByRule(view), h.svc.handoffByRule(view)]);
    expect(h.createIssue).toHaveBeenCalledTimes(1);
    expect(h.t('connectorWorkItem')).toHaveLength(1);
    expect(res.filter(Boolean)).toHaveLength(1);
  });
});

describe('one agent run per page at a time (#1248)', () => {
  /**
   * The processor against the rig, with a queue that runs a woken job at once
   * and an executor that holds each run open until the test lets it go, so two
   * runs on one page are provably never `running` together.
   */
  function worker(runs: Row[]) {
    const { prisma, t } = rig({ agentRun: runs.map((r) => ({ workspaceId: WS, status: 'pending', createdBy: 'u1', locale: 'en', attempt: 0, ...r })) });
    let live = 0;
    let peak = 0;
    const gates = new Map<string, () => void>();
    const executor = {
      run: async (row: Row) => {
        peak = Math.max(peak, ++live);
        await new Promise<void>((r) => gates.set(row.id, r));
        live--;
        return { summary: 'done', findings: [] };
      },
    };
    const woken: Promise<void>[] = [];
    const producer = { enqueueWake: async (id: string) => void woken.push(proc.process({ data: { runId: id } } as never)) };
    const proc: AgentProcessor = new AgentProcessor(
      prisma as never,
      { resolve: async () => ({ enabled: true }) } as never,
      executor as never,
      { principalFor: async () => principal, requireRole: async () => undefined } as never,
      { assertWithinBudget: async () => undefined } as never,
      { publish: async () => undefined } as never,
      producer as never,
    );
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await tick();
      expect(cond()).toBe(true);
    };
    return { proc, t, gates, until, peak: () => peak, woken };
  }
  const status = (t: (m: string) => Row[], id: string) => t('agentRun').find((r) => r.id === id)!.status;

  it('sentinel and cartographer on one page run one after the other, and both finish', async () => {
    const w = worker([
      { id: 'a', agentKey: 'sentinel', subjectKey: 'doc:d1', createdAt: new Date(1) },
      { id: 'b', agentKey: 'cartographer', subjectKey: 'doc:d1', createdAt: new Date(2) },
    ]);
    const first = w.proc.process({ data: { runId: 'a' } } as never);
    await w.until(() => w.gates.has('a'));
    // The second job arrives while the first runs: accepted, left pending, not failed.
    await w.proc.process({ data: { runId: 'b' } } as never);
    expect(status(w.t, 'b')).toBe('pending');

    w.gates.get('a')!();
    await first;
    expect(status(w.t, 'a')).toBe('succeeded');
    // Settling the first woke the second.
    await w.until(() => w.gates.has('b'));
    w.gates.get('b')!();
    await Promise.all(w.woken);
    expect(status(w.t, 'b')).toBe('succeeded');
    expect(w.peak()).toBe(1);
  });

  it('two workers claiming two runs on one page at once start one', async () => {
    const w = worker([
      { id: 'a', agentKey: 'sentinel', subjectKey: 'doc:d1' },
      { id: 'b', agentKey: 'scribe', subjectKey: 'doc:d1' },
    ]);
    void w.proc.process({ data: { runId: 'a' } } as never);
    void w.proc.process({ data: { runId: 'b' } } as never);
    await w.until(() => w.gates.size === 1);
    for (let i = 0; i < 20; i++) await tick();
    expect(w.t('agentRun').filter((r) => r.status === 'running')).toHaveLength(1);
  });

  it('runs on different pages, and unscoped runs, still run concurrently', async () => {
    const w = worker([
      { id: 'a', agentKey: 'sentinel', subjectKey: 'doc:d1' },
      { id: 'b', agentKey: 'cartographer', subjectKey: 'doc:d2' },
      { id: 'c', agentKey: 'curator', subjectKey: null },
    ]);
    for (const id of ['a', 'b', 'c']) void w.proc.process({ data: { runId: id } } as never);
    await w.until(() => w.gates.size === 3);
    expect(w.peak()).toBe(3);
  });

  it('a page run and a workspace-wide run of one agent both start manually; a second click on the page 409s', async () => {
    const { prisma, t } = rig();
    const runs = new AgentRunsService(
      prisma as never,
      { resolve: async () => ({ enabled: true, name: 'Reviewer' }), list: async () => [] } as never,
      { assertWithinBudget: async () => undefined } as never,
      producer() as never,
    );
    const page = await runs.start(WS, 'reviewer', principal, { documentIds: ['d1'] });
    expect(page.subjectKey).toBe('doc:d1');
    await expect(runs.start(WS, 'reviewer', principal)).resolves.toMatchObject({ subjectKey: null });
    await expect(runs.start(WS, 'reviewer', principal, { documentIds: ['d1'] })).rejects.toThrow();
    // Another agent on the same page is accepted and reads as queued behind the running one.
    t('agentRun').find((r) => r.id === page.id)!.status = 'running';
    await expect(runs.start(WS, 'curator', principal, { documentIds: ['d1'] })).resolves.toMatchObject({
      status: 'pending',
      queuedBehind: { runId: page.id, agentName: 'reviewer' },
    });
  });

  it('two findings on one page proposed at once open one agent merge request; the other is held', async () => {
    const finding = (title: string) => ({ kind: 'stale', title, detail: 'x', documentIds: ['d1'], documentTitles: ['Page'], draft: { markdown: `# ${title}` } });
    const { prisma, t } = rig({
      agentRun: [{ id: 'r1', workspaceId: WS, agentKey: 'sentinel', createdBy: 'u1', locale: 'en', subjectKey: 'doc:d1', findings: [finding('one'), finding('two')] }],
      document: [{ id: 'd1', workspaceId: WS, title: 'Page' }],
    });
    const mergeRequests = {
      create: async (documentId: string, _dto: unknown, _user: string, opts: Row) => {
        const mr = await prisma.mergeRequest.create({ data: { documentId, provenance: opts.provenance } });
        return { mergeRequest: { mergeRequestId: mr.id } };
      },
    };
    const documents = { getContent: async () => ({ markdown: 'old', frontmatter: {} }), createBranch: async () => undefined, writeRevision: async () => undefined };
    const permissions = { scopeFor: async () => ({}), requireLevel: async () => undefined };
    const findings = new AgentFindingsService(
      prisma as never, documents as never, {} as never, mergeRequests as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never, permissions as never,
    );
    const res = await Promise.allSettled([0, 1].map((i) => findings.propose(WS, 'r1', i, principal)));
    expect(outcomes(res)).toEqual(['fulfilled', 'rejected']);
    expect(t('mergeRequest')).toHaveLength(1);
    const refused = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason.getResponse()).toMatchObject({ reason: 'agent-merge-request-open', mergeRequestId: t('mergeRequest')[0].id });

    // Once that one is merged, the held finding proposes normally.
    t('mergeRequest')[0].status = 'merged';
    await expect(findings.propose(WS, 'r1', res.findIndex((r) => r.status === 'rejected'), principal)).resolves.toBeTruthy();
    expect(t('mergeRequest')).toHaveLength(2);
  });
});
