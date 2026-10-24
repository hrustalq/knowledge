import {
  derefSpec,
  exampleForSchema,
  isJsonType,
  operationAuth,
  parametersOf,
  resolveSpecPointer,
  sampleRequestFor,
  type SampleInputs,
  type SampleRequest,
  type SampleText,
} from '@knowledge/contracts/api/samples';

// ---------------------------------------------------------------------------
// QA test suites for one HTTP operation (#468).
//
// Coverage is derived from the spec, never left to the model: `testCasesFor`
// lists every case an operation requires, and `testCaseRequest` builds each
// case's request from the same `SampleRequest` model the code samples print,
// so a sample and a case cannot disagree. The `tester` agent only fills
// realistic values and names; a value that breaks the schema is dropped for
// the spec's own example rather than trusted.
//
// Bump TEST_CASE_CATALOGUE_VERSION whenever the case list or a case's request
// changes shape: it is part of the cache key, so every stored suite built by
// the older catalogue is regenerated rather than served.
//
// A suite with bound fixtures (#483) may use what their setup captures: a
// value that is exactly `{{invoiceId}}` stands for that capture wherever a
// literal would have to fit the schema, and a placeholder naming anything
// else is dropped like any other value that does not fit.
// ---------------------------------------------------------------------------

/** 2: case requests may carry `{{var}}` captures of bound fixtures (#483). */
export const TEST_CASE_CATALOGUE_VERSION = 2;

/** What bound fixtures capture, for the whole suite and per case id. */
export interface TestSuiteVariables {
  suite: readonly string[];
  cases?: Readonly<Record<string, readonly string[]>>;
}

const NO_VARS: ReadonlySet<string> = new Set();

/** Is `v` exactly one placeholder naming a known capture? */
const isVarRef = (v: unknown, vars: ReadonlySet<string>): boolean => {
  if (typeof v !== 'string' || !vars.size) return false;
  const m = /^\{\{\s*([^{}]*?)\s*\}\}$/u.exec(v);
  return !!m && vars.has(m[1]);
};

/**
 * Does every placeholder in `v` name a known capture? `{{input.x}}` and
 * `{{secret.x}}` belong to fixtures, never to a case. Matched here rather than
 * through `…/api/fixtures`, whose import of `…/api` would close a cycle.
 */
const onlyKnownVars = (v: unknown, vars: ReadonlySet<string>): boolean =>
  [...(JSON.stringify(v) ?? '').matchAll(/\{\{\s*([^{}]*?)\s*\}\}/gu)].every((m) => vars.has(m[1]));

/** The rules a case covers. Closed: `testCasesFor` emits exactly these and the web labels them. */
export const API_TEST_RULES = [
  'success',
  'missing-required',
  'wrong-type',
  'enum-outside',
  'minimum',
  'maximum',
  'min-length',
  'max-length',
  'pattern',
  'missing-credentials',
  'documented-error',
] as const;
export type ApiTestRule = (typeof API_TEST_RULES)[number];
export type ApiTestCaseKind = 'positive' | 'negative';
export type ApiTestLocation = 'path' | 'query' | 'header' | 'body';

/** What a case changes in the baseline request. A `body` path of `[]` is the whole body. */
export type ApiTestMutation =
  | { op: 'none' }
  | { op: 'omit'; in: ApiTestLocation; path: string[] }
  | {
      op: 'set';
      in: ApiTestLocation;
      path: string[];
      /** Absent when the value is filled at build time: the model's, if it matches `matching`. */
      value?: unknown;
      /** A pattern the filled value must match. */
      matching?: string;
    }
  | { op: 'no-credentials' };

export interface ApiTestCaseSpec {
  /** Stable within a catalogue version: `missing-required:body.amount`, `max-length:above:query.q`. */
  id: string;
  kind: ApiTestCaseKind;
  rule: ApiTestRule;
  /** `query.expand`, `body.address.city`; null for the request as a whole. */
  target: string | null;
  mutation: ApiTestMutation;
  /** A documented status (`201`, `404`), or a range (`4XX`) when the spec documents none that fits. */
  expectedStatus: string;
}

