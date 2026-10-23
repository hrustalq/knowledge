import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  evaluateCapture,
  fixtureCallKey,
  fixtureRunValues,
  isApiSpecKind,
  isStructuredKind,
  literalCredentialIssues,
  parseCaptureRule,
  readTestFixture,
  resolvePlaceholders,
  structuredContentType,
  type FixtureCallStep,
} from '@knowledge/contracts';
import { ApiFixturesService, renderFixtureProjection } from '../src/api-specs/api-fixtures.service.js';
import { systemScope } from '../src/permissions/access-scope.js';
import { WRITE_TOOLS } from '../src/mcp/mcp-tools.js';
import { boundCaptures, readTesterRanking } from '../src/agents/tester.js';

/** QA test fixtures (#483, phase 1): the kind, the shape check, captures, credentials, and the finalize check. */

const INVOICE = {
  fixture: 1,
  description: 'A draft invoice owned by a logged-in admin.',
  inputs: { currency: 'EUR' },
  steps: [
    {
      id: 'login',
      call: 'op:auth-api:post /sessions',
      request: { body: { email: '{{input.qaEmail}}', password: '{{secret.qaPassword}}' } },
      expect: 201,
      capture: { TOKEN: '$.accessToken' },
    },
    {
      id: 'invoice',
      call: 'op:billing:POST /invoices',
      request: {
        headers: { Authorization: 'Bearer {{TOKEN}}' },
        body: { amount: 100, currency: '{{input.currency}}' },
      },
      expect: 201,
      capture: { invoiceId: '$.id', invoiceUrl: 'header:Location' },
    },
    { id: 'merchant', manual: 'A merchant with KYC approved exists.' },
  ],
  teardown: [
    { call: 'op:billing:DELETE /invoices/{id}', request: { path: { id: '{{invoiceId}}' }, headers: { Authorization: 'Bearer {{TOKEN}}' } } },
  ],
};

describe('the test-fixture kind', () => {
  it('is structured but not a spec, and has its own content type', () => {
    expect(isApiSpecKind('test-fixture')).toBe(false);
    expect(isStructuredKind('test-fixture')).toBe(true);
    expect(isStructuredKind('openapi')).toBe(true);
    expect(isStructuredKind('page')).toBe(false);
    expect(structuredContentType('test-fixture', 'json')).toBe('application/vnd.knowledge.test-fixture+json');
    expect(structuredContentType('openapi', 'yaml')).toBe('application/vnd.oai.openapi+yaml');
  });
});

describe('readTestFixture', () => {
  it('reads a cross-spec login, a body and a header capture, a manual step and a teardown', () => {
    const { fixture, issues } = readTestFixture(INVOICE);
    expect(issues).toEqual([]);
    expect(fixture!.steps).toHaveLength(3);
    expect(fixture!.teardown[0]).toMatchObject({ id: 'teardown-1', call: 'op:billing:delete-/invoices/{}' });
    expect(fixtureRunValues(fixture!)).toEqual({ inputs: ['currency', 'qaEmail'], secrets: ['qaPassword'] });
  });

  it('refuses a variable used before a step captures it, naming the step', () => {
    const body = structuredClone(INVOICE);
    delete (body.steps[1] as { capture?: unknown }).capture;
    const { fixture, issues } = readTestFixture(body);
    expect(fixture).toBeNull();
    expect(issues).toContainEqual(expect.objectContaining({ code: 'undefined-variable', step: 'teardown-1', params: { name: 'invoiceId' } }));
  });

  it('does not let a step use its own capture', () => {
    const { issues } = readTestFixture({
      fixture: 1,
      steps: [{ id: 'a', call: 'op:x:GET /a/{id}', request: { path: { id: '{{id}}' } }, capture: { id: '$.id' } }],
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'undefined-variable', step: 'a' }));
  });

  it('refuses duplicate ids, bad keys, bad rules and a missing version', () => {
    const { issues } = readTestFixture({
      steps: [
        { id: 'a', call: 'GET /a' },
        { id: 'a', call: 'op:x:GET /b', capture: { bad: 'body.id', input: '$.x' }, expect: 42 },
      ],
    });
    expect(issues.map((i) => i.code).sort()).toEqual(
      ['call-invalid', 'capture-name', 'capture-rule', 'duplicate-id', 'expect-invalid', 'version'].sort(),
    );
  });

  it('refuses manual steps in teardown and an empty fixture', () => {
    expect(readTestFixture({ fixture: 1, steps: [{ id: 'a', manual: 'x' }], teardown: [{ manual: 'clean up' }] }).issues).toContainEqual(
      expect.objectContaining({ code: 'step-shape', path: 'teardown[0]' }),
    );
    expect(readTestFixture({ fixture: 1, steps: [] }).issues[0].code).toBe('steps-missing');
    expect(readTestFixture('nope').issues[0].code).toBe('not-object');
  });

  it('folds operation keys however the call is spelled', () => {
    expect(fixtureCallKey('op:Billing:post  /invoices/{invoiceId}/')).toBe('op:billing:post-/invoices/{}');
    expect(fixtureCallKey('op:billing:post-/invoices')).toBe('op:billing:post-/invoices');
    expect(fixtureCallKey('billing POST /invoices')).toBeNull();
  });
});

