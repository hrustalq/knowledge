import { normalizeApiPath, type AgentFinding, type AgentRunPullRequest, type ApiDriftMismatch, type ApiDriftSpec } from '@knowledge/contracts';
import type { DeclaredRoute } from '../connectors/adapters/route-extract.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { t } from '../i18n/t.js';
import { pullRequestSources } from './drift.js';

/**
 * Spec ↔ code drift (#78, phase 8): the operations a spec describes against
 * the routes its repository declares (`route-extract.ts`). Pure and Nest-free,
 * so the rules a pull request comment states are the rules a spec asserts.
 *
 * A route and an operation are the same when their method matches and their
 * paths fold to the same shape — `:id`, `{id}` and `<id>` are one parameter,
 * case and trailing slashes do not count. One prefix may separate the two
 * sides wholesale (a `servers[].url` of `/api`, a router mounted under `/v1`
 * that static analysis cannot follow), so the comparison first finds the one
 * leading prefix whose removal from one side matches the most paths, and
 * prefers none on a tie.
 *
 * Three verdicts per path, from the spec's side:
 *
 * - `missing-in-code`: the spec documents methods no route serves;
 * - `missing-in-spec`: the code serves methods no spec documents — judged
 *   against **every** spec of the repository, so a route of a second service
 *   is not missing from the first service's spec;
 * - `method-mismatch`: both, on one path — almost always one operation whose
 *   method changed, so it is one finding rather than two.
 *
 * A spec `HEAD` is served by a route `GET`, and a spec `OPTIONS` is never
 * missing: every framework here answers both on its own.
 */

/** Mismatches one spec keeps; the comment and the finding show fewer. */
export const MAX_DRIFT_MISMATCHES = 50;
/** Mismatches a finding's detail and the judgement prompt list before counting the rest. */
export const MAX_LISTED_MISMATCHES = 8;

export interface SpecOperationRef {
  method: string;
  path: string;
}

export interface SpecUnderCheck {
  documentId: string;
  title: string;
  specPath: string;
  operations: SpecOperationRef[];
}

/** The routes of one repository state, all files together. */
export interface RouteInventory {
  routes: DeclaredRoute[];
  globalPrefixes: string[];
  dynamic: number;
}

/** A path as the comparison sees it: parameters folded to `{}`, case folded, one leading slash, no trailing one. */
export function comparablePath(path: string): string {
  const folded = path
    .trim()
    .replace(/\/:[^/]+/g, '/{}')
    .replace(/<[^>]*>/g, '{}');
  return normalizeApiPath(folded).toLowerCase();
}

/**
 * The repository's routes with NestJS's global prefix applied — only when the
 * repository sets exactly one: two apps with two prefixes cannot be told apart
 * by file, and the alignment below still finds a single uniform one.
 */
export function effectiveRoutes(inventory: RouteInventory): DeclaredRoute[] {
  const prefixes = [...new Set(inventory.globalPrefixes.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean))];
  if (prefixes.length !== 1) return inventory.routes;
  const prefix = `/${prefixes[0]}`;
  return inventory.routes.map((r) => (r.framework === 'nestjs' ? { ...r, path: prefix + (r.path === '/' ? '' : r.path) } : r));
}

/** The leading segment(s) a path could be mounted under: `/v1`, `/api/v1`. */
function leadingPrefixes(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  const out: string[] = [];
  for (let n = 1; n <= Math.min(2, segments.length - 1); n += 1) {
    const head = segments.slice(0, n);
    if (head.some((s) => s.includes('{'))) break;
    out.push(`/${head.join('/')}`);
  }
  return out;
}

function strip(path: string, prefix: string): string {
  if (!prefix) return path;
  if (path === prefix) return '/';
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
}

export interface Alignment {
  /** Which side loses the prefix; null when the paths compare as written. */
  side: 'spec' | 'code' | null;
  prefix: string;
}

/** The one prefix whose removal from one side matches the most distinct paths; none on a tie. */
export function alignPaths(specPaths: readonly string[], codePaths: readonly string[]): Alignment {
  const score = (a: Alignment) => {
    const spec = new Set(specPaths.map((p) => (a.side === 'spec' ? strip(p, a.prefix) : p)));
    let n = 0;
    for (const p of new Set(codePaths.map((c) => (a.side === 'code' ? strip(c, a.prefix) : c)))) if (spec.has(p)) n += 1;
    return n;
  };
  let best: Alignment = { side: null, prefix: '' };
  let bestScore = score(best);
  const candidates = (paths: readonly string[], side: 'spec' | 'code') =>
    [...new Set(paths.flatMap(leadingPrefixes))].sort().map((prefix) => ({ side, prefix }));
  for (const candidate of [...candidates(specPaths, 'spec'), ...candidates(codePaths, 'code')]) {
    const s = score(candidate);
    if (s > bestScore || (s === bestScore && s > 0 && best.side !== null && candidate.prefix.length < best.prefix.length)) {
      best = candidate;
      bestScore = s;
    }
  }
  return best;
}