/** One stored case: the spec's case, the model's words, and the request as built. */
export interface ApiTestCase {
  id: string;
  kind: ApiTestCaseKind;
  rule: ApiTestRule;
  target: string | null;
  name: string;
  description: string;
  request: SampleRequest;
  expected: {
    status: string;
    /** The spec's description of that response. */
    description: string | null;
    /** What the model says a tester should check, beyond the status. */
    expectation: string | null;
    /** The spec's example (or one built from its schema) of that response's body. */
    example: unknown;
  };
}

/** What the model may say about one case. Everything is optional; a missing case is completed, never dropped. */
export interface ApiTestCaseFill {
  name?: unknown;
  description?: unknown;
  expectation?: unknown;
  /** A value for a `pattern` positive case. */
  value?: unknown;
  /** `documented-error` only: path and query values that provoke that status (an id that does not exist). */
  path?: unknown;
  query?: unknown;
}

type Json = Record<string, unknown>;
type Op = { method: string | null; path: string; pointer: string; protocol?: string };

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isSuccess = (s: string) => /^2(\d\d|XX)$/iu.test(s);
const isError = (s: string) => /^[45](\d\d|XX)$/iu.test(s);
/** Deeper than this, a body's fields are not walked. Each level multiplies the suite. */
const MAX_FIELD_DEPTH = 3;
/** ponytail: maxLength boundaries above this are skipped (the case would be a 4 KB string); lift when QA asks for them. */
const MAX_LENGTH_CASE = 4096;
/** Candidates for a value a `pattern` refuses, tried in order. */
const PATTERN_MISSES = ['', ' ', '!', '0', 'a', '~not-matching~'];
const NOT_IN_ENUM = '__not_in_enum__';

function pickStatus(documented: string[], prefer: string[], fallback: string): string {
  return prefer.find((s) => documented.some((d) => d.toUpperCase() === s)) ?? fallback;
}

function typeOf(node: Json): string | undefined {
  const t = Array.isArray(node.type) ? node.type.find((x) => x !== 'null') : node.type;
  if (typeof t === 'string') return t;
  return isObj(node.properties) ? 'object' : undefined;
}

/** A schema with `$ref` followed and `allOf` merged into one set of properties and required names. */
function flatten(doc: Json, schema: unknown): Json | null {
  const { node, cycle } = derefSpec(doc, schema);
  if (cycle || !isObj(node)) return null;
  if (!Array.isArray(node.allOf)) return node;
  const properties: Json = { ...(isObj(node.properties) ? node.properties : {}) };
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  let type = node.type;
  for (const part of node.allOf) {
    const p = flatten(doc, part);
    if (!p) continue;
    Object.assign(properties, isObj(p.properties) ? p.properties : {});
    for (const r of Array.isArray(p.required) ? p.required : []) required.add(r);
    type ??= p.type;
  }
  return { ...node, type: type ?? 'object', properties, required: [...required] };
}

function compile(pattern: unknown): RegExp | null {
  if (typeof pattern !== 'string') return null;
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return null;
  }
}

function wrongTypeValue(type: string | undefined, wire: boolean): unknown {
  // On the wire a path, query or header value is text, so only a non-string type can be broken there.
  if (type === 'integer' || type === 'number') return 'not-a-number';
  if (type === 'boolean') return 'not-a-boolean';
  if (wire) return undefined;
  if (type === 'string') return 12345;
  if (type === 'array') return 'not-an-array';
  if (type === 'object') return 'not-an-object';
  return undefined;
}

function outsideEnum(values: unknown[]): unknown {
  if (values.every((v) => typeof v === 'number')) return Math.max(...(values as number[])) + 1;
  let v = NOT_IN_ENUM;
  while (values.includes(v)) v += '_';
  return v;
}

