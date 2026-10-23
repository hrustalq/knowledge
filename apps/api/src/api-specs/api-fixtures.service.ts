import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { JSON_SCHEMA, load } from 'js-yaml';
import {
  fixtureRunValues,
  isCallStep,
  isTestFixtureKind,
  normalizeEntityKey,
  literalCredentialIssues,
  operationAuth,
  readTestFixture,
  suitePrerequisites,
  testChain,
  testRunPlan,
  apiServerOptions,
  type ApiTestCase,
  type ApiTestFixtureCandidate,
  type ApiTestPrerequisite,
  type ChainResolver,
  type CredentialSlots,
  type FixtureCallInfo,
  type FixtureCallStep,
  type FixtureIssue,
  type FixtureIssueInfo,
  type ListTestFixturesResponse,
  type TestChain,
  type TestChainFixture,
  type TestFixture,
  type TestFixtureResponse,
  type TestRunPlan,
} from '@knowledge/contracts';
import { listedSql } from '../common/listed-page.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { systemScope, visibilitySql, visibilityWhere, type AccessScope } from '../permissions/access-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ApiSpecReadService } from './api-spec-read.service.js';
import type { SuiteBinding, SuiteOperation } from './api-test-suites.service.js';

/** A bound fixture's head, parsed, beside its binding. */
export interface BoundFixture {
  binding: SuiteBinding;
  fixture: TestChainFixture;
}

/** Fixture candidates beyond this many are not offered; the tester ranks at most these. */
const MAX_CANDIDATES = 20;

/** What ingestion indexes for a fixture revision, in place of a markdown body. */
export interface ApiFixtureProjection {
  fixture: TestFixture;
  calls: FixtureCallInfo[];
  markdown: string;
}

/**
 * QA test fixtures (#483) on both sides of the queue, like `ApiSpecsService`
 * for specs: the API refuses an invalid fixture at finalize, the worker
 * projects a valid one. The shape check is `readTestFixture` (contracts); what
 * needs the workspace — does every call name an operation at a spec head the
 * author can open, and does a literal sit in that operation's credential slot —
 * is checked here.
 */