interface PathRoutes {
  methods: Set<string>;
  first: DeclaredRoute;
}

/**
 * Every spec against one repository state. `supported` false — no route was
 * read at all — compares nothing: an unsupported framework is not a codebase
 * with every operation missing.
 */
export function compareSpecs(specs: readonly SpecUnderCheck[], inventory: RouteInventory, supported: boolean): ApiDriftMismatch[][] {
  if (!supported) return specs.map(() => []);
  const routes = effectiveRoutes(inventory);
  const codePaths = routes.map((r) => comparablePath(r.path));

  const covered = new Set<number>();
  const perSpec: Array<{ mismatches: ApiDriftMismatch[]; matched: number; alignment: Alignment }> = [];
  for (const spec of specs) {
    const specPaths = spec.operations.map((o) => comparablePath(o.path));
    const alignment = alignPaths(specPaths, codePaths);
    const specKey = (p: string) => (alignment.side === 'spec' ? strip(p, alignment.prefix) : p);
    const codeKey = (p: string) => (alignment.side === 'code' ? strip(p, alignment.prefix) : p);

    const byPath = new Map<string, { path: string; methods: Set<string> }>();
    spec.operations.forEach((o, i) => {
      const key = specKey(specPaths[i]);
      const entry = byPath.get(key) ?? { path: o.path, methods: new Set<string>() };
      entry.methods.add(o.method.toUpperCase());
      byPath.set(key, entry);
    });
    const code = new Map<string, PathRoutes>();
    routes.forEach((r, i) => {
      const key = codeKey(codePaths[i]);
      if (!byPath.has(key)) return;
      covered.add(i);
      const entry = code.get(key) ?? { methods: new Set<string>(), first: r };
      entry.methods.add(r.method);
      code.set(key, entry);
    });

    const mismatches: ApiDriftMismatch[] = [];
    for (const [key, op] of byPath) {
      const served = code.get(key);
      if (served?.methods.has('*')) continue;
      const has = (m: string) => !!served?.methods.has(m) || (m === 'HEAD' && !!served?.methods.has('GET'));
      const missingInCode = [...op.methods].filter((m) => m !== 'OPTIONS' && !has(m)).sort();
      const missingInSpec = served ? [...served.methods].filter((m) => !op.methods.has(m)).sort() : [];
      const at = served ? { file: served.first.file, line: served.first.line } : {};
      if (missingInCode.length && missingInSpec.length) {
        mismatches.push({ kind: 'method-mismatch', path: op.path, methods: missingInCode, codeMethods: missingInSpec, ...at });
      } else if (missingInCode.length) {
        mismatches.push({ kind: 'missing-in-code', path: op.path, methods: missingInCode });
      } else if (missingInSpec.length) {
        mismatches.push({ kind: 'missing-in-spec', path: op.path, methods: missingInSpec, ...at });
      }
    }
    perSpec.push({ mismatches, matched: code.size, alignment });
  }

  // A route no spec covers belongs to the spec describing that service: the
  // one sharing the longest leading run of segments with it, then the one that
  // matched the most of the code, then the first.
  if (perSpec.length > 0) {
    const specSegments = specs.map((spec, i) =>
      spec.operations.map((o) => {
        const a = perSpec[i].alignment;
        return (a.side === 'spec' ? strip(comparablePath(o.path), a.prefix) : comparablePath(o.path)).split('/').filter(Boolean);
      }),
    );
    const uncovered = new Map<string, { home: number; entry: PathRoutes }>();
    routes.forEach((r, i) => {
      if (covered.has(i)) return;
      let home = 0;
      let best = -1;
      perSpec.forEach((s, at) => {
        const own = (s.alignment.side === 'code' ? strip(codePaths[i], s.alignment.prefix) : codePaths[i]).split('/').filter(Boolean);
        const shared = Math.max(0, ...specSegments[at].map((segments) => sharedLead(own, segments)));
        if (shared > best || (shared === best && s.matched > perSpec[home].matched)) {
          home = at;
          best = shared;
        }
      });
      const key = `${home} ${codePaths[i]}`;
      const slot = uncovered.get(key) ?? { home, entry: { methods: new Set<string>(), first: r } };
      slot.entry.methods.add(r.method);
      uncovered.set(key, slot);
    });
    for (const { home, entry } of uncovered.values()) {
      perSpec[home].mismatches.push({
        kind: 'missing-in-spec',
        path: entry.first.path,
        methods: [...entry.methods].sort(),
        file: entry.first.file,
        line: entry.first.line,
      });
    }
  }

  return perSpec.map((s) => s.mismatches.sort(byPath));
}

