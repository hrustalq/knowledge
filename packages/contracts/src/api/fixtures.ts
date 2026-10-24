import { normalizeEntityKey } from '@knowledge/contracts/graph';
import { normalizeApiPath } from '@knowledge/contracts/api';

// ---------------------------------------------------------------------------
// QA test fixtures (#483).
//
// A fixture is a document whose body is a YAML/JSON chain of calls a suite
// runs before its cases — log in, create the invoice, carry its id forward —
// plus manual notes for state no API can create, and teardown calls that run
// whatever happened. Everything here is pure: the finalize check (API), the
// ingestion projection (worker), the editor (web) and, later, the run planner
// read a fixture through `readTestFixture` and nothing else.
//
// Secrets are never values. A credential is a `{{secret.x}}` placeholder the
// runner fills in at run time; a literal in an Authorization, Cookie or API-key
// slot is refused (`literalCredentialIssues`).
// ---------------------------------------------------------------------------

export const TEST_FIXTURE_VERSION = 1;
export const TEST_FIXTURE_MAX_STEPS = 50;

/** A request's values. Scalars in `path` / `query` / `headers`; any JSON in `body`. */
export interface FixtureRequest {
  path?: Record<string, FixtureScalar>;
  query?: Record<string, FixtureScalar>;
  headers?: Record<string, FixtureScalar>;
  body?: unknown;
}
export type FixtureScalar = string | number | boolean;

export interface FixtureCallStep {
  id: string;
  /** A folded `op:` entity key, in any spec of the workspace. */
  call: string;
  request: FixtureRequest;
  /** The status the step must answer with; null accepts any 2xx. */
  expect: number | null;
  /** Variable name → capture rule (`$.id`, `$.items[0].id`, `header:Location`). */
  capture: Record<string, string>;
}

export interface FixtureManualStep {
  id: string;
  /** Markdown describing state that has to exist; never executed. */
  manual: string;
}

export type FixtureStep = FixtureCallStep | FixtureManualStep;

export interface TestFixture {
  description: string | null;
  /** Non-secret run values, with defaults; `null` means the run must supply it. */
  inputs: Record<string, FixtureScalar | null>;
  steps: FixtureStep[];
  /** Always run, after a failure too. */
  teardown: FixtureCallStep[];
}

export const isCallStep = (s: FixtureStep): s is FixtureCallStep => 'call' in s;

export const FIXTURE_ISSUE_CODES = [
  'syntax',
  'too-large',
  'not-object',
  'version',
  'steps-missing',
  'too-many-steps',
  'inputs-shape',
  'step-shape',
  'step-id',
  'duplicate-id',
  'call-invalid',
  'expect-invalid',
  'request-shape',
  'capture-name',
  'capture-rule',
  'placeholder-invalid',
  'undefined-variable',
  'unknown-operation',
  'literal-credential',
] as const;
export type FixtureIssueCode = (typeof FIXTURE_ISSUE_CODES)[number];

/** One validation failure. The API turns `code` + `params` into a message. */
export interface FixtureIssue {
  code: FixtureIssueCode;
  /** The step it is about; null for the fixture as a whole. */
  step: string | null;
  /** Where in the body: `steps[1].capture.invoiceId`. */
  path: string;
  params?: Record<string, string | number>;
}

// ---------------------------------------------------------------------------
// Read API (#483). The fixture as the read view, the library and MCP get it.
// ---------------------------------------------------------------------------

/** One call step's operation, resolved against the spec heads the caller can open. */
export interface FixtureCallInfo {
  stepId: string;
  phase: 'setup' | 'teardown';
  entityKey: string;
  /** The spec and its spelling of the operation; null when no head the caller can open defines it. */
  operation: { documentId: string; specTitle: string; method: string | null; path: string; summary: string | null } | null;
}

/** A validation failure with its message, in the caller's language. */
export interface FixtureIssueInfo extends FixtureIssue {
  message: string;
}

/** GET /v1/test-fixtures/:id — the head (or one revision) of a fixture, parsed and checked now. */
export interface TestFixtureResponse {
  documentId: string;
  revisionId: string;
  title: string;
  /** Null when the body no longer reads; `issues` says why. */
  fixture: TestFixture | null;
  calls: FixtureCallInfo[];
  /** What a run has to supply. */
  runValues: { inputs: string[]; secrets: string[] };
  /**
   * Checked against today's spec heads, under the caller's scope: a call whose
   * operation was removed since the fixture finalized shows up here.
   */
  issues: FixtureIssueInfo[];
}