/** The JSON request body's schema, or null for no body or a non-JSON one (form fields are not walked). */
function jsonBody(doc: Json, op: Json): { required: boolean; schema: unknown } | null {
  const body = derefSpec(doc, op.requestBody).node;
  if (!isObj(body) || !isObj(body.content)) return null;
  const type = Object.keys(body.content).find(isJsonType);
  if (!type) return null;
  const media = body.content[type];
  return { required: body.required === true, schema: isObj(media) ? media.schema : undefined };
}

/**
 * Every case one operation requires, in a stable order: a positive case per
 * documented 2xx, a negative case per required parameter or body field left
 * out, per type violation, per enum value outside the set, both sides of every
 * `minimum`/`maximum`/`minLength`/`maxLength`/`pattern`, missing credentials
 * when the operation is secured, and one per documented 4xx/5xx. Empty for an
 * AsyncAPI operation — there is no HTTP request to test.
 */
export function testCasesFor(doc: Json, op: Op): ApiTestCaseSpec[] {
  if (op.protocol === 'async' || !op.method) return [];
  const raw = derefSpec(doc, resolveSpecPointer(doc, op.pointer)).node;
  if (!isObj(raw)) return [];
  const statuses = Object.keys(isObj(raw.responses) ? raw.responses : {});
  const success = statuses.find(isSuccess) ?? '2XX';
  const invalid = pickStatus(statuses, ['400', '422', '4XX'], '4XX');
  const cases: ApiTestCaseSpec[] = [];
  const add = (c: Omit<ApiTestCaseSpec, 'id'>, side?: string) =>
    cases.push({ id: [c.rule, side, c.target ?? (c.rule === 'missing-credentials' ? null : c.expectedStatus)].filter(Boolean).join(':'), ...c });

  for (const s of statuses.filter(isSuccess)) {
    add({ kind: 'positive', rule: 'success', target: null, mutation: { op: 'none' }, expectedStatus: s });
  }

  const field = (schema: unknown, loc: ApiTestLocation, path: string[], depth: number) => {
    const node = flatten(doc, schema);
    if (!node || depth > MAX_FIELD_DEPTH) return;
    const target = [loc, ...path].join('.');
    const type = typeOf(node);
    const set = (value: unknown, matching?: string): ApiTestMutation => ({ op: 'set', in: loc, path, value, ...(matching ? { matching } : {}) });
    const neg = (rule: ApiTestRule, value: unknown, side?: string) =>
      add({ kind: 'negative', rule, target, mutation: set(value), expectedStatus: invalid }, side);
    const pos = (rule: ApiTestRule, side: string, mutation: ApiTestMutation) =>
      add({ kind: 'positive', rule, target, mutation, expectedStatus: success }, side);

    const wrong = wrongTypeValue(type, loc !== 'body');
    if (wrong !== undefined) neg('wrong-type', wrong);
    if (Array.isArray(node.enum) && node.enum.length) neg('enum-outside', outsideEnum(node.enum));
    if (type === 'integer' || type === 'number') {
      if (typeof node.minimum === 'number') {
        pos('minimum', 'at', set(node.minimum));
        neg('minimum', node.minimum - 1, 'below');
      }
      if (typeof node.exclusiveMinimum === 'number') {
        pos('minimum', 'inside', set(node.exclusiveMinimum + 1));
        neg('minimum', node.exclusiveMinimum, 'at');
      }
      if (typeof node.maximum === 'number') {
        pos('maximum', 'at', set(node.maximum));
        neg('maximum', node.maximum + 1, 'above');
      }
      if (typeof node.exclusiveMaximum === 'number') {
        pos('maximum', 'inside', set(node.exclusiveMaximum - 1));
        neg('maximum', node.exclusiveMaximum, 'at');
      }
    }
    if (type === 'string' || type === undefined) {
      if (typeof node.minLength === 'number' && node.minLength >= 1) {
        pos('min-length', 'at', set('x'.repeat(node.minLength)));
        neg('min-length', 'x'.repeat(node.minLength - 1), 'below');
      }
      if (typeof node.maxLength === 'number' && node.maxLength < MAX_LENGTH_CASE) {
        pos('max-length', 'at', set('x'.repeat(node.maxLength)));
        neg('max-length', 'x'.repeat(node.maxLength + 1), 'above');
      }
      const re = compile(node.pattern);
      if (re) {
        const example = exampleForSchema(doc, node);
        const fits = typeof example === 'string' && re.test(example);
        pos('pattern', 'match', fits ? set(example) : { op: 'set', in: loc, path, matching: node.pattern as string });
        const miss = PATTERN_MISSES.find((v) => !re.test(v));
        if (miss !== undefined) neg('pattern', miss, 'mismatch');
      }
    }
    // Arrays are not walked into: a case per item field would need an item in every baseline.
    if (loc === 'body' && type === 'object' && isObj(node.properties)) {
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      for (const [name, prop] of Object.entries(node.properties)) {
        const p = derefSpec(doc, prop).node;
        if (isObj(p) && p.readOnly === true) continue;
        const sub = [...path, name];
        if (required.has(name)) {
          add({ kind: 'negative', rule: 'missing-required', target: ['body', ...sub].join('.'), mutation: { op: 'omit', in: 'body', path: sub }, expectedStatus: invalid });
        }
        field(prop, 'body', sub, depth + 1);
      }
    }
  };

  const pathItem = resolveSpecPointer(doc, op.pointer.slice(0, op.pointer.lastIndexOf('/')));
  for (const p of parametersOf(doc, raw, pathItem)) {
    // Samples send no cookie parameters, and a path left out is another route, not a missing value.
    if (p.in !== 'path' && p.in !== 'query' && p.in !== 'header') continue;
    if (p.required && p.in !== 'path') {
      add({ kind: 'negative', rule: 'missing-required', target: `${p.in}.${p.name}`, mutation: { op: 'omit', in: p.in, path: [p.name] }, expectedStatus: invalid });
    }
    field(p.schema, p.in, [p.name], 1);
  }

  const body = jsonBody(doc, raw);
  if (body) {
    if (body.required) {
      add({ kind: 'negative', rule: 'missing-required', target: 'body', mutation: { op: 'omit', in: 'body', path: [] }, expectedStatus: invalid });
    }
    field(body.schema, 'body', [], 1);
  }

  if (operationAuth(doc, op).length) {
    add({ kind: 'negative', rule: 'missing-credentials', target: null, mutation: { op: 'no-credentials' }, expectedStatus: pickStatus(statuses, ['401', '403', '4XX'], '401') });
  }

  for (const s of statuses.filter(isError)) {
    add({ kind: 'negative', rule: 'documented-error', target: null, mutation: { op: 'none' }, expectedStatus: s });
  }
  return cases;
}