function sharedLead(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

const KIND_ORDER: Record<ApiDriftMismatch['kind'], number> = { 'missing-in-code': 0, 'method-mismatch': 1, 'missing-in-spec': 2 };

function byPath(a: ApiDriftMismatch, b: ApiDriftMismatch): number {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.path.localeCompare(b.path) || a.methods.join().localeCompare(b.methods.join());
}

function identity(m: ApiDriftMismatch): string {
  return [m.kind, comparablePath(m.path), m.methods.join(','), (m.codeMethods ?? []).join(',')].join(' ');
}

/**
 * What a pull request introduces: the mismatches at its head that its base did
 * not already have. Drift that predates the change is the on-demand check's to
 * report, not a reviewer's to be blamed for.
 */
export function introducedMismatches(base: readonly ApiDriftMismatch[], head: readonly ApiDriftMismatch[]): ApiDriftMismatch[] {
  const before = new Set(base.map(identity));
  return head.filter((m) => !before.has(identity(m)));
}

// ---- wording -----------------------------------------------------------------

/** `GET, POST /users/{id}` — the subject of one mismatch, as text. */
function subject(m: ApiDriftMismatch): string {
  const methods = m.methods.map((x) => (x === '*' ? 'ANY' : x)).join(', ');
  return `${methods} ${m.path}`;
}

/** One mismatch as a sentence, in the run's locale. */
export function describeMismatch(m: ApiDriftMismatch): string {
  const where = m.file ? ` (${m.file}${m.line ? `:${m.line}` : ''})` : '';
  switch (m.kind) {
    case 'missing-in-code':
      return t('agent.drift.api.missingInCode', { op: subject(m) });
    case 'missing-in-spec':
      return t('agent.drift.api.missingInSpec', { op: subject(m) }) + where;
    case 'method-mismatch':
      return t('agent.drift.api.methodMismatch', { op: subject(m), code: (m.codeMethods ?? []).join(', ') }) + where;
  }
}

function listed(spec: ApiDriftSpec): string {
  const lines = spec.mismatches.slice(0, MAX_LISTED_MISMATCHES).map(describeMismatch);
  const more = spec.mismatchTotal - lines.length;
  if (more > 0) lines.push(t('agent.drift.api.more', { count: more }));
  return lines.join('; ');
}

/**
 * A spec that disagrees with the code, as a finding no model wrote. On a pull
 * request it names what the change introduces and cites the pull request; on
 * demand it names everything. No draft: the spec is the repository's file,
 * and a page edit here would be overwritten by the next sync.
 */
export function apiDriftFinding(spec: ApiDriftSpec, pr: AgentRunPullRequest | null): AgentFinding | null {
  if (spec.mismatchTotal === 0) return null;
  const broken = spec.mismatches.some((m) => m.kind !== 'missing-in-spec');
  return {
    kind: 'stale',
    severity: broken ? 'error' : 'warning',
    title: t('agent.drift.api.findingTitle', { title: spec.title, count: spec.mismatchTotal }).slice(0, 300),
    detail: (pr
      ? t('agent.drift.api.findingDetailPr', { number: pr.number, list: listed(spec) })
      : t('agent.drift.api.findingDetail', { path: spec.specPath, list: listed(spec) })
    ).slice(0, 2_000),
    documentIds: [spec.documentId],
    documentTitles: [spec.title],
    ...(pr ? pullRequestSources(pr) : {}),
    apiDrift: spec,
  };
}

/**
 * The comparison as context for judging the prose pages a change ties: a page
 * that walks through `DELETE /users/{id}` should hear that the route is gone.
 * Wrapped untrusted — paths and titles come from the repository.
 */
export function apiDriftPromptNote(specs: readonly ApiDriftSpec[]): string {
  const lines = specs
    .filter((s) => s.mismatchTotal > 0 || (s.changes && s.changes.breaking + s.changes.nonBreaking > 0))
    .map((s) => {
      const changes = s.changes ? ` spec changes: ${s.changes.breaking} breaking, ${s.changes.nonBreaking} non-breaking.` : '';
      const mismatches = s.mismatches
        .slice(0, MAX_LISTED_MISMATCHES)
        .map((m) => `${m.kind} ${subject(m)}${m.codeMethods ? ` (code: ${m.codeMethods.join(', ')})` : ''}`)
        .join('; ');
      return `- ${s.title} (${s.specPath}):${changes}${mismatches ? ` ${mismatches}` : ''}`;
    });
  if (lines.length === 0) return '';
  return `\n\nStatic analysis of the API routes against the specs:\n${wrapUntrusted(lines.join('\n'), 'api_drift', 'repo')}`;
}