/** One row of the fixture library. */
export interface TestFixtureSummary {
  documentId: string;
  projectId: string;
  title: string;
  headRevisionId: string | null;
  /** Folded keys the head calls, setup and teardown. */
  calls: string[];
  /** Of `calls`, the keys no spec head in the workspace defines. */
  brokenCalls: string[];
  updatedAt: string;
}

/** GET /v1/test-fixtures */
export interface ListTestFixturesResponse {
  fixtures: TestFixtureSummary[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const STEP_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/gu;
const REQUEST_PARTS = ['path', 'query', 'headers', 'body'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is FixtureScalar => ['string', 'number', 'boolean'].includes(typeof v);

/**
 * `op:billing:POST /invoices/{id}` in any spelling → the folded key, or null
 * when it is not an HTTP operation key. Path parameters fold to `{}` through
 * `normalizeEntityKey`, so `{id}` and `{invoiceId}` name one operation.
 */
export function fixtureCallKey(raw: string): string | null {
  const m = /^op:([^:]+):\s*([A-Za-z]+)[\s-]+(\/.*)$/u.exec(raw.trim());
  if (!m) return null;
  return normalizeEntityKey(`op:${m[1]}:${m[2].toUpperCase()} ${normalizeApiPath(m[3])}`);
}

/** Every placeholder name in a value, in order: `input.x`, `secret.x` or a captured variable. */
export function fixturePlaceholders(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') for (const m of v.matchAll(PLACEHOLDER)) out.push(m[1]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}

type PlaceholderRef = { kind: 'input' | 'secret' | 'var'; name: string };

export function parsePlaceholder(raw: string): PlaceholderRef | null {
  const dot = raw.indexOf('.');
  if (dot === -1) return NAME.test(raw) ? { kind: 'var', name: raw } : null;
  const scope = raw.slice(0, dot);
  const name = raw.slice(dot + 1);
  if ((scope !== 'input' && scope !== 'secret') || !NAME.test(name)) return null;
  return { kind: scope, name };
}

/**
 * Fill placeholders. A string that is exactly one placeholder takes the value
 * as it is (a captured number stays a number in a JSON body); one embedded in
 * text is stringified into it. An unknown name is left as written, so a run
 * shows what was missing rather than sending an empty value.
 */
export function resolvePlaceholders(value: unknown, lookup: (ref: PlaceholderRef) => unknown): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([^{}]*?)\s*\}\}$/u.exec(value);
    if (whole) {
      const ref = parsePlaceholder(whole[1]);
      const v = ref ? lookup(ref) : undefined;
      return v === undefined ? value : v;
    }
    return value.replace(PLACEHOLDER, (all, name: string) => {
      const ref = parsePlaceholder(name);
      const v = ref ? lookup(ref) : undefined;
      return v === undefined ? all : typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, lookup));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePlaceholders(v, lookup)]));
  return value;
}

// ---------------------------------------------------------------------------
// Captures: a JSONPath subset over the body, or a response header.
// ---------------------------------------------------------------------------

export type CaptureRule = { from: 'header'; name: string } | { from: 'body'; path: Array<string | number> };

/** `$`, `$.a.b`, `$.items[0].id`, `$['odd key']`, or `header:Location`. */
export function parseCaptureRule(rule: string): CaptureRule | null {
  const r = rule.trim();
  if (/^header:/iu.test(r)) {
    const name = r.slice('header:'.length).trim();
    return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ? { from: 'header', name } : null;
  }
  if (!r.startsWith('$')) return null;
  const path: Array<string | number> = [];
  const seg = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[(?:'([^']*)'|"([^"]*)")\]/uy;
  seg.lastIndex = 1;
  while (seg.lastIndex < r.length) {
    const m = seg.exec(r);
    if (!m) return null;
    path.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : (m[3] ?? m[4])));
  }
  return { from: 'body', path };
}

/** The captured value, or undefined when the response does not have it. Header names match case-insensitively. */
export function evaluateCapture(
  rule: CaptureRule,
  response: { headers: Record<string, string> | Array<{ name: string; value: string }>; body: unknown },
): unknown {
  if (rule.from === 'header') {
    const want = rule.name.toLowerCase();
    const entries = Array.isArray(response.headers)
      ? response.headers.map((h) => [h.name, h.value] as const)
      : Object.entries(response.headers);
    return entries.find(([k]) => k.toLowerCase() === want)?.[1];
  }
  let at: unknown = response.body;
  for (const key of rule.path) {
    if (typeof key === 'number' ? !Array.isArray(at) : !isObj(at)) return undefined;
    at = (at as Record<string | number, unknown>)[key];
    if (at === undefined) return undefined;
  }
  return at;
}