// ---------------------------------------------------------------------------
// The baseline: the model's realistic values, kept only where they fit
// ---------------------------------------------------------------------------

/**
 * Does `value` satisfy the rules `testCasesFor` covers? Wire values (`path`,
 * `query`, `header`) arrive as text. A placeholder for a capture in `vars`
 * fits anywhere: its value is the server's, not ours to check.
 */
export function conformsToSchema(doc: Json, schema: unknown, value: unknown, wire = false, depth = 0, vars = NO_VARS): boolean {
  if (isVarRef(value, vars)) return true;
  const node = flatten(doc, schema);
  if (!node || depth > MAX_FIELD_DEPTH) return true;
  const type = typeOf(node);
  let v = value;
  if (wire && typeof v === 'string' && (type === 'integer' || type === 'number')) v = v.trim() === '' ? NaN : Number(v);
  if (wire && typeof v === 'string' && type === 'boolean') v = v === 'true' ? true : v === 'false' ? false : v;
  if (Array.isArray(node.enum) && node.enum.length && !node.enum.some((e) => e === v || (wire && String(e) === value))) return false;
  switch (type) {
    case 'integer':
    case 'number':
      if (typeof v !== 'number' || Number.isNaN(v) || (type === 'integer' && !Number.isInteger(v))) return false;
      if (typeof node.minimum === 'number' && v < node.minimum) return false;
      if (typeof node.maximum === 'number' && v > node.maximum) return false;
      if (typeof node.exclusiveMinimum === 'number' && v <= node.exclusiveMinimum) return false;
      if (typeof node.exclusiveMaximum === 'number' && v >= node.exclusiveMaximum) return false;
      return true;
    case 'boolean':
      return typeof v === 'boolean';
    case 'string': {
      if (typeof v !== 'string') return false;
      if (typeof node.minLength === 'number' && v.length < node.minLength) return false;
      if (typeof node.maxLength === 'number' && v.length > node.maxLength) return false;
      const re = compile(node.pattern);
      return !re || re.test(v);
    }
    case 'array':
      return Array.isArray(v);
    case 'object': {
      if (!isObj(v)) return false;
      const props = isObj(node.properties) ? node.properties : {};
      for (const name of Array.isArray(node.required) ? node.required : []) {
        if (typeof name !== 'string' || v[name] !== undefined) continue;
        const prop = derefSpec(doc, props[name]).node;
        if (!(isObj(prop) && prop.readOnly === true)) return false;
      }
      return Object.entries(v).every(([k, x]) => props[k] === undefined || conformsToSchema(doc, props[k], x, false, depth + 1, vars));
    }
    default:
      return true;
  }
}

