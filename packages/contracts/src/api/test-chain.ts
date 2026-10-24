import {
  curlArgs,
  fullUrl,
  isJsonType,
  sampleRequestFor,
  type SampleRequest,
  type SampleText,
} from '@knowledge/contracts/api/samples';
import {
  evaluateCapture,
  isCallStep,
  parseCaptureRule,
  parsePlaceholder,
  type FixtureCallStep,
  type FixtureScalar,
  type TestFixture,
} from '@knowledge/contracts/api/fixtures';
import type { ApiTestCase } from '@knowledge/contracts/api/test-cases';
import type { ApiTestRunSummary } from '@knowledge/contracts/api';

// ---------------------------------------------------------------------------
// A suite as one runnable chain (#483): the bound fixtures' setup, every case
// (each after its own fixtures, if it has any), then teardown. The exports
// print it, and the runners (browser, server, an agent's own HTTP client)
// walk it, so all of them agree on the order:
//
// - negative cases run before positive ones, since a negative case should
//   not change state and a positive one may;
// - a failed suite setup step stops the run, and teardown runs anyway;
// - a case's own fixtures run just before it, their captures shadow the
//   suite's for that case only, and their teardown runs right after it.
//
// A request carries placeholders, never values: `{{invoiceId}}` for a capture,
// `{{input.x}}` / `{{secret.x}}` for what a run supplies, and the spec's
// credential slots as `{ env: 'TOKEN' }` parts. A capture named like a
// credential slot (`TOKEN`) fills it.
// ---------------------------------------------------------------------------

/** One bound fixture's head, parsed. */
export interface TestChainFixture {
  documentId: string;
  title: string;
  fixture: TestFixture;
}

interface ChainStepBase {
  /** `<fixture document id>:<step id>`: unique within a chain. */
  id: string;
  fixtureId: string;
  fixtureTitle: string;
  stepId: string;
}

export interface TestChainCall extends ChainStepBase {
  kind: 'call';
  entityKey: string;
  request: SampleRequest;
  /** `201`, or `2XX` when the step accepts any success. */
  expect: string;
  capture: Record<string, string>;
}

export interface TestChainNote extends ChainStepBase {
  kind: 'manual';
  note: string;
}

export type TestChainStep = TestChainCall | TestChainNote;

export interface TestChainCase {
  case: ApiTestCase;
  setup: TestChainStep[];
  teardown: TestChainCall[];
  /** What this case's own fixtures capture: shadowed for this case, restored after it. */
  captures: string[];
}

export interface TestChain {
  title: string;
  setup: TestChainStep[];
  cases: TestChainCase[];
  teardown: TestChainCall[];
  /** `{{input.x}}` a run may supply, with the first default a fixture gives; null when none does. */
  inputs: Record<string, FixtureScalar | null>;
  /** Everything else a run must supply: `secret.x`, and credential slots no fixture captures (`TOKEN`). */
  secrets: string[];
}

type Json = Record<string, unknown>;
type ChainOp = { method: string | null; path: string; pointer: string; protocol?: string };
/** A call step's operation at a spec head; the caller has already refused a fixture whose call does not resolve. */
export type ChainResolver = (entityKey: string) => { doc: Json; op: ChainOp };

const VAR = /\{\{\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\}\}/gu;

/** String runs with `{{name}}` in them → literal runs and `{ env: name }` parts. */
export function splitVars(t: SampleText): SampleText {
  const out: SampleText = [];
  for (const part of t) {
    if (typeof part !== 'string') {
      out.push(part);
      continue;
    }
    let last = 0;
    for (const m of part.matchAll(VAR)) {
      if (m.index > last) out.push(part.slice(last, m.index));
      out.push({ env: m[1] });
      last = m.index + m[0].length;
    }
    if (last < part.length) out.push(part.slice(last));
  }
  return out;
}

const scalarText = (v: FixtureScalar) => String(v);
const strings = (r: Record<string, FixtureScalar> | undefined) =>
  r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, scalarText(v)])) : undefined;

/**
 * One fixture call as a request: the spec's request for the operation with
 * the step's values. A header or query value the spec does not declare —
 * an explicit `Authorization` — is still sent, replacing the spec's slot.
 */