// ---------------------------------------------------------------------------
// Reading and validating a fixture body.
// ---------------------------------------------------------------------------

/**
 * A parsed YAML/JSON value → a fixture, plus every structural issue: shape,
 * unique ids, call keys, capture rules, and that every `{{var}}` is captured
 * by an earlier step (teardown sees every setup capture). Operation existence
 * and credential slots need the workspace's specs; the API checks those with
 * `literalCredentialIssues` after resolving each call.
 */
export function readTestFixture(value: unknown): { fixture: TestFixture | null; issues: FixtureIssue[] } {
  const issues: FixtureIssue[] = [];
  const issue = (code: FixtureIssueCode, path: string, step: string | null = null, params?: FixtureIssue['params']) =>
    issues.push({ code, step, path, ...(params ? { params } : {}) });

  if (!isObj(value)) {
    issue('not-object', '');
    return { fixture: null, issues };
  }
  if (value.fixture !== TEST_FIXTURE_VERSION) issue('version', 'fixture', null, { version: TEST_FIXTURE_VERSION });

  const inputs: TestFixture['inputs'] = {};
  if (value.inputs !== undefined && value.inputs !== null) {
    if (!isObj(value.inputs)) issue('inputs-shape', 'inputs');
    else
      for (const [k, v] of Object.entries(value.inputs)) {
        if (!NAME.test(k) || (v !== null && !isScalar(v))) issue('inputs-shape', `inputs.${k}`);
        else inputs[k] = v;
      }
  }

  if (!Array.isArray(value.steps) || value.steps.length === 0) issue('steps-missing', 'steps');
  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  const rawTeardown = Array.isArray(value.teardown) ? value.teardown : [];
  if (value.teardown !== undefined && value.teardown !== null && !Array.isArray(value.teardown)) issue('step-shape', 'teardown');
  if (rawSteps.length + rawTeardown.length > TEST_FIXTURE_MAX_STEPS) {
    issue('too-many-steps', 'steps', null, { max: TEST_FIXTURE_MAX_STEPS });
  }

  const ids = new Set<string>();
  const captured = new Set<string>();
  const readStep = (raw: unknown, path: string, fallbackId: string | null): FixtureStep | null => {
    if (!isObj(raw)) {
      issue('step-shape', path);
      return null;
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : (fallbackId ?? '');
    if (!STEP_ID.test(id)) {
      issue('step-id', `${path}.id`);
      return null;
    }
    if (ids.has(id)) issue('duplicate-id', `${path}.id`, id, { id });
    ids.add(id);

    if (typeof raw.manual === 'string' && raw.call === undefined && fallbackId === null) {
      return raw.manual.trim() ? { id, manual: raw.manual.trim() } : (issue('step-shape', `${path}.manual`, id), null);
    }
    if (typeof raw.call !== 'string') {
      issue('step-shape', path, id);
      return null;
    }
    const call = fixtureCallKey(raw.call);
    if (!call) issue('call-invalid', `${path}.call`, id, { call: raw.call });

    let expect: number | null = null;
    if (raw.expect !== undefined && raw.expect !== null) {
      if (Number.isInteger(raw.expect) && (raw.expect as number) >= 100 && (raw.expect as number) <= 599) expect = raw.expect as number;
      else issue('expect-invalid', `${path}.expect`, id);
    }

    const request: FixtureRequest = {};
    if (raw.request !== undefined && raw.request !== null) {
      if (!isObj(raw.request)) issue('request-shape', `${path}.request`, id);
      else
        for (const [part, v] of Object.entries(raw.request)) {
          if (!(REQUEST_PARTS as readonly string[]).includes(part)) {
            issue('request-shape', `${path}.request.${part}`, id);
          } else if (part === 'body') {
            request.body = v;
          } else if (!isObj(v) || !Object.values(v).every(isScalar)) {
            issue('request-shape', `${path}.request.${part}`, id);
          } else {
            request[part as 'path' | 'query' | 'headers'] = v as Record<string, FixtureScalar>;
          }
        }
    }

    for (const name of fixturePlaceholders(request)) {
      const ref = parsePlaceholder(name);
      if (!ref) issue('placeholder-invalid', `${path}.request`, id, { name });
      else if (ref.kind === 'var' && !captured.has(ref.name)) issue('undefined-variable', `${path}.request`, id, { name });
    }

    const capture: Record<string, string> = {};
    if (raw.capture !== undefined && raw.capture !== null) {
      if (!isObj(raw.capture)) issue('capture-rule', `${path}.capture`, id);
      else
        for (const [name, rule] of Object.entries(raw.capture)) {
          if (!NAME.test(name) || name === 'input' || name === 'secret') issue('capture-name', `${path}.capture.${name}`, id, { name });
          else if (typeof rule !== 'string' || !parseCaptureRule(rule)) issue('capture-rule', `${path}.capture.${name}`, id, { name });
          else capture[name] = rule.trim();
        }
    }
    // Captured after the step's own request is checked: a step cannot use what it captures.
    for (const name of Object.keys(capture)) captured.add(name);
    return { id, call: call ?? raw.call, request, expect, capture };
  };

  const steps = rawSteps.map((s, i) => readStep(s, `steps[${i}]`, null));
  const teardown = rawTeardown.map((s, i) => readStep(s, `teardown[${i}]`, `teardown-${i + 1}`));
  if (issues.length > 0) return { fixture: null, issues };
  return {
    fixture: {
      description: typeof value.description === 'string' && value.description.trim() ? value.description.trim() : null,
      inputs,
      steps: steps as FixtureStep[],
      teardown: teardown as FixtureCallStep[],
    },
    issues,
  };
}

/** Every `{{input.x}}` and `{{secret.x}}` a run has to supply (an input with a default included). */
export function fixtureRunValues(f: TestFixture): { inputs: string[]; secrets: string[] } {
  const inputs = new Set(Object.keys(f.inputs));
  const secrets = new Set<string>();
  for (const s of [...f.steps.filter(isCallStep), ...f.teardown]) {
    for (const raw of fixturePlaceholders(s.request)) {
      const ref = parsePlaceholder(raw);
      if (ref?.kind === 'input') inputs.add(ref.name);
      if (ref?.kind === 'secret') secrets.add(ref.name);
    }
  }
  return { inputs: [...inputs], secrets: [...secrets] };
}

/**
 * Where an operation takes an API key, beyond Authorization and Cookie (every
 * cookie value is checked anyway, so a cookie-borne key needs no entry).
 */
export interface CredentialSlots {
  headers: string[];
  query: string[];
}

/**
 * A literal credential in one call step. Authorization (and
 * Proxy-Authorization) may carry a scheme word and placeholders; every Cookie
 * pair and every API-key header or query value must be placeholders only.
 * `{{input.x}}` counts as a literal here: inputs are non-secret and may carry a
 * default in the fixture, which would launder a token into the body.
 */
export function literalCredentialIssues(step: FixtureCallStep, path: string, slots: CredentialSlots): FixtureIssue[] {
  const out: FixtureIssue[] = [];
  const flag = (where: string, name: string) =>
    out.push({ code: 'literal-credential', step: step.id, path: `${path}.request.${where}.${name}`, params: { name } });
  const bare = (v: FixtureScalar) =>
    typeof v !== 'string' ? String(v) : v.replace(PLACEHOLDER, (_all, n: string) => (parsePlaceholder(n)?.kind === 'input' ? 'x' : ''));
  const lower = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const apiKeyHeaders = lower(slots.headers);
  const apiKeyQuery = lower(slots.query);

  for (const [name, value] of Object.entries(step.request.headers ?? {})) {
    const h = name.toLowerCase();
    if (h === 'authorization' || h === 'proxy-authorization') {
      if (bare(value).replace(/^\s*[A-Za-z][\w-]*(\s+|$)/u, '').trim()) flag('headers', name);
    } else if (h === 'cookie') {
      const pairs = String(value).split(';');
      if (pairs.some((p) => bare(p.slice(p.indexOf('=') + 1)).trim())) flag('headers', name);
    } else if (apiKeyHeaders.has(h) && bare(value).trim()) {
      flag('headers', name);
    }
  }
  for (const [name, value] of Object.entries(step.request.query ?? {})) {
    if (apiKeyQuery.has(name.toLowerCase()) && bare(value).trim()) flag('query', name);
  }
  return out;
}