describe('captures and placeholders', () => {
  const res = { headers: [{ name: 'location', value: '/invoices/inv_1' }], body: { id: 'inv_1', items: [{ id: 7 }], 'odd key': true } };

  it('reads the JSONPath subset and headers case-insensitively', () => {
    expect(evaluateCapture(parseCaptureRule('$.id')!, res)).toBe('inv_1');
    expect(evaluateCapture(parseCaptureRule('$.items[0].id')!, res)).toBe(7);
    expect(evaluateCapture(parseCaptureRule("$['odd key']")!, res)).toBe(true);
    expect(evaluateCapture(parseCaptureRule('header:Location')!, res)).toBe('/invoices/inv_1');
    expect(evaluateCapture(parseCaptureRule('$.missing.deeper')!, res)).toBeUndefined();
    expect(parseCaptureRule('$.items[*]')).toBeNull();
    expect(parseCaptureRule('id')).toBeNull();
  });

  it('keeps a whole-placeholder value typed and leaves unknown names as written', () => {
    const lookup = (r: { kind: string; name: string }) => (r.kind === 'var' && r.name === 'n' ? 5 : undefined);
    expect(resolvePlaceholders({ a: '{{n}}', b: 'id-{{n}}', c: '{{missing}}' }, lookup)).toEqual({ a: 5, b: 'id-5', c: '{{missing}}' });
  });
});

describe('literal credentials', () => {
  const step = (headers: Record<string, string>, query: Record<string, string> = {}): FixtureCallStep => ({
    id: 's',
    call: 'op:x:get /a',
    request: { headers, query },
    expect: null,
    capture: {},
  });
  const slots = { headers: ['X-API-Key'], query: ['api_key'] };
  const flagged = (s: FixtureCallStep) => literalCredentialIssues(s, 'steps[0]', slots).map((i) => i.params?.name);

  it('allows a scheme word with a placeholder, refuses a literal token', () => {
    expect(flagged(step({ Authorization: 'Bearer {{secret.token}}' }))).toEqual([]);
    expect(flagged(step({ Authorization: 'Bearer {{TOKEN}}' }))).toEqual([]);
    expect(flagged(step({ Authorization: 'Bearer abc123' }))).toEqual(['Authorization']);
    expect(flagged(step({ authorization: 'Basic {{input.creds}}' }))).toEqual(['authorization']);
  });

  it('checks every cookie pair and the spec\'s API-key slots', () => {
    expect(flagged(step({ Cookie: 'sid={{secret.sid}}' }))).toEqual([]);
    expect(flagged(step({ Cookie: 'sid={{secret.sid}}; theme=dark' }))).toEqual(['Cookie']);
    expect(flagged(step({ 'x-api-key': 'k_live_1' }, { api_key: '{{secret.k}}' }))).toEqual(['x-api-key']);
    expect(flagged(step({}, { API_KEY: 'k' }))).toEqual(['API_KEY']);
    expect(flagged(step({ 'X-Trace': 'abc' }))).toEqual([]);
  });
});