function fixtureCallRequest(doc: Json, op: ChainOp, step: FixtureCallStep): SampleRequest {
  const req = sampleRequestFor(doc, op, {
    path: strings(step.request.path),
    query: strings(step.request.query),
    headers: strings(step.request.headers),
    ...(step.request.body !== undefined ? { body: JSON.stringify(step.request.body, null, 2) } : {}),
  });
  if (!req) throw new Error(`No HTTP request for ${step.call}`);
  const over = (list: SampleRequest['headers'], given: Record<string, FixtureScalar> | undefined) => {
    const out = [...list];
    for (const [name, value] of Object.entries(given ?? {})) {
      const i = out.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
      const entry = { name, value: [scalarText(value)] };
      if (i === -1) out.push(entry);
      else out[i] = entry;
    }
    return out;
  };
  return { ...req, headers: over(req.headers, step.request.headers), query: over(req.query, step.request.query) };
}

function stepsOf(f: TestChainFixture, resolve: ChainResolver): { setup: TestChainStep[]; teardown: TestChainCall[] } {
  const base = (stepId: string) => ({ id: `${f.documentId}:${stepId}`, fixtureId: f.documentId, fixtureTitle: f.title, stepId });
  const call = (s: FixtureCallStep): TestChainCall => {
    const { doc, op } = resolve(s.call);
    return {
      ...base(s.id),
      kind: 'call',
      entityKey: s.call,
      request: fixtureCallRequest(doc, op, s),
      expect: s.expect === null ? '2XX' : String(s.expect),
      capture: s.capture,
    };
  };
  return {
    setup: f.fixture.steps.map((s) => (isCallStep(s) ? call(s) : { ...base(s.id), kind: 'manual' as const, note: s.manual })),
    teardown: f.fixture.teardown.map(call),
  };
}

const capturesOf = (steps: readonly TestChainStep[]) =>
  steps.flatMap((s) => (s.kind === 'call' ? Object.keys(s.capture) : []));

function requestVars(req: SampleRequest): string[] {
  const parts = [...[...req.query, ...req.headers].flatMap((x) => splitVars(x.value)), ...splitVars([req.url, req.body?.text ?? ''])];
  return parts.flatMap((p) => (typeof p === 'string' ? [] : [p.env]));
}

/**
 * The chain for one suite. `perCase` is keyed by case id; a case id the
 * suite does not have is ignored. Cases keep their catalogue order within
 * each kind.
 */
export function testChain(opts: {
  title: string;
  cases: readonly ApiTestCase[];
  suite: readonly TestChainFixture[];
  perCase?: Readonly<Record<string, readonly TestChainFixture[]>>;
  resolve: ChainResolver;
}): TestChain {
  const suite = opts.suite.map((f) => stepsOf(f, opts.resolve));
  const setup = suite.flatMap((s) => s.setup);
  // Teardown undoes setup: the last fixture's first.
  const teardown = [...suite].reverse().flatMap((s) => s.teardown);
  const ordered = [...opts.cases.filter((c) => c.kind === 'negative'), ...opts.cases.filter((c) => c.kind !== 'negative')];
  const cases = ordered.map((c): TestChainCase => {
    const own = (opts.perCase?.[c.id] ?? []).map((f) => stepsOf(f, opts.resolve));
    const caseSetup = own.flatMap((s) => s.setup);
    const caseTeardown = [...own].reverse().flatMap((s) => s.teardown);
    return { case: c, setup: caseSetup, teardown: caseTeardown, captures: [...new Set(capturesOf([...caseSetup, ...caseTeardown]))] };
  });

  const inputs: TestChain['inputs'] = {};
  for (const f of [...opts.suite, ...Object.values(opts.perCase ?? {}).flat()]) {
    for (const [k, v] of Object.entries(f.fixture.inputs)) if (inputs[k] === undefined || inputs[k] === null) inputs[k] = v;
  }
  const calls = [...setup, ...teardown, ...cases.flatMap((c) => [...c.setup, ...c.teardown])].filter(
    (s): s is TestChainCall => s.kind === 'call',
  );
  const captured = new Set(capturesOf(calls));
  const secrets = new Set<string>();
  for (const name of [...calls.map((s) => s.request), ...cases.map((c) => c.case.request)].flatMap(requestVars)) {
    const ref = parsePlaceholder(name);
    if (ref?.kind === 'input') inputs[ref.name] ??= null;
    else if (ref?.kind === 'secret' || !captured.has(name)) secrets.add(name);
  }
  return { title: opts.title, setup, cases, teardown, inputs, secrets: [...secrets] };
}