const asStrings = (v: unknown): Record<string, string> =>
  isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => ['string', 'number', 'boolean'].includes(typeof x)).map(([k, x]) => [k, String(x)])) : {};

/**
 * The inputs every case starts from: the model's values for parameters and
 * body where they satisfy the schema, the spec's examples everywhere else.
 */
export function testBaseline(doc: Json, op: Op, proposed: unknown, vars = NO_VARS): SampleInputs {
  const raw = derefSpec(doc, resolveSpecPointer(doc, op.pointer)).node;
  if (!isObj(raw)) return {};
  const p = isObj(proposed) ? proposed : {};
  const pathItem = resolveSpecPointer(doc, op.pointer.slice(0, op.pointer.lastIndexOf('/')));
  const params = parametersOf(doc, raw, pathItem);
  const pick = (loc: 'path' | 'query' | 'header', given: unknown) =>
    Object.fromEntries(
      Object.entries(asStrings(given)).filter(([name, value]) => {
        const def = params.find((x) => x.in === loc && x.name.toLowerCase() === name.toLowerCase());
        return def && onlyKnownVars(value, vars) && conformsToSchema(doc, def.schema, value, true, 0, vars);
      }),
    );
  const body = jsonBody(doc, raw);
  const json =
    body && p.body !== undefined && onlyKnownVars(p.body, vars) && conformsToSchema(doc, body.schema, p.body, false, 0, vars)
      ? JSON.stringify(p.body, null, 2)
      : undefined;
  return {
    path: pick('path', p.path),
    query: pick('query', p.query),
    headers: pick('header', p.headers),
    ...(json !== undefined ? { body: json } : {}),
  };
}

// ---------------------------------------------------------------------------
// Building one case's request
// ---------------------------------------------------------------------------

function setIn(target: unknown, path: string[], value: unknown, omit: boolean): unknown {
  if (path.length === 0) return omit ? undefined : value;
  const copy: Json = isObj(target) ? { ...target } : {};
  const [head, ...rest] = path;
  if (rest.length === 0) {
    if (omit) delete copy[head];
    else copy[head] = value;
  } else {
    copy[head] = setIn(copy[head], rest, value, omit);
  }
  return copy;
}

