import {
  API_CHANGE_RULES,
  normalizeApiPath,
  type ApiChangeRule,
  type ApiSpecChange,
  type ApiSpecDiffSummary,
} from '@knowledge/contracts';
import { isObject, keyOperations, type ParsedApiSpec, type ParsedOperation } from './api-spec.parser.js';

/**
 * The spec diff (#78, phase 6): two parsed revisions in, classified changes
 * out, by the closed `API_CHANGE_RULES` catalogue. Pure and Nest-free — the
 * compare route, the merge-request panel, the merge gate and the MCP tool all
 * read this one function, so they cannot disagree about what breaks.
 *
 * Operations are matched by what a client calls — method and folded path, or
 * channel address and action — never by array position or entity key. A
 * reordered `parameters` list is therefore no change, `/users/{id}` →
 * `/users/{userId}` is the same operation, and a re-pinned slug moves no
 * operation. Parameters match by `in` + name, except path parameters, which
 * match by their position in the path: renaming one changes no request.
 *
 * Schemas are walked side by side with a depth cap and a visited set, since a
 * dereferenced spec is cyclic wherever its schemas recurse.
 */

const MAX_DEPTH = 8;

type Keyed = ParsedOperation & { entityKey: string };
type Obj = Record<string, unknown>;

export function diffApiSpecs(
  before: ParsedApiSpec | null,
  after: ParsedApiSpec,
  slug: string,
): { summary: ApiSpecDiffSummary; changes: ApiSpecChange[] } {
  const out = new Changes();
  const prev = before ? index(keyOperations(before, slug)) : new Map<string, Keyed>();
  const next = index(keyOperations(after, slug));

  // Channels gone entirely are one change per address, not one per action.
  const addresses = (m: Map<string, Keyed>) => new Set([...m.values()].filter((o) => o.protocol === 'async').map((o) => o.path));
  const prevAddresses = addresses(prev);
  const nextAddresses = addresses(next);
  const reportedChannels = new Set<string>();

  for (const [id, old] of prev) {
    if (next.has(id)) continue;
    if (old.protocol === 'async' && !nextAddresses.has(old.path)) {
      if (reportedChannels.has(old.path)) continue;
      reportedChannels.add(old.path);
      out.add('channel-removed', old, null, null, null);
    } else {
      out.add('operation-removed', old, null, opLabel(old), null);
    }
  }
  for (const [id, op] of next) {
    const old = prev.get(id);
    if (!old) {
      if (op.protocol === 'async' && !prevAddresses.has(op.path)) {
        if (reportedChannels.has(op.path)) continue;
        reportedChannels.add(op.path);
        out.add('channel-added', op, null, null, null);
      } else {
        out.add('operation-added', op, null, null, opLabel(op));
      }
      continue;
    }
    if (!old.deprecated && op.deprecated) out.add('operation-deprecated', op, null, null, null);
    if (op.protocol === 'http') {
      diffParameters(out, old, op);
      diffRequestBody(out, old, op);
      diffResponses(out, old, op);
      diffSecurity(out, before!, after, old, op);
    } else {
      diffMessages(out, old, op);
    }
  }
  return out.result();
}

/** What a client calls: `GET /users/{}` or `async user/signedup send`. */
function identity(op: ParsedOperation): string {
  return op.protocol === 'http'
    ? `http ${(op.method ?? 'GET').toUpperCase()} ${normalizeApiPath(op.path).toLowerCase()}`
    : `async ${op.path.trim()} ${op.method ?? ''}`;
}

function index(ops: Keyed[]): Map<string, Keyed> {
  const m = new Map<string, Keyed>();
  for (const op of ops) if (!m.has(identity(op))) m.set(identity(op), op);
  return m;
}