// ---------------------------------------------------------------------------
// Postman Collection v2.1
// ---------------------------------------------------------------------------

const postmanText = (t: SampleText) => t.map((p) => (typeof p === 'string' ? p : `{{${p.env}}}`)).join('');

/** Query and header values with `{{var}}` split out, so `fullUrl` does not encode the braces. */
function withVarParts(req: SampleRequest): SampleRequest {
  const split = (xs: SampleRequest['headers']) => xs.map((x) => ({ ...x, value: splitVars(x.value) }));
  return { ...req, query: split(req.query), headers: split(req.headers) };
}

function statusCheck(status: string): string {
  const range = /^([1-5])XX$/iu.exec(status);
  return range ? `pm.response.code >= ${range[1]}00 && pm.response.code <= ${range[1]}99` : `pm.response.code === ${Number(status)}`;
}

function statusTest(status: string): string {
  const range = /^([1-5])XX$/iu.exec(status);
  const check = range
    ? `pm.expect(pm.response.code).to.be.within(${range[1]}00, ${range[1]}99);`
    : `pm.response.to.have.status(${Number(status)});`;
  return `pm.test(${JSON.stringify(`Status is ${status.toUpperCase()}`)}, function () { ${check} });`;
}

function captureJs(rule: string): string {
  const r = parseCaptureRule(rule);
  if (!r) return 'undefined';
  if (r.from === 'header') return `pm.response.headers.get(${JSON.stringify(r.name)})`;
  return `pm.response.json()${r.path.map((k) => `[${JSON.stringify(k)}]`).join('')}`;
}

function postmanRequest(req: SampleRequest, description?: string) {
  const r = withVarParts(req);
  return {
    method: r.method,
    header: r.headers.map((h) => ({ key: h.name, value: postmanText(h.value) })),
    url: postmanText(fullUrl(r)),
    ...(r.body
      ? { body: { mode: 'raw', raw: r.body.text, options: { raw: { language: isJsonType(r.body.contentType) ? 'json' : 'text' } } } }
      : {}),
    ...(description ? { description } : {}),
  };
}

/** Each capture as a collection variable; with `onFail` set, a failed step jumps there (null stops the run) instead. */
function captureJsLines(s: TestChainCall, onFail: string | null | undefined): string[] {
  const sets = Object.entries(s.capture).map(([k, rule]) => `pm.collectionVariables.set(${JSON.stringify(k)}, ${captureJs(rule)});`);
  if (onFail === undefined) return sets;
  return [`if (!(${statusCheck(s.expect)})) {`, `  postman.setNextRequest(${JSON.stringify(onFail)});`, '} else {', ...sets.map((l) => `  ${l}`), '}'];
}

const noteLines = (steps: readonly TestChainStep[]) =>
  steps.filter((s): s is TestChainNote => s.kind === 'manual').map((s) => `Manual (${s.fixtureTitle} › ${s.stepId}): ${s.note}`);

/**
 * A Postman Collection v2.1: a Setup folder whose test scripts set a
 * collection variable per capture, the cases, then a Teardown folder. A failed
 * setup step jumps to teardown. Inputs carry their defaults; secrets and
 * credential slots are variables with no value. Manual steps are the folders'
 * descriptions.
 */