@Injectable()
export class ApiFixturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly reads: ApiSpecReadService,
    private readonly storage: StorageService,
  ) {}

  /**
   * The fixture library: fixtures the scope may open, each with the operations
   * its head calls and which of those no spec head defines any more. Narrowed
   * to the fixtures calling one operation, or any operation of one spec.
   */
  async list(
    scope: AccessScope,
    opts: { projectId?: string; entityKey?: string; entityKeys?: string[]; specDocumentId?: string },
  ): Promise<ListTestFixturesResponse> {
    const head = Prisma.sql`b.head_revision_id`;
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; project_id: string; title: string; head: string | null; updated_at: Date; calls: string[]; broken: string[] }>
    >`
      SELECT d.id, d.project_id, d.title, b.head_revision_id AS head, d.last_activity_at AS updated_at,
             COALESCE((SELECT array_agg(DISTINCT fc.entity_key ORDER BY fc.entity_key) FROM api_fixture_calls fc
                        WHERE fc.revision_id = b.head_revision_id), '{}') AS calls,
             ${brokenCallsSql(head)} AS broken
        FROM documents d
        LEFT JOIN document_branches b ON b.document_id = d.id AND b.name = d.default_branch
       WHERE d.workspace_id = ${scope.workspaceId}::uuid
         AND d.kind = 'test-fixture'
         AND d.archived_at IS NULL
         AND ${listedSql('d')}
         AND ${visibilitySql(scope, 'd')}
         ${opts.projectId ? Prisma.sql`AND d.project_id = ${opts.projectId}::uuid` : Prisma.empty}
         ${
           opts.entityKey
             ? Prisma.sql`AND EXISTS (SELECT 1 FROM api_fixture_calls fc
                 WHERE fc.revision_id = b.head_revision_id AND fc.entity_key = ${normalizeEntityKey(opts.entityKey)})`
             : Prisma.empty
         }
         ${
           opts.entityKeys
             ? Prisma.sql`AND EXISTS (SELECT 1 FROM api_fixture_calls fc
                 WHERE fc.revision_id = b.head_revision_id AND fc.entity_key = ANY(${opts.entityKeys.map((k) => normalizeEntityKey(k))}::text[]))`
             : Prisma.empty
         }
         ${
           opts.specDocumentId
             ? Prisma.sql`AND EXISTS (SELECT 1 FROM api_fixture_calls fc
                 JOIN api_operations o ON o.entity_key = fc.entity_key AND o.workspace_id = d.workspace_id
                 JOIN documents sd ON sd.id = o.document_id
                 JOIN document_branches sb ON sb.document_id = sd.id AND sb.name = sd.default_branch AND sb.head_revision_id = o.revision_id
                 WHERE fc.revision_id = b.head_revision_id AND sd.id = ${opts.specDocumentId}::uuid)`
             : Prisma.empty
         }
       ORDER BY d.title, d.id
       LIMIT 200`;
    return {
      fixtures: rows.map((r) => ({
        documentId: r.id,
        projectId: r.project_id,
        title: r.title,
        headRevisionId: r.head,
        calls: r.calls,
        brokenCalls: r.broken,
        updatedAt: r.updated_at.toISOString(),
      })),
    };
  }

  /**
   * How many fixtures under `scope` call each key at their head — the same
   * predicates as `list`, so a count and the list it opens agree.
   */
  async countCalling(scope: AccessScope, entityKeys: string[]): Promise<Map<string, number>> {
    if (!entityKeys.length) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ entity_key: string; n: number }>>`
      SELECT fc.entity_key, count(DISTINCT d.id)::int AS n
        FROM api_fixture_calls fc
        JOIN documents d ON d.id = fc.document_id
        JOIN document_branches b ON b.document_id = d.id AND b.name = d.default_branch AND b.head_revision_id = fc.revision_id
       WHERE fc.workspace_id = ${scope.workspaceId}::uuid
         AND fc.entity_key = ANY(${entityKeys}::text[])
         AND d.archived_at IS NULL
         AND ${listedSql('d')}
         AND ${visibilitySql(scope, 'd')}
       GROUP BY fc.entity_key`;
    return new Map(rows.map((r) => [r.entity_key, r.n]));
  }

  /** Of these fixtures, the ones whose head calls an operation no spec head defines (`brokenCallsSql`). Unscoped: a fact about the workspace. */
  async withBrokenCalls(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT d.id FROM documents d
        JOIN document_branches b ON b.document_id = d.id AND b.name = d.default_branch
       WHERE d.id = ANY(${ids}::uuid[])
         AND cardinality(${brokenCallsSql(Prisma.sql`b.head_revision_id`)}) > 0`;
    return new Set(rows.map((r) => r.id));
  }

  /** One fixture revision (the head by default), parsed and checked against today's specs under `scope`. */
  async get(scope: AccessScope, documentId: string, revisionId?: string): Promise<TestFixtureResponse> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { branches: { select: { name: true, headRevisionId: true } } },
    });
    if (!doc) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    if (!isTestFixtureKind(doc.kind)) throw new BadRequestException(t('error.testFixture.notFixture', { id: documentId }));
    const id = revisionId ?? doc.branches.find((b) => b.name === doc.defaultBranch)?.headRevisionId;
    const revision = id ? await this.prisma.documentRevision.findUnique({ where: { id } }) : null;
    if (!revision || revision.documentId !== documentId) {
      throw new NotFoundException(t('error.document.noReadableRevision', { id: documentId }));
    }
    if (revision.status === 'draft') throw new BadRequestException(t('error.document.contentIsDraft', { id: revision.id }));
    const { fixture, calls, issues } = await this.check(await this.storage.getObjectText(revision.s3Key), scope);
    return {
      documentId,
      revisionId: revision.id,
      title: doc.title,
      fixture,
      calls,
      runValues: fixture ? fixtureRunValues(fixture) : { inputs: [], secrets: [] },
      issues,
    };
  }

  /**
   * Fixtures that could set up `at`'s suite (#483): the operations of its spec
   * that produce a value it needs (`suitePrerequisites`: links, then path
   * parameters), and the fixtures under `scope` whose head calls one of them,
   * closest evidence first. `hash` names this exact candidate set, so a
   * ranking of an older set is never applied to a newer one.
   */
  async candidates(
    scope: AccessScope,
    at: SuiteOperation,
  ): Promise<{ prerequisites: ApiTestPrerequisite[]; candidates: ApiTestFixtureCandidate[]; hash: string }> {
    const ops = await this.prisma.apiOperation.findMany({ where: { revisionId: at.spec.revisionId }, orderBy: { createdAt: 'asc' } });
    const found = suitePrerequisites(at.spec.document, at.op, ops);
    const opOf = new Map(ops.map((o) => [o.entityKey, o]));
    const prerequisites = found.map((p): ApiTestPrerequisite => {
      const o = opOf.get(p.producer);
      return { ...p, operation: o ? { method: o.method, path: o.path, summary: o.summary } : null };
    });
    const producers = [...new Set(found.map((p) => p.producer))];
    const fixtures = producers.length ? (await this.list(scope, { entityKeys: producers })).fixtures : [];
    const label = (key: string) => {
      const o = opOf.get(key);
      return o ? `${o.method ?? ''} ${o.path}`.trim() : key;
    };
    const candidates = fixtures
      .map((f) => {
        const calls = new Set(f.calls);
        const first = prerequisites.findIndex((p) => calls.has(p.producer));
        const p = prerequisites[first];
        return {
          rank: first,
          candidate: {
            documentId: f.documentId,
            title: f.title,
            headRevisionId: f.headRevisionId,
            source: p.source,
            producers: producers.filter((k) => calls.has(k)),
            reason:
              p.source === 'link'
                ? t('agent.testerRun.reasonLink', { producer: label(p.producer) })
                : t('agent.testerRun.reasonPathParam', { producer: label(p.producer), field: p.field ?? '', param: p.param ?? '' }),
            explanation: null,
            bound: at.bindings.some((b) => b.caseId === null && b.fixtureId === f.documentId),
          } satisfies ApiTestFixtureCandidate,
        };
      })
      .sort((a, b) => a.rank - b.rank)
      .slice(0, MAX_CANDIDATES)
      .map((x) => x.candidate);
    const hash = createHash('sha256')
      .update(JSON.stringify([at.op.entityKey, candidates.map((c) => [c.documentId, c.headRevisionId])]))
      .digest('hex');
    return { prerequisites, candidates, hash };
  }

  /**
   * Each binding's fixture head, parsed. Refuses — never skips — a fixture
   * the scope cannot open (403, no title) or whose head no longer reads: a
   * suite run or exported without one of its fixtures tests something else.
   */
  async bound(scope: AccessScope, bindings: readonly SuiteBinding[]): Promise<BoundFixture[]> {
    const ids = [...new Set(bindings.map((b) => b.fixtureId))];
    const visible = await this.prisma.document.findMany({ where: { id: { in: ids }, ...visibilityWhere(scope) }, select: { id: true } });
    if (visible.length < ids.length) throw new ForbiddenException(t('error.apiTestSuite.fixtureHidden'));
    const parsed = new Map<string, TestFixture>();
    for (const b of bindings) {
      if (parsed.has(b.fixtureId)) continue;
      const revision = b.headRevisionId ? await this.prisma.documentRevision.findUnique({ where: { id: b.headRevisionId } }) : null;
      const { fixture, issues } = revision ? this.read(await this.storage.getObjectText(revision.s3Key)) : { fixture: null, issues: [] };
      if (!fixture) {
        const reason = issues[0] ? withMessage(issues[0]).message : t('error.document.noReadableRevision', { id: b.fixtureId });
        throw new BadRequestException(t('error.apiTestSuite.fixtureInvalid', { title: b.title, reason }));
      }
      parsed.set(b.fixtureId, fixture);
    }
    return bindings.map((b) => ({ binding: b, fixture: { documentId: b.fixtureId, title: b.title, fixture: parsed.get(b.fixtureId)! } }));
  }

  /**
   * One suite as a runnable chain (`testChain`): the bound fixtures under
   * `scope`, each call resolved to its operation at a spec head the scope can
   * open. A call that resolves nowhere refuses the whole chain with a 400.
   */
  async chain(scope: AccessScope, at: SuiteOperation, cases: readonly ApiTestCase[], title: string): Promise<TestChain> {
    return (await this.build(scope, at, cases, title)).chain;
  }

  /**
   * The chain as a run plan (phase 3): each call names the spec revision that
   * defines it, which is where the runner proxies it, and the server its URL
   * starts with.
   */
  async plan(scope: AccessScope, at: SuiteOperation, cases: readonly ApiTestCase[], title: string): Promise<TestRunPlan> {
    const { chain, hits, docs } = await this.build(scope, at, cases, title);
    const server = (doc: Record<string, unknown>) => (apiServerOptions(doc)[0]?.url ?? '').replace(/\/+$/u, '');
    return testRunPlan(chain, { documentId: at.op.documentId, entityKey: at.op.entityKey }, (key) => {
      if (key === null) {
        return { documentId: at.op.documentId, revisionId: at.spec.revisionId, entityKey: at.op.entityKey, server: server(at.spec.document) };
      }
      const h = hits.find((x) => x.entityKey === key)!;
      return { documentId: h.documentId, revisionId: h.revisionId, entityKey: h.entityKey, server: server(docs.get(h.revisionId)!) };
    });
  }

  private async build(scope: AccessScope, at: SuiteOperation, cases: readonly ApiTestCase[], title: string) {
    const fixtures = await this.bound(scope, at.bindings);
    const keys = [...new Set(fixtures.flatMap((f) => stepPaths(f.fixture.fixture).map(([s]) => s.call)))];
    const hits = keys.length ? (await this.reads.search(scope, { entityKeys: keys, limit: 200 })).operations : [];
    const docs = new Map<string, Record<string, unknown>>();
    for (const h of hits) if (!docs.has(h.revisionId)) docs.set(h.revisionId, (await this.reads.spec(h.documentId, h.revisionId)).document);
    for (const f of fixtures) {
      const broken = stepPaths(f.fixture.fixture).find(([s]) => !hits.some((h) => h.entityKey === s.call));
      if (broken) throw new BadRequestException(t('error.apiTestSuite.fixtureBroken', { title: f.binding.title, call: broken[0].call }));
    }
    const resolve: ChainResolver = (key) => {
      const op = hits.find((h) => h.entityKey === key)!;
      return { doc: docs.get(op.revisionId)!, op };
    };
    const perCase: Record<string, TestChainFixture[]> = {};
    for (const f of fixtures) if (f.binding.caseId !== null) (perCase[f.binding.caseId] ??= []).push(f.fixture);
    const chain = testChain({
      title,
      cases,
      suite: fixtures.filter((f) => f.binding.caseId === null).map((f) => f.fixture),
      perCase,
      resolve,
    });
    return { chain, hits, docs };
  }

  /** Parse YAML/JSON and check the shape. No I/O. */
  read(raw: string): { fixture: TestFixture | null; issues: FixtureIssue[] } {
    const max = this.config.get('API_SPEC_MAX_BYTES', { infer: true });
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes > max) return { fixture: null, issues: [{ code: 'too-large', step: null, path: '', params: { bytes, max } }] };
    let value: unknown;
    try {
      value = load(raw, { schema: JSON_SCHEMA });
    } catch (e) {
      const reason = (e as Error).message.split('\n')[0];
      return { fixture: null, issues: [{ code: 'syntax', step: null, path: '', params: { reason } }] };
    }
    return readTestFixture(value);
  }

  /** The shape, then every call against today's spec heads under `scope`. */
  async check(raw: string, scope: AccessScope): Promise<{ fixture: TestFixture | null; calls: FixtureCallInfo[]; issues: FixtureIssueInfo[] }> {
    const { fixture, issues } = this.read(raw);
    if (!fixture) return { fixture, calls: [], issues: issues.map(withMessage) };
    const { calls, slots } = await this.resolve(scope, fixture);
    const found: FixtureIssue[] = [];
    for (const [step, path] of stepPaths(fixture)) {
      const call = calls.find((c) => c.stepId === step.id);
      if (!call?.operation) {
        found.push({ code: 'unknown-operation', step: step.id, path: `${path}.call`, params: { call: step.call } });
      } else {
        found.push(...literalCredentialIssues(step, path, slots.get(step.call) ?? { headers: [], query: [] }));
      }
    }
    return { fixture, calls, issues: found.map(withMessage) };
  }

  /** The finalize check: a 400 naming the first failing step, every issue in `details.issues`. */
  async assertValid(raw: string, scope: AccessScope): Promise<void> {
    const { issues } = await this.check(raw, scope);
    if (issues.length === 0) return;
    const first = issues[0];
    throw new BadRequestException({
      statusCode: 400,
      message: first.step
        ? t('error.testFixture.invalidStep', { step: first.step, reason: first.message })
        : t('error.testFixture.invalid', { reason: first.message }),
      issues,
    });
  }

  /**
   * Parse a revision and replace its `api_fixture_calls` rows; idempotent per
   * revision like every ingestion step. Finalize already checked the calls
   * under the author's scope, so the names here are read workspace-wide.
   */
  async project(input: { workspaceId: string; documentId: string; revisionId: string; title: string; raw: string }): Promise<ApiFixtureProjection> {
    const { fixture, issues } = this.read(input.raw);
    if (!fixture) throw new Error(`Invalid test fixture: ${issues.map((i) => withMessage(i).message).join('; ')}`);
    const { calls } = await this.resolve(systemScope(input.workspaceId), fixture);
    await this.prisma.withTransaction(async () => {
      await this.prisma.apiFixtureCall.deleteMany({ where: { revisionId: input.revisionId } });
      await this.prisma.apiFixtureCall.createMany({
        data: calls.map((c, position) => ({
          workspaceId: input.workspaceId,
          documentId: input.documentId,
          revisionId: input.revisionId,
          stepId: c.stepId,
          phase: c.phase,
          entityKey: c.entityKey,
          position,
        })),
      });
    });
    return { fixture, calls, markdown: renderFixtureProjection(input.title, fixture, calls) };
  }

  /**
   * Each call step's operation at a spec head `scope` may open, and the
   * API-key slots of that operation. One search for every key; one spec read
   * per spec that declares an API key anywhere is all the credential check costs.
   */
  private async resolve(
    scope: AccessScope,
    fixture: TestFixture,
  ): Promise<{ calls: FixtureCallInfo[]; slots: Map<string, CredentialSlots> }> {
    const steps = stepPaths(fixture).map(([s]) => s);
    const keys = [...new Set(steps.map((s) => s.call))];
    const hits = keys.length ? (await this.reads.search(scope, { entityKeys: keys, limit: 200 })).operations : [];
    const byKey = new Map<string, (typeof hits)[number]>();
    for (const h of hits) if (!byKey.has(h.entityKey)) byKey.set(h.entityKey, h);

    const slots = new Map<string, CredentialSlots>();
    const specs = new Map<string, Record<string, unknown> | null>();
    for (const hit of hits) {
      if (!specs.has(hit.revisionId)) {
        specs.set(hit.revisionId, await this.reads.spec(hit.documentId, hit.revisionId).then((s) => s.document, () => null));
      }
      const doc = specs.get(hit.revisionId);
      const slot = slots.get(hit.entityKey) ?? { headers: [], query: [] };
      for (const a of doc ? operationAuth(doc, hit) : []) {
        if (a.kind === 'apiKey' && a.in === 'header' && a.name) slot.headers.push(a.name);
        if (a.kind === 'apiKey' && a.in === 'query' && a.name) slot.query.push(a.name);
      }
      slots.set(hit.entityKey, slot);
    }

    const calls = steps.map((s, i): FixtureCallInfo => {
      const hit = byKey.get(s.call);
      return {
        stepId: s.id,
        phase: i < fixture.steps.filter(isCallStep).length ? 'setup' : 'teardown',
        entityKey: s.call,
        operation: hit
          ? { documentId: hit.documentId, specTitle: hit.specTitle, method: hit.method, path: hit.path, summary: hit.summary }
          : null,
      };
    });
    return { calls, slots };
  }
}

/**
 * The keys a fixture revision calls that no spec head in the workspace defines
 * — the operation was removed, or its spec archived. One predicate, read by
 * the library and by knowledge health's `broken-calls` filter. Workspace-wide
 * rather than scoped: whether an operation still exists is a fact about the
 * workspace, and a scoped answer would call a fixture broken for one reader
 * and sound for the next.
 */
export function brokenCallsSql(headRevision: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`COALESCE((
    SELECT array_agg(DISTINCT fc.entity_key ORDER BY fc.entity_key) FROM api_fixture_calls fc
     WHERE fc.revision_id = ${headRevision}
       AND NOT EXISTS (
         SELECT 1 FROM api_operations o
           JOIN documents sd ON sd.id = o.document_id AND sd.archived_at IS NULL
           JOIN document_branches sb ON sb.document_id = sd.id AND sb.name = sd.default_branch AND sb.head_revision_id = o.revision_id
          WHERE o.workspace_id = fc.workspace_id AND o.entity_key = fc.entity_key)), '{}')`;
}

/** Every call step with its path in the body, setup then teardown. */
function stepPaths(f: TestFixture): Array<[FixtureCallStep, string]> {
  const out: Array<[FixtureCallStep, string]> = [];
  f.steps.forEach((s, i) => {
    if (isCallStep(s)) out.push([s, `steps[${i}]`]);
  });
  f.teardown.forEach((s, i) => out.push([s, `teardown[${i}]`]));
  return out;
}

function withMessage(issue: FixtureIssue): FixtureIssueInfo {
  return { ...issue, message: t(`error.testFixture.issue.${issue.code}`, { path: issue.path, ...issue.params }) };
}

const inline = (s: string) => s.replace(/\s+/gu, ' ').trim();

/**
 * The fixture as markdown, so search finds it by what it sets up: each step
 * as a heading with its operation, expected status and captures, the request
 * as a fenced block. Placeholders are printed as written — never a value.
 */
export function renderFixtureProjection(title: string, f: TestFixture, calls: FixtureCallInfo[]): string {
  const out: string[] = [`# ${inline(title)}`, '', 'Test fixture', ''];
  if (f.description) out.push(f.description, '');
  const inputs = Object.entries(f.inputs);
  if (inputs.length) {
    out.push('## Inputs', '', ...inputs.map(([k, v]) => `- \`${k}\`${v === null ? '' : ` — default \`${String(v)}\``}`), '');
  }
  const callOf = (id: string) => calls.find((c) => c.stepId === id);
  const step = (s: TestFixture['steps'][number], n: number): string[] => {
    if (!isCallStep(s)) return [`### ${n}. ${s.id} (manual)`, '', s.manual, ''];
    const op = callOf(s.id)?.operation;
    const lines = [`### ${n}. ${s.id} — ${op ? `${op.method ?? ''} ${op.path}`.trim() : s.call}`, ''];
    lines.push(`Calls \`${s.call}\`${op ? ` in ${inline(op.specTitle)}` : ''}${s.expect ? `, expects ${s.expect}` : ''}.`, '');
    const captures = Object.entries(s.capture);
    if (captures.length) lines.push(...captures.map(([k, r]) => `- Captures \`${k}\` from \`${r}\``), '');
    if (Object.keys(s.request).length) lines.push('```json', JSON.stringify(s.request, null, 2), '```', '');
    return lines;
  };
  out.push('## Setup', '', ...f.steps.flatMap((s, i) => step(s, i + 1)));
  if (f.teardown.length) out.push('## Teardown', '', ...f.teardown.flatMap((s, i) => step(s, i + 1)));
  return out.join('\n').replace(/\n{3,}/gu, '\n\n').trim() + '\n';
}