const scalarText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * One case's request: the baseline with the case's mutation applied. Throws
 * when a case needs a value nobody supplied that fits — a suite is refused
 * rather than stored with a case that does not test what it says.
 */
export function testCaseRequest(
  doc: Json,
  op: Op,
  c: ApiTestCaseSpec,
  baseline: SampleInputs,
  fill: ApiTestCaseFill = {},
  vars = NO_VARS,
): SampleRequest {
  const inputs: SampleInputs = { ...baseline, path: { ...baseline.path }, query: { ...baseline.query }, headers: { ...baseline.headers } };
  if (c.rule === 'documented-error') {
    const known = (given: unknown) => Object.fromEntries(Object.entries(asStrings(given)).filter(([, v]) => onlyKnownVars(v, vars)));
    Object.assign(inputs.path!, known(fill.path));
    Object.assign(inputs.query!, known(fill.query));
  }
  const m = c.mutation;
  if (m.op === 'set' || m.op === 'omit') {
    let value: unknown = m.op === 'set' ? m.value : undefined;
    if (m.op === 'set' && m.matching !== undefined) {
      const re = compile(m.matching);
      if (!(typeof fill.value === 'string' && re?.test(fill.value))) {
        throw new Error(`No value matching ${m.matching} for ${c.target}`);
      }
      value = fill.value;
    }
    if (m.in === 'body') {
      const base = sampleRequestFor(doc, op, inputs)?.body?.json;
      const next = setIn(base, m.path, value, m.op === 'omit');
      inputs.body = next === undefined ? null : JSON.stringify(next, null, 2);
    } else if (m.op === 'set') {
      const bag = m.in === 'path' ? inputs.path! : m.in === 'query' ? inputs.query! : inputs.headers!;
      bag[m.path[0]] = scalarText(value);
    }
  }
  const req = sampleRequestFor(doc, op, inputs);
  if (!req) throw new Error(`No HTTP request for ${op.method} ${op.path}`);
  const named = (name: string) => (x: { name: string }) => x.name.toLowerCase() !== name.toLowerCase();
  if (m.op === 'omit' && m.in === 'query') return { ...req, query: req.query.filter(named(m.path[0])) };
  if (m.op === 'omit' && m.in === 'header') return { ...req, headers: req.headers.filter(named(m.path[0])) };
  if (m.op === 'omit' && m.in === 'body' && m.path.length === 0) {
    return { ...req, body: null, headers: req.headers.filter(named('Content-Type')) };
  }
  if (m.op === 'no-credentials') {
    // Only credential placeholders read an environment variable.
    const plain = (x: { value: SampleText }) => x.value.every((p) => typeof p === 'string');
    return { ...req, query: req.query.filter(plain), headers: req.headers.filter(plain) };
  }
  return req;
}

