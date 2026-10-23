import {
  curlArgs,
  fullUrl,
  isJsonType,
  sampleRequestFor,
  type SampleRequest,
  type SampleText,
} from '@knowledge/contracts/api/samples';
import {
  isCallStep,
  parseCaptureRule,
  parsePlaceholder,
  type FixtureCallStep,
  type FixtureScalar,
  type TestFixture,
} from '@knowledge/contracts/api/fixtures';
import type { ApiTestCase } from '@knowledge/contracts/api/test-cases';

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