export function testSuitePostman(chain: TestChain, folder: string): Record<string, unknown> {
  const firstTeardown = chain.teardown[0] ? `Teardown 1. ${chain.teardown[0].fixtureTitle} › ${chain.teardown[0].stepId}` : null;
  const callItem = (s: TestChainCall, name: string, onFail: string | null | undefined, teardown: boolean) => {
    const vars = teardown ? requestVars(s.request) : [];
    // A teardown step whose setup never captured its values is skipped, not sent with a hole in it.
    const skip = `if (${JSON.stringify(vars)}.some((k) => !pm.collectionVariables.get(k)) && pm.execution && pm.execution.skipRequest) pm.execution.skipRequest();`;
    return {
      name,
      request: postmanRequest(s.request),
      event: [
        ...(vars.length ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: [skip] } }] : []),
        { listen: 'test', script: { type: 'text/javascript', exec: [statusTest(s.expect), ...captureJsLines(s, onFail)] } },
      ],
    };
  };
  const calls = (steps: readonly TestChainStep[], prefix: string, onFail?: string | null) =>
    steps
      .filter((s): s is TestChainCall => s.kind === 'call')
      .map((s, i) => callItem(s, `${prefix} ${i + 1}. ${s.fixtureTitle} › ${s.stepId}`, onFail, /Teardown$/u.test(prefix)));

  const caseItem = (c: TestChainCase, n: number) => {
    const name = `${n}. ${c.case.name}`;
    const item = {
      name,
      request: postmanRequest(c.case.request, c.case.description || undefined),
      event: [{ listen: 'test', script: { type: 'text/javascript', exec: [statusTest(c.case.expected.status)] } }],
    };
    if (!c.setup.length && !c.teardown.length) return item;
    const items: Array<Record<string, unknown>> = [...calls(c.setup, `${n}. Setup`), item, ...calls(c.teardown, `${n}. Teardown`)];
    if (c.captures.length) {
      // Shadow the suite's captures for this case only: save before, restore after.
      const saved = `__saved_${n}`;
      const save = `pm.collectionVariables.set(${JSON.stringify(saved)}, JSON.stringify(Object.fromEntries(${JSON.stringify(c.captures)}.map((k) => [k, pm.collectionVariables.has(k) ? pm.collectionVariables.get(k) : null]))));`;
      const restore = `Object.entries(JSON.parse(pm.collectionVariables.get(${JSON.stringify(saved)}) || '{}')).forEach(([k, v]) => v === null ? pm.collectionVariables.unset(k) : pm.collectionVariables.set(k, v));`;
      items[0] = { ...items[0], event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: [save] } }, ...(items[0].event as unknown[])] };
      const last = items[items.length - 1];
      const events = last.event as Array<{ listen: string; script: { exec: string[] } }>;
      items[items.length - 1] = {
        ...last,
        event: events.map((e) => (e.listen === 'test' ? { ...e, script: { ...e.script, exec: [...e.script.exec, restore] } } : e)),
      };
    }
    const notes = noteLines(c.setup);
    return { name, item: items, ...(notes.length ? { description: notes.join('\n') } : {}) };
  };

  const setupNotes = noteLines(chain.setup);
  return {
    info: {
      name: chain.title,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      ...(chain.setup.length
        ? [{ name: 'Setup', item: calls(chain.setup, 'Setup', firstTeardown), ...(setupNotes.length ? { description: setupNotes.join('\n') } : {}) }]
        : []),
      { name: folder, item: chain.cases.map((c, i) => caseItem(c, i + 1)) },
      ...(chain.teardown.length ? [{ name: 'Teardown', item: calls(chain.teardown, 'Teardown') }] : []),
    ],
    variable: [
      ...Object.entries(chain.inputs).map(([k, v]) => ({ key: `input.${k}`, value: v === null ? '' : String(v) })),
      ...chain.secrets.map((k) => ({ key: k, value: '' })),
    ],
  };
}

// ---------------------------------------------------------------------------
// A bash script: curl + jq
// ---------------------------------------------------------------------------