describe('ApiFixturesService', () => {
  const OPS = [
    { entityKey: 'op:auth-api:post-/sessions', documentId: 'auth', revisionId: 'r-auth', specTitle: 'Auth', method: 'POST', path: '/sessions', summary: null, pointer: '/paths/~1sessions/post' },
    { entityKey: 'op:billing:post-/invoices', documentId: 'bill', revisionId: 'r-bill', specTitle: 'Billing', method: 'POST', path: '/invoices', summary: null, pointer: '/paths/~1invoices/post' },
    { entityKey: 'op:billing:delete-/invoices/{}', documentId: 'bill', revisionId: 'r-bill', specTitle: 'Billing', method: 'DELETE', path: '/invoices/{id}', summary: null, pointer: '/paths/~1invoices~1{id}/delete' },
  ];
  const BILLING = {
    openapi: '3.1.0',
    security: [{ key: [] }],
    components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Billing-Key' } } },
    paths: { '/invoices': { post: {} }, '/invoices/{id}': { delete: {} } },
  };
  function service(ops = OPS) {
    const reads = {
      search: vi.fn(async (_s: unknown, o: { entityKeys: string[] }) => ({ operations: ops.filter((op) => o.entityKeys.includes(op.entityKey)) })),
      spec: vi.fn(async (id: string) => ({ document: id === 'bill' ? BILLING : { openapi: '3.1.0', paths: {} } })),
    };
    const config = { get: vi.fn(() => 1_000_000) };
    return new ApiFixturesService({} as never, config as never, reads as never, {} as never);
  }
  const scope = systemScope('11111111-1111-4111-8111-111111111111');

  it('finalizes the invoice fixture', async () => {
    await expect(service().assertValid(JSON.stringify(INVOICE), scope)).resolves.toBeUndefined();
  });

  it('refuses a call no spec the author can open defines, with the step named', async () => {
    const err = await service(OPS.slice(1)).assertValid(JSON.stringify(INVOICE), scope).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const body = (err as BadRequestException).getResponse() as { issues: Array<{ code: string; step: string }> };
    expect(body.issues).toEqual([expect.objectContaining({ code: 'unknown-operation', step: 'login' })]);
  });

  it('refuses a literal in the operation\'s API-key header', async () => {
    const body = structuredClone(INVOICE);
    (body.steps[1] as { request: { headers: Record<string, string> } }).request.headers['X-Billing-Key'] = 'live_123';
    const { issues } = await service().check(JSON.stringify(body), scope);
    expect(issues).toEqual([expect.objectContaining({ code: 'literal-credential', step: 'invoice', params: { name: 'X-Billing-Key' } })]);
  });

  it('reads YAML and reports a syntax error as an issue', async () => {
    const yaml = 'fixture: 1\nsteps:\n  - id: a\n    manual: Seed a merchant.\n';
    expect((await service().check(yaml, scope)).issues).toEqual([]);
    expect(service().read('fixture: [1').issues[0].code).toBe('syntax');
  });

  it('projects steps, captures and placeholders, never a value', () => {
    const { fixture } = readTestFixture(INVOICE);
    const md = renderFixtureProjection('Draft invoice', fixture!, []);
    expect(md).toContain('### 2. invoice — op:billing:post-/invoices');
    expect(md).toContain('Captures `invoiceUrl` from `header:Location`');
    expect(md).toContain('{{secret.qaPassword}}');
    expect(md).toContain('## Teardown');
  });

  it('keeps the fixture tools read-only', () => {
    expect(WRITE_TOOLS.has('knowledge_list_test_fixtures')).toBe(false);
    expect(WRITE_TOOLS.has('knowledge_get_test_fixture')).toBe(false);
  });
});

/** Phase 2: bindings, what the tester is told, its ranking, and which suite tools write. */
describe('fixture bindings (#483, phase 2)', () => {
  const { fixture } = readTestFixture(INVOICE);
  const bound = (caseId: string | null) => ({
    binding: { caseId, fixtureId: 'f1', title: 'Draft invoice', headRevisionId: 'r1', contentHash: 'h', archived: false },
    fixture: { documentId: 'f1', title: 'Draft invoice', fixture: fixture! },
  });

  it('tells the tester what setup captures, per suite and per case, never teardown', () => {
    const { vars, captures } = boundCaptures([bound(null), bound('documented-error:404')]);
    expect(vars.suite).toEqual(Object.keys(Object.assign({}, ...fixture!.steps.map((s) => ('capture' in s ? s.capture : {})))));
    expect(vars.cases).toEqual({ 'documented-error:404': vars.suite });
    expect(captures.suite.every((c) => c.fixture === 'Draft invoice' && c.step !== 'teardown-1')).toBe(true);
  });

  it('keeps the ranking honest: known ids once, the rest appended unexplained', () => {
    const parsed = {
      ranking: [
        { documentId: 'b', explanation: 'Creates the invoice.' },
        { documentId: 'zzz', explanation: 'invented' },
        { documentId: 'b', explanation: 'again' },
      ],
    };
    expect(readTesterRanking(parsed, ['a', 'b'])).toEqual([
      { documentId: 'b', explanation: 'Creates the invoice.' },
      { documentId: 'a', explanation: null },
    ]);
    expect(readTesterRanking('nonsense', ['a'])).toEqual([{ documentId: 'a', explanation: null }]);
  });

  it('hides Generate and binding from read-only keys, not the reads', () => {
    expect(WRITE_TOOLS.has('knowledge_generate_test_suite')).toBe(true);
    expect(WRITE_TOOLS.has('knowledge_set_test_fixtures')).toBe(true);
    expect(WRITE_TOOLS.has('knowledge_get_test_suite')).toBe(false);
    expect(WRITE_TOOLS.has('knowledge_suggest_test_fixtures')).toBe(false);
    expect(WRITE_TOOLS.has('knowledge_get_test_run_plan')).toBe(false);
  });
});