function expectedFor(doc: Json, op: Op, status: string): { description: string | null; example: unknown } {
  const raw = derefSpec(doc, resolveSpecPointer(doc, op.pointer)).node;
  const responses = isObj(raw) && isObj(raw.responses) ? raw.responses : {};
  const key = Object.keys(responses).find((k) => k.toUpperCase() === status.toUpperCase());
  const res = key ? derefSpec(doc, responses[key]).node : null;
  if (!isObj(res)) return { description: null, example: null };
  const content = isObj(res.content) ? res.content : {};
  const type = Object.keys(content).find(isJsonType) ?? Object.keys(content)[0];
  const media = type && isObj(content[type]) ? (content[type] as Json) : null;
  const example = media
    ? (media.example ?? (isObj(media.examples) ? (Object.values(media.examples).find(isObj) as Json | undefined)?.value : undefined) ?? exampleForSchema(doc, media.schema))
    : null;
  return { description: typeof res.description === 'string' ? res.description : null, example: example ?? null };
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** The default name of a case the model did not name. */
function defaultName(c: ApiTestCaseSpec): string {
  return c.target ? `${c.rule} ${c.id.split(':').slice(1, -1).join(' ')} ${c.target}`.replace(/\s+/gu, ' ') : `${c.rule} ${c.expectedStatus}`;
}

/**
 * The whole suite: every listed case, named by the model where it named it
 * and by the catalogue where it did not, with its request built from the
 * baseline. `fills` is keyed by case id; ids the catalogue does not list are
 * ignored. `vars` are the bound fixtures' captures: the baseline may use the
 * suite's, a documented-error case its own as well.
 */
export function buildTestSuite(
  doc: Json,
  op: Op,
  proposedBaseline: unknown,
  fills: Record<string, ApiTestCaseFill> = {},
  vars: TestSuiteVariables = { suite: [] },
): ApiTestCase[] {
  const suiteVars = new Set(vars.suite);
  const baseline = testBaseline(doc, op, proposedBaseline, suiteVars);
  return testCasesFor(doc, op).map((c) => {
    const fill = isObj(fills[c.id]) ? fills[c.id] : {};
    const caseVars = new Set([...suiteVars, ...(vars.cases?.[c.id] ?? [])]);
    const spec = expectedFor(doc, op, c.expectedStatus);
    return {
      id: c.id,
      kind: c.kind,
      rule: c.rule,
      target: c.target,
      name: text(fill.name, 200) ?? defaultName(c),
      description: text(fill.description, 1_000) ?? '',
      request: testCaseRequest(doc, op, c, baseline, fill, caseVars),
      expected: { status: c.expectedStatus, description: spec.description, expectation: text(fill.expectation, 1_000), example: spec.example },
    };
  });
}

// ---------------------------------------------------------------------------
// Prerequisites (#483): which operations of the same spec produce a value
// this one needs, so the fixtures calling them can be offered as setup.
// ---------------------------------------------------------------------------

export type SuitePrerequisiteSource = 'link' | 'path-param';

export interface SuitePrerequisite {
  source: SuitePrerequisiteSource;
  /** The producing operation's entity key. */
  producer: string;
  /** The path parameter it fills, when the spec says which. */
  param: string | null;
  /** The producer's response field that carries the value: `id`, `data.id`. */
  field: string | null;
}

type OpRow = Op & { entityKey: string; operationId?: string | null };

/** `/invoices/{id}/` → `/invoices/{}`. Not `normalizeApiPath`: importing `…/api` here would close a cycle. */
const pathShape = (p: string) => p.replace(/\{[^}]*\}/gu, '{}').replace(/\/+$/u, '') || '/';

/** `$response.body#/data/id` → `data.id`; null for anything not read from the body. */
function linkField(expr: unknown): string | null {
  const m = typeof expr === 'string' ? /^\$response\.body#\/(.+)$/u.exec(expr.trim()) : null;
  return m ? m[1].split('/').map((x) => x.replace(/~1/gu, '/').replace(/~0/gu, '~')).join('.') : null;
}

/** Each 2xx response of an operation, dereferenced. */
function successResponses(doc: Json, op: Op): Json[] {
  const raw = derefSpec(doc, resolveSpecPointer(doc, op.pointer)).node;
  const responses = isObj(raw) && isObj(raw.responses) ? raw.responses : {};
  return Object.entries(responses)
    .filter(([s]) => isSuccess(s))
    .map(([, r]) => derefSpec(doc, r).node)
    .filter(isObj);
}

/** Top-level property names of an operation's 2xx JSON response bodies. */
function responseFields(doc: Json, op: Op): string[] {
  const out = new Set<string>();
  for (const res of successResponses(doc, op)) {
    const content = isObj(res.content) ? res.content : {};
    for (const [type, media] of Object.entries(content)) {
      if (!isJsonType(type) || !isObj(media)) continue;
      const node = flatten(doc, media.schema);
      if (node && isObj(node.properties)) for (const k of Object.keys(node.properties)) out.add(k);
    }
  }
  return [...out];
}