/** `input.currency` → `input_currency`: a shell variable name. */
const shellName = (name: string) => name.replace(/\./gu, '_');
const sq = (s: string) => `'${s.replace(/'/gu, `'\\''`)}'`;
const shellParts = (t: SampleText): SampleText => splitVars(t).map((p) => (typeof p === 'string' ? p : { env: shellName(p.env) }));
/** A status as a `[[ == ]]` glob: `4XX` → `4??`. */
const statusGlob = (s: string) => s.toUpperCase().replace(/X/gu, '?');

function jqPath(rule: ReturnType<typeof parseCaptureRule>): string {
  const path = rule?.from === 'body' ? rule.path : [];
  return `.${path.map((k) => (typeof k === 'number' ? `[${k}]` : `[${JSON.stringify(k)}]`)).join('')}`;
}

function curlCall(label: string, expect: string, req: SampleRequest, indent = ''): string[] {
  const r = withVarParts(req);
  const args = curlArgs({
    method: r.method,
    url: shellParts(fullUrl(r)),
    headers: r.headers.map((h) => ({ name: h.name, value: shellParts(h.value) })),
    body: r.body ? shellParts([r.body.text]) : null,
  });
  return [`${indent}call ${sq(label)} '${statusGlob(expect)}' \\`, ...args.map((a, i) => `${indent}  ${a}${i < args.length - 1 ? ' \\' : ''}`)];
}

function captureLines(s: TestChainCall, indent: string): string[] {
  return Object.entries(s.capture).map(([k, raw]) => {
    const rule = parseCaptureRule(raw);
    const read = rule?.from === 'header' ? `header ${sq(rule.name)}` : `jq -r ${sq(`${jqPath(rule)} // empty`)} "$tmp/body"`;
    return `${indent}${k}=$(${read})`;
  });
}

/** Setup stops at `onFail`; teardown (`onFail` null) skips a step whose setup never captured what it sends. */
function stepLines(steps: readonly TestChainStep[], indent: string, onFail: string | null): string[] {
  return steps.flatMap((s) => {
    if (s.kind === 'manual') return [`${indent}# Manual (${s.fixtureTitle} › ${s.stepId}): ${s.note.replace(/\n/gu, `\n${indent}# `)}`];
    const label = `${s.fixtureTitle} › ${s.stepId}`;
    const vars = onFail === null ? requestVars(s.request).map(shellName) : [];
    const inner = vars.length ? `${indent}  ` : indent;
    const call = curlCall(label, s.expect, s.request, inner);
    call[call.length - 1] += ` || ${onFail ?? 'true'}`;
    if (!vars.length) return [...call, ...captureLines(s, inner)];
    return [
      `${indent}if ${[...new Set(vars)].map((v) => `[ -n "\${${v}:-}" ]`).join(' && ')}; then`,
      ...call,
      ...captureLines(s, inner),
      `${indent}else echo ${sq(`SKIP ${label}: setup never captured what it sends`)}; fi`,
    ];
  });
}

/**
 * The suite as a bash script: it checks every secret is exported, runs setup
 * (stopping at the first failed step), every case, and teardown on exit
 * through a `trap` — after a failed case too. A case with its own fixtures
 * runs in a subshell, so its captures never leak into the next case. Exits
 * non-zero when anything failed. Needs curl and jq.
 */
export function testSuiteCurl(chain: TestChain): string {
  const needed = [...chain.secrets, ...Object.keys(chain.inputs).filter((k) => chain.inputs[k] === null).map((k) => `input.${k}`)].map(shellName);
  const lines: string[] = ['#!/usr/bin/env bash', `# ${chain.title}`, '# Needs curl and jq.'];
  if (needed.length) lines.push(`# Export ${needed.map((v) => `$${v}`).join(', ')} before running.`);
  lines.push('');
  for (const [k, v] of Object.entries(chain.inputs)) if (v !== null) lines.push(`: "\${input_${k}:=${String(v).replace(/[\\"`$]/gu, (c) => `\\${c}`)}}"`);
  if (needed.length) lines.push(`for v in ${needed.join(' ')}; do [ -n "\${!v:-}" ] || { echo "Set \\$$v first" >&2; exit 2; }; done`);
  lines.push(
    'tmp=$(mktemp -d)',
    'failed=0',
    '',
    'call() {',
    '  local label=$1 expect=$2 code',
    '  shift 2',
    `  code=$(curl --silent --show-error --output "$tmp/body" --dump-header "$tmp/headers" --write-out '%{http_code}' "$@") || code=000`,
    '  # shellcheck disable=SC2053 # $expect is a glob: 4??',
    '  if [[ $code == $expect ]]; then echo "PASS $label ($code)"; else echo "FAIL $label: expected ${expect//\\?/X}, got $code"; failed=1; return 1; fi',
    '}',
    'header() { grep -i "^$1:" "$tmp/headers" | tail -n 1 | cut -d: -f2- | sed \'s/^ *//\' | tr -d \'\\r\'; }',
    '',
    'teardown() {',
    ...stepLines(chain.teardown, '  ', null),
    '  rm -rf "$tmp"',
    '}',
    'trap teardown EXIT',
    '',
  );
  if (chain.setup.length) lines.push('# Setup', ...stepLines(chain.setup, '', 'exit 1'), '');
  lines.push('# Cases');
  for (const c of chain.cases) {
    const head = [`# ${c.case.name}`, `# ${c.case.kind}, ${c.case.rule}: expects ${c.case.expected.status}`];
    const own = c.setup.length > 0 || c.teardown.length > 0;
    const indent = own ? '  ' : '';
    const body = curlCall(c.case.name, c.case.expected.status, c.case.request, indent);
    body[body.length - 1] += ' || true';
    if (!own) {
      lines.push(...head, ...body, '');
      continue;
    }
    lines.push(
      ...head,
      '(',
      ...(c.teardown.length ? ['  case_teardown() {', ...stepLines(c.teardown, '    ', null), '  }', '  trap case_teardown EXIT'] : []),
      ...stepLines(c.setup, '  ', 'exit 1'),
      ...body,
      '  exit $failed',
      ') || failed=1',
      '',
    );
  }
  lines.push('exit $failed');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// The run plan (#483, phase 3): the chain with every request flattened to