function opLabel(op: ParsedOperation): string {
  return op.protocol === 'http' ? `${op.method ?? 'GET'} ${op.path}` : `${op.method ? `${op.method} ` : ''}${op.path}`;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

interface Param {
  key: string;
  label: string;
  required: boolean;
  schema: Obj | null;
}

/** Path-level parameters overridden by operation-level ones, by `in` + name. */
function parametersOf(op: ParsedOperation): { named: Map<string, Param>; path: Param[] } {
  const merged = new Map<string, Obj>();
  for (const list of [op.parent.parameters, op.raw.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (!isObject(p) || typeof p.name !== 'string' || typeof p.in !== 'string') continue;
      merged.set(`${p.in}:${p.in === 'header' ? p.name.toLowerCase() : p.name}`, p);
    }
  }
  const named = new Map<string, Param>();
  const byName = new Map<string, Param>();
  for (const [key, p] of merged) {
    const param: Param = {
      key,
      label: `${String(p.in)}.${String(p.name)}`,
      required: p.required === true || p.in === 'path',
      schema: isObject(p.schema) ? p.schema : null,
    };
    if (p.in === 'path') byName.set(String(p.name), param);
    else named.set(key, param);
  }
  // Path parameters in the order the path names them.
  const path = [...op.path.matchAll(/\{([^}]*)\}/gu)].map((m) => byName.get(m[1])).filter((p): p is Param => !!p);
  return { named, path };
}

function diffParameters(out: Changes, old: Keyed, op: Keyed): void {
  const a = parametersOf(old);
  const b = parametersOf(op);
  for (const [key, p] of a.named) {
    if (!b.named.has(key)) out.add('param-removed', op, p.label, p.label, null);
  }
  for (const [key, p] of b.named) {
    const q = a.named.get(key);
    if (!q) {
      out.add(p.required ? 'required-param-added' : 'optional-param-added', op, p.label, null, p.label);
      continue;
    }
    if (!q.required && p.required) out.add('param-became-required', op, p.label, 'optional', 'required');
    diffParamSchema(out, op, p.label, q.schema, p.schema);
  }
  b.path.forEach((p, i) => {
    const q = a.path[i];
    if (q) diffParamSchema(out, op, p.label, q.schema, p.schema);
  });
}

function diffParamSchema(out: Changes, op: Keyed, label: string, a: Obj | null, b: Obj | null): void {
  if (!a || !b) return;
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta && tb && ta !== tb) {
    out.add('param-type-changed', op, label, ta, tb);
    return;
  }
  diffEnum(out, op, label, a, b);
}

// ---------------------------------------------------------------------------
// Request body, responses, security
// ---------------------------------------------------------------------------

function diffRequestBody(out: Changes, old: Keyed, op: Keyed): void {
  const a = isObject(old.raw.requestBody) ? old.raw.requestBody : null;
  const b = isObject(op.raw.requestBody) ? op.raw.requestBody : null;
  if (!b) return;
  if (b.required === true && a?.required !== true) {
    out.add('request-body-required', op, 'body', a ? 'optional' : null, 'required');
  }
  const sa = a ? bodySchema(a) : null;
  const sb = bodySchema(b);
  if (sa && sb) diffSchema(out, op, 'request', 'body', sa, sb);
}

function diffResponses(out: Changes, old: Keyed, op: Keyed): void {
  const a = isObject(old.raw.responses) ? old.raw.responses : {};
  const b = isObject(op.raw.responses) ? op.raw.responses : {};
  for (const status of Object.keys(a)) {
    if (!(status in b)) out.add('response-status-removed', op, status, status, null);
  }
  for (const [status, res] of Object.entries(b)) {
    if (!(status in a)) {
      out.add('response-status-added', op, status, null, status);
      continue;
    }
    const sa = isObject(a[status]) ? bodySchema(a[status] as Obj) : null;
    const sb = isObject(res) ? bodySchema(res) : null;
    if (sa && sb) diffSchema(out, op, 'response', `${status} body`, sa, sb);
  }
}