/**
 * The operations of one spec that produce a value `target` needs, closest
 * evidence first: a response `links` entry the spec declares to `target`
 * (by operationId or operationRef), then, per path parameter, a non-GET
 * operation whose 2xx response carries a field of that name. A generic `id`
 * only matches the collection the parameter sits under (`POST /invoices` for
 * `/invoices/{id}`); a specific name (`invoiceId`) matches anywhere.
 */
export function suitePrerequisites(doc: Json, target: OpRow, ops: readonly OpRow[]): SuitePrerequisite[] {
  const out: SuitePrerequisite[] = [];
  const seen = new Set<string>();
  const add = (p: SuitePrerequisite) => {
    const key = `${p.producer}\u0000${p.param ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  const others = ops.filter((o) => o.entityKey !== target.entityKey && o.protocol !== 'async' && o.method);

  for (const o of others) {
    for (const res of successResponses(doc, o)) {
      for (const raw of Object.values(isObj(res.links) ? res.links : {})) {
        const link = derefSpec(doc, raw).node;
        if (!isObj(link)) continue;
        const ref = typeof link.operationRef === 'string' ? link.operationRef.replace(/^#/u, '') : null;
        const hit = (target.operationId && link.operationId === target.operationId) || (ref && ref === target.pointer);
        if (!hit) continue;
        const params = Object.entries(isObj(link.parameters) ? link.parameters : {});
        if (!params.length) add({ source: 'link', producer: o.entityKey, param: null, field: null });
        for (const [name, expr] of params) add({ source: 'link', producer: o.entityKey, param: name.replace(/^path\./u, ''), field: linkField(expr) });
      }
    }
  }

  for (const m of target.path.matchAll(/\{([^}]+)\}/gu)) {
    const param = m[1];
    const collection = pathShape(target.path.slice(0, m.index));
    const ranked: Array<[number, SuitePrerequisite]> = [];
    for (const o of others) {
      if (o.method!.toUpperCase() === 'GET') continue;
      const fields = responseFields(doc, o);
      const exact = fields.find((f) => f.toLowerCase() === param.toLowerCase());
      const under = pathShape(o.path) === collection;
      const field = exact ?? (under && /id$/iu.test(param) ? fields.find((f) => f === 'id') : undefined);
      if (field && (under || field.toLowerCase() !== 'id')) {
        ranked.push([under ? 0 : 1, { source: 'path-param', producer: o.entityKey, param, field }]);
      }
    }
    ranked.sort((a, b) => a[0] - b[0]).forEach(([, p]) => add(p));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The cache key's operation half
// ---------------------------------------------------------------------------

function refsIn(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const x of node) refsIn(x, out);
  else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#')) out.push(v);
      else refsIn(v, out);
    }
  }
  return out;
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
}

/**
 * Everything one operation's suite is built from, as one canonical JSON text:
 * the operation, its path-level parameters, every `$ref` it reaches
 * (transitively), the servers, the security requirement and schemes. Hash it
 * for the cache key: a spec edit elsewhere leaves it unchanged, an edit to a
 * schema the operation uses does not.
 */
export function operationFingerprint(doc: Json, op: { pointer: string }): string {
  const pathItem = resolveSpecPointer(doc, op.pointer.slice(0, op.pointer.lastIndexOf('/')));
  const components = isObj(doc.components) ? doc.components : {};
  const parts: Json = {
    operation: resolveSpecPointer(doc, op.pointer),
    pathParameters: isObj(pathItem) ? (pathItem.parameters ?? null) : null,
    servers: doc.servers ?? null,
    security: doc.security ?? null,
    securitySchemes: components.securitySchemes ?? null,
  };
  const refs: Json = {};
  const queue = refsIn(parts);
  while (queue.length) {
    const ref = queue.pop()!;
    if (ref in refs) continue;
    refs[ref] = resolveSpecPointer(doc, ref);
    refsIn(refs[ref], queue);
  }
  return JSON.stringify(stable({ ...parts, refs }));
}