// strings carrying `{{name}}` placeholders, and each call naming the spec
// revision that defines it — the try-it proxy's `:id` and `revisionId`. The
// browser runner walks it with `runTestPlan`; an agent walks it with its own
// HTTP client. No value is ever in it: a run supplies `values`.
// ---------------------------------------------------------------------------

/** Where a call goes. `server` is the base URL the plan's request starts with, so a run may swap it for another server of that spec. */
export interface TestRunTarget {
  documentId: string;
  revisionId: string;
  entityKey: string;
  server: string;
}

/** A request with `{{name}}` placeholders: captures, `input.x`, `secret.x` and credential slots (`TOKEN`). */
export interface TestRunRequest {
  method: string;
  /** With the query. A placeholder here is URL-encoded when filled. */
  url: string;
  headers: Array<{ name: string; value: string }>;
  body: string | null;
}

export interface TestRunCall {
  id: string;
  kind: 'call';
  label: string;
  target: TestRunTarget;
  request: TestRunRequest;
  expect: string;
  capture: Record<string, string>;
}

export interface TestRunNote {
  id: string;
  kind: 'manual';
  label: string;
  note: string;
}

export type TestRunStep = TestRunCall | TestRunNote;

export interface TestRunCase {
  id: string;
  kind: 'positive' | 'negative';
  name: string;
  target: TestRunTarget;
  request: TestRunRequest;
  expect: string;
  setup: TestRunStep[];
  teardown: TestRunCall[];
  /** Captures this case's own fixtures make: shadowed for the case, restored after it. */
  captures: string[];
}

/** GET /v1/api-specs/:id/test-run-plan and `knowledge_get_test_run_plan`. */
export interface TestRunPlan {
  documentId: string;
  entityKey: string;
  title: string;
  setup: TestRunStep[];
  /** Negative cases first. */
  cases: TestRunCase[];
  teardown: TestRunCall[];
  inputs: Record<string, FixtureScalar | null>;
  secrets: string[];
}

const flatText = (t: SampleText) => splitVars(t).map((p) => (typeof p === 'string' ? p : `{{${p.env}}}`)).join('');

function flatRequest(req: SampleRequest): TestRunRequest {
  const r = withVarParts(req);
  return {
    method: r.method,
    url: flatText(fullUrl(r)),
    headers: r.headers.map((h) => ({ name: h.name, value: flatText(h.value) })),
    body: r.body ? flatText([r.body.text]) : null,
  };
}

/** The chain as a plan. `target` answers for every call's entity key, and for null (the suite's own operation). */
export function testRunPlan(
  chain: TestChain,
  at: { documentId: string; entityKey: string },
  target: (entityKey: string | null) => TestRunTarget,
): TestRunPlan {
  const label = (s: ChainStepBase) => `${s.fixtureTitle} › ${s.stepId}`;
  const call = (s: TestChainCall): TestRunCall => ({
    id: s.id,
    kind: 'call',
    label: label(s),
    target: target(s.entityKey),
    request: flatRequest(s.request),
    expect: s.expect,
    capture: s.capture,
  });
  const step = (s: TestChainStep): TestRunStep => (s.kind === 'call' ? call(s) : { id: s.id, kind: 'manual', label: label(s), note: s.note });
  return {
    documentId: at.documentId,
    entityKey: at.entityKey,
    title: chain.title,
    setup: chain.setup.map(step),
    cases: chain.cases.map((c) => ({
      id: c.case.id,
      kind: c.case.kind,
      name: c.case.name,
      target: target(null),
      request: flatRequest(c.case.request),
      expect: c.case.expected.status,
      setup: c.setup.map(step),
      teardown: c.teardown.map(call),
      captures: c.captures,
    })),
    teardown: chain.teardown.map(call),
    inputs: chain.inputs,
    secrets: chain.secrets,
  };
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\}\}/gu;