/** The JSON schema of a request body or response: `application/json` first, else the first media type. */
function bodySchema(holder: Obj): Obj | null {
  const content = isObject(holder.content) ? holder.content : null;
  if (!content) return null;
  const types = Object.keys(content);
  const pick = types.find((t) => /json/iu.test(t)) ?? types[0];
  const media = pick ? content[pick] : null;
  return isObject(media) && isObject(media.schema) ? media.schema : null;
}

/**
 * Security as a set of alternatives, each a set of scheme names. An
 * operation with no requirement, or with `{}` among its alternatives, can be
 * called anonymously; losing that, or every old alternative, is breaking.
 */
function diffSecurity(out: Changes, before: ParsedApiSpec, after: ParsedApiSpec, old: Keyed, op: Keyed): void {
  const a = securityOf(old.raw, before.document);
  const b = securityOf(op.raw, after.document);
  const names = (s: string[][]) => new Set(s.flat());
  const anonymous = (s: string[][]) => s.length === 0 || s.some((alt) => alt.length === 0);
  const satisfiable = (alts: string[][], by: string[][]) =>
    alts.some((alt) => by.some((have) => alt.every((n) => have.includes(n))));
  if (anonymous(a) && !anonymous(b)) {
    for (const n of names(b)) out.add('security-requirement-added', op, n, null, n);
  } else if (!anonymous(b) && !satisfiable(b, a)) {
    for (const n of names(b)) if (!names(a).has(n)) out.add('security-requirement-added', op, n, null, n);
  }
  if (!anonymous(a) && anonymous(b)) {
    for (const n of names(a)) out.add('security-requirement-removed', op, n, n, null);
  }
}

function securityOf(raw: Obj, document: Obj): string[][] {
  const list = Array.isArray(raw.security) ? raw.security : Array.isArray(document.security) ? document.security : [];
  return list.filter(isObject).map((alt) => Object.keys(alt).sort());
}

// ---------------------------------------------------------------------------
// AsyncAPI messages
// ---------------------------------------------------------------------------

function diffMessages(out: Changes, old: Keyed, op: Keyed): void {
  const a = payloadOf(old);
  const b = payloadOf(op);
  if (a && b) diffSchema(out, op, 'message', 'payload', a, b);
}