/**
 * The request with values in place, or the names it lacks. A header whose
 * placeholder has no value is left out (an empty credential slot is "no
 * credentials", as in the try-it console); a gap in the URL or body is a gap.
 * In a JSON body a value is escaped for the string it sits in.
 */
export function fillRunRequest(req: TestRunRequest, values: Readonly<Record<string, string>>): { request: TestRunRequest; missing: string[] } {
  const missing = new Set<string>();
  const fill = (s: string, encode: (v: string) => string, gaps: Set<string>) =>
    s.replace(PLACEHOLDER_RE, (all, name: string) => {
      const v = values[name];
      if (v === undefined || v === '') {
        gaps.add(name);
        return all;
      }
      return encode(v);
    });
  const json = req.headers.some((h) => h.name.toLowerCase() === 'content-type' && isJsonType(h.value));
  const headers = req.headers.flatMap((h) => {
    const gaps = new Set<string>();
    const value = fill(h.value, (v) => v, gaps);
    return gaps.size ? [] : [{ name: h.name, value }];
  });
  const url = fill(req.url, encodeURIComponent, missing);
  const body = req.body === null ? null : fill(req.body, json ? (v) => JSON.stringify(v).slice(1, -1) : (v) => v, missing);
  return { request: { method: req.method, url, headers, body }, missing: [...missing] };
}

/** `201` matches 201; `2XX` matches 200–299. */
function statusMatches(expect: string, status: number): boolean {
  const range = /^([1-5])XX$/iu.exec(expect.trim());
  return range ? Math.floor(status / 100) === Number(range[1]) : Number(expect) === status;
}

/** A name a run must not show the value of: a credential slot or anything named like a secret. */
export const isSecretName = (name: string) =>
  name.startsWith('secret.') || /token|secret|passw|pwd|api[_-]?key|session|cookie|credential/iu.test(name);

export type TestRunOutcome = 'pass' | 'fail' | 'error' | 'skipped' | 'not-run' | 'manual';

export interface TestRunResult {
  outcome: TestRunOutcome;
  status: number | null;
  durationMs: number | null;
  /** What this step captured, as text. */
  captures: Record<string, string>;
  /** Why it failed, errored or was skipped: a send error, a missing value, a capture the response lacked. */
  reason: string | null;
}

export interface TestRunResponse {
  status: number;
  headers: Array<{ name: string; value: string }>;
  body: string;
  /** The request's own time, when the sender knows it better than the wall clock (a proxy that waited out a rate limit). */
  durationMs?: number;
}

/** Sends one filled request. A throw is an `error` row, never the end of the run. */
export type TestRunSend = (key: string, target: TestRunTarget, request: TestRunRequest) => Promise<TestRunResponse>;

/** A run's case tally — a case that never passed or failed did not run. One count for the browser runner and the server's run record. */
export function testRunCounts(plan: TestRunPlan, results: Readonly<Record<string, TestRunResult>>): { passed: number; failed: number; notRun: number } {
  const counts = { passed: 0, failed: 0, notRun: 0 };
  for (const c of plan.cases) {
    const o = results[`case/${c.id}`]?.outcome;
    if (o === 'pass') counts.passed++;
    else if (o === 'fail' || o === 'error') counts.failed++;
    else counts.notRun++;
  }
  return counts;
}

/**
 * Result keys, one per row a runner shows: `setup/<id>`, `case/<caseId>`,
 * `case/<caseId>/setup/<id>`, `case/<caseId>/teardown/<id>`, `teardown/<id>`.
 */
export const testRunKey = {
  setup: (s: TestRunStep) => `setup/${s.id}`,
  case: (c: TestRunCase) => `case/${c.id}`,
  caseSetup: (c: TestRunCase, s: TestRunStep) => `case/${c.id}/setup/${s.id}`,
  caseTeardown: (c: TestRunCase, s: TestRunStep) => `case/${c.id}/teardown/${s.id}`,
  teardown: (s: TestRunStep) => `teardown/${s.id}`,
};

const outcomeOf = (outcome: TestRunOutcome, reason: string | null = null): TestRunResult => ({
  outcome,
  status: null,
  durationMs: null,
  captures: {},
  reason,
});

/**
 * Walk a plan: suite setup (a failed step stops every case), each case
 * between its own setup and teardown with its captures shadowed, then the
 * suite's teardown — always, after a failure or `signal` too. A teardown
 * step whose values were never captured is skipped, not sent with a hole.
 * `onResult` fires as each row settles; the map it fills is also returned.
 */
export async function runTestPlan(
  plan: TestRunPlan,
  values: Readonly<Record<string, string>>,
  send: TestRunSend,
  onResult: (key: string, result: TestRunResult) => void = () => undefined,
  signal?: AbortSignal,
): Promise<Map<string, TestRunResult>> {
  const results = new Map<string, TestRunResult>();
  const vars: Record<string, string> = { ...values };
  const settle = (key: string, r: TestRunResult) => {
    results.set(key, r);
    onResult(key, r);
    return r;
  };

  const sendOne = async (key: string, target: TestRunTarget, req: TestRunRequest, expect: string, capture: Record<string, string>, teardown: boolean) => {
    const { request, missing } = fillRunRequest(req, vars);
    if (missing.length) return settle(key, outcomeOf(teardown ? 'skipped' : 'error', `missing:${missing.join(',')}`));
    const started = Date.now();
    let res: TestRunResponse;
    try {
      res = await send(key, target, request);
    } catch (e) {
      return settle(key, { ...outcomeOf('error', (e as Error).message), durationMs: Date.now() - started });
    }
    const durationMs = res.durationMs ?? Date.now() - started;
    if (!statusMatches(expect, res.status)) return settle(key, { ...outcomeOf('fail'), status: res.status, durationMs });
    let body: unknown;
    try {
      body = JSON.parse(res.body);
    } catch {
      body = undefined;
    }
    const captures: Record<string, string> = {};
    for (const [name, raw] of Object.entries(capture)) {
      const rule = parseCaptureRule(raw);
      const v = rule ? evaluateCapture(rule, { headers: res.headers, body }) : undefined;
      if (v === undefined || v === null) return settle(key, { ...outcomeOf('fail', `capture:${name}`), status: res.status, durationMs, captures });
      captures[name] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    Object.assign(vars, captures);
    return settle(key, { outcome: 'pass', status: res.status, durationMs, captures, reason: null });
  };

  /** Steps in order; false once one fails, after which the rest are `not-run`. */
  const runSteps = async (steps: readonly TestRunStep[], key: (s: TestRunStep) => string): Promise<boolean> => {
    let ok = true;
    for (const s of steps) {
      if (!ok || signal?.aborted) {
        settle(key(s), outcomeOf('not-run'));
        ok = false;
      } else if (s.kind === 'manual') settle(key(s), outcomeOf('manual'));
      else ok = (await sendOne(key(s), s.target, s.request, s.expect, s.capture, false)).outcome === 'pass';
    }
    return ok;
  };
  const tearDown = async (steps: readonly TestRunCall[], key: (s: TestRunCall) => string) => {
    for (const s of steps) await sendOne(key(s), s.target, s.request, s.expect, s.capture, true);
  };

  let ok = await runSteps(plan.setup, testRunKey.setup);
  for (const c of plan.cases) {
    if (!ok || signal?.aborted) {
      for (const s of c.setup) settle(testRunKey.caseSetup(c, s), outcomeOf('not-run'));
      settle(testRunKey.case(c), outcomeOf('not-run'));
      for (const s of c.teardown) settle(testRunKey.caseTeardown(c, s), outcomeOf('not-run'));
      ok = false;
      continue;
    }
    const saved = Object.fromEntries(c.captures.map((k) => [k, vars[k]]));
    if (await runSteps(c.setup, (s) => testRunKey.caseSetup(c, s))) {
      await sendOne(testRunKey.case(c), c.target, c.request, c.expect, {}, false);
    } else {
      settle(testRunKey.case(c), outcomeOf('not-run', 'setup'));
    }
    await tearDown(c.teardown, (s) => testRunKey.caseTeardown(c, s));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete vars[k];
      else vars[k] = v;
    }
  }
  await tearDown(plan.teardown, testRunKey.teardown);
  return results;
}

/** One server run (#483, phase 5): the plan it walked and each row's result. Captures named like secrets are never stored. */
export interface ApiTestRunDetail extends ApiTestRunSummary {
  plan: TestRunPlan;
  results: Record<string, TestRunResult>;
}