/** The first message payload: 2.x `message` (or its `oneOf`), 3.x `messages`, else the channel's. */
function payloadOf(op: ParsedOperation): Obj | null {
  const candidates: unknown[] = [];
  const push = (m: unknown) => {
    if (Array.isArray(m)) candidates.push(...m);
    else if (isObject(m) && Array.isArray(m.oneOf)) candidates.push(...m.oneOf);
    else if (isObject(m) && !('payload' in m) && !('headers' in m)) candidates.push(...Object.values(m));
    else candidates.push(m);
  };
  push(op.raw.message);
  push(op.raw.messages);
  if (candidates.every((c) => !isObject(c))) push(op.parent.messages);
  for (const c of candidates) if (isObject(c) && isObject(c.payload)) return c.payload;
  return null;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

type Side = 'request' | 'response' | 'message';

function diffSchema(out: Changes, op: Keyed, side: Side, at: string, a: Obj, b: Obj): void {
  const seen = new Map<Obj, Set<Obj>>();
  const walk = (x: Obj, y: Obj, path: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    const pairs = seen.get(x) ?? new Set<Obj>();
    if (pairs.has(y)) return;
    pairs.add(y);
    seen.set(x, pairs);

    const sx = flatten(x);
    const sy = flatten(y);
    const tx = typeOf(sx);
    const ty = typeOf(sy);
    if (tx && ty && tx !== ty) {
      out.add('property-type-changed', op, path, tx, ty);
      return;
    }
    if (side === 'request') diffEnum(out, op, path, sx, sy);

    const px = isObject(sx.properties) ? sx.properties : {};
    const py = isObject(sy.properties) ? sy.properties : {};
    const rx = requiredOf(sx);
    const ry = requiredOf(sy);
    for (const name of Object.keys(px)) {
      if (name in py) continue;
      if (side === 'response') out.add('response-property-removed', op, `${path}.${name}`, name, null);
      else if (side === 'message') out.add('message-payload-field-removed', op, `${path}.${name}`, name, null);
    }
    // This level's changes first, then the shared fields' insides, so a
    // reader meets `body.tree.label` before `body.tree.children[].label`.
    const shared: string[] = [];
    for (const name of Object.keys(py)) {
      const field = `${path}.${name}`;
      if (!(name in px)) {
        if (side === 'request' && ry.has(name)) out.add('request-property-required-added', op, field, null, name);
        else if (side === 'response') out.add('response-property-added', op, field, null, name);
        else if (side === 'message') out.add('message-payload-field-added', op, field, null, name);
        continue;
      }
      if (side === 'request' && ry.has(name) && !rx.has(name)) {
        out.add('request-property-required-added', op, field, 'optional', 'required');
      }
      shared.push(name);
    }
    for (const name of shared) {
      if (isObject(px[name]) && isObject(py[name])) walk(px[name] as Obj, py[name] as Obj, `${path}.${name}`, depth + 1);
    }
    if (isObject(sx.items) && isObject(sy.items)) walk(sx.items, sy.items, `${path}[]`, depth + 1);
  };
  walk(a, b, at, 0);
}

/** `allOf` members folded into one object schema, one level deep. */
function flatten(s: Obj): Obj {
  if (!Array.isArray(s.allOf)) return s;
  const properties: Obj = { ...(isObject(s.properties) ? s.properties : {}) };
  const required = new Set(requiredOf(s));
  let type = s.type;
  for (const part of s.allOf) {
    if (!isObject(part)) continue;
    if (isObject(part.properties)) Object.assign(properties, part.properties);
    for (const r of requiredOf(part)) required.add(r);
    type ??= part.type;
  }
  return { ...s, type: type ?? (Object.keys(properties).length ? 'object' : undefined), properties, required: [...required] };
}

function requiredOf(s: Obj): Set<string> {
  return new Set(Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === 'string') : []);
}

/** The schema's type, with 3.1's `null` member dropped: `['string', 'null']` is a nullable string. */
function typeOf(s: Obj): string | null {
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== 'null') : s.type ? [s.type] : [];
  const named = t.filter((x): x is string => typeof x === 'string').sort();
  if (named.length) return named.join('|');
  if (isObject(s.properties)) return 'object';
  if (isObject(s.items)) return 'array';
  return null;
}

function diffEnum(out: Changes, op: Keyed, label: string, a: Obj, b: Obj): void {
  if (!Array.isArray(a.enum) || !Array.isArray(b.enum)) return;
  const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  const xs = new Set(a.enum.map(show));
  const ys = new Set(b.enum.map(show));
  for (const v of xs) if (!ys.has(v)) out.add('enum-value-removed', op, label, v, null);
  for (const v of ys) if (!xs.has(v)) out.add('enum-value-added', op, label, null, v);
}

// ---------------------------------------------------------------------------

class Changes {
  private readonly list: ApiSpecChange[] = [];

  add(rule: ApiChangeRule, op: Keyed, subject: string | null, before: string | null, after: string | null): void {
    this.list.push({
      rule,
      severity: API_CHANGE_RULES[rule],
      entityKey: op.entityKey,
      protocol: op.protocol,
      method: op.method,
      path: op.path,
      pointer: op.pointer,
      subject,
      before,
      after,
    });
  }

  result(): { summary: ApiSpecDiffSummary; changes: ApiSpecChange[] } {
    const rank = { breaking: 0, 'non-breaking': 1, info: 2 } as const;
    // A stable sort keeps spec order inside each severity.
    const changes = [...this.list].sort((x, y) => rank[x.severity] - rank[y.severity]);
    const count = (s: ApiSpecChange['severity']) => changes.filter((c) => c.severity === s).length;
    return { summary: { breaking: count('breaking'), nonBreaking: count('non-breaking'), info: count('info') }, changes };
  }
}
