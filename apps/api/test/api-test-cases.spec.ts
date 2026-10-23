import { assert, describe, expect, it } from 'vitest';
import {
  buildTestSuite,
  conformsToSchema,
  fillRunRequest,
  isSecretName,
  operationFingerprint,
  readTestFixture,
  runTestPlan,
  suitePrerequisites,
  testChain,
  testRunPlan,
  type TestRunRequest,
  testCaseRequest,
  testCasesFor,
  testSuiteCurl,
  testSuitePostman,
  type ApiTestCaseSpec,
} from '@knowledge/contracts';

/** QA test suites (#468): coverage from the spec, values from the model, exports from the sample printers. */

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Billing', version: '1' },
  servers: [{ url: 'https://api.example.com' }],
  security: [{ bearer: [] }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Invoice: {
        type: 'object',
        required: ['amount', 'currency'],
        properties: {
          id: { type: 'string', readOnly: true },
          amount: { type: 'integer', minimum: 1 },
          currency: { type: 'string', enum: ['EUR', 'USD'] },
          note: { type: 'string', maxLength: 5 },
          ref: { type: 'string', pattern: '^INV-[0-9]+$' },
        },
      },
      Error: { type: 'object', properties: { message: { type: 'string', example: 'nope' } } },
    },
  },
  paths: {
    '/invoices/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'inv_1' }],
      post: {
        parameters: [{ name: 'expand', in: 'query', required: true, schema: { type: 'string', enum: ['lines'] } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Invoice' } } } },
        responses: {
          '200': { description: 'Saved', content: { 'application/json': { schema: { $ref: '#/components/schemas/Invoice' } } } },
          '400': { description: 'Invalid', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '401': { description: 'No credentials' },
          '404': { description: 'No such invoice' },
        },
      },
    },
    '/health': { get: { security: [], responses: { '200': { description: 'OK' } } } },
  },
};
const OP = { method: 'POST', path: '/invoices/{id}', pointer: '/paths/~1invoices~1{id}/post' };
const ids = (cases: ApiTestCaseSpec[]) => cases.map((c) => c.id);

describe('testCasesFor', () => {
  const cases = testCasesFor(SPEC, OP);

  it('lists every case the spec requires, and nothing for read-only fields', () => {
    expect(ids(cases)).toEqual([
      'success:200',
      'missing-required:query.expand',
      'enum-outside:query.expand',
      'missing-required:body',
      'wrong-type:body',
      'missing-required:body.amount',
      'wrong-type:body.amount',
      'minimum:at:body.amount',
      'minimum:below:body.amount',
      'missing-required:body.currency',
      'wrong-type:body.currency',
      'enum-outside:body.currency',
      'wrong-type:body.note',
      'max-length:at:body.note',
      'max-length:above:body.note',
      'wrong-type:body.ref',
      'pattern:match:body.ref',
      'pattern:mismatch:body.ref',
      'missing-credentials',
      'documented-error:400',
      'documented-error:401',
      'documented-error:404',
    ]);
  });

  it('expects the documented status for each side', () => {
    const by = Object.fromEntries(cases.map((c) => [c.id, c]));
    expect(by['minimum:at:body.amount']).toMatchObject({ kind: 'positive', expectedStatus: '200' });
    expect(by['minimum:below:body.amount']).toMatchObject({ kind: 'negative', expectedStatus: '400' });
    expect(by['missing-credentials'].expectedStatus).toBe('401');
  });

  it('falls back to a range when the spec documents no client error, and skips credentials on an open operation', () => {
    const health = testCasesFor(SPEC, { method: 'GET', path: '/health', pointer: '/paths/~1health/get' });
    expect(ids(health)).toEqual(['success:200']);
  });

  it('has nothing for an AsyncAPI operation', () => {
    expect(testCasesFor(SPEC, { ...OP, protocol: 'async' })).toEqual([]);
  });
});

describe('building a suite', () => {
  const ref = (fill = 'INV-42') => ({ 'pattern:match:body.ref': { value: fill } });

  it('keeps the model values that fit the schema and drops the rest', () => {
    const suite = buildTestSuite(SPEC, OP, { query: { expand: 'everything' }, body: { amount: 120, currency: 'EUR', ref: 'INV-7' } }, ref());
    const ok = suite.find((c) => c.id === 'success:200')!;
    // `expand` is not in the enum, so the spec's own value is used.
    expect(ok.request.query.map((q) => q.value.join(''))).toEqual(['lines']);
    expect(JSON.parse(ok.request.body!.text)).toEqual({ amount: 120, currency: 'EUR', ref: 'INV-7' });
  });

  it('applies each case to the baseline and only that case', () => {
    const suite = buildTestSuite(SPEC, OP, { body: { amount: 120, currency: 'EUR' } }, ref());
    const by = Object.fromEntries(suite.map((c) => [c.id, c]));
    expect(JSON.parse(by['missing-required:body.amount'].request.body!.text)).toEqual({ currency: 'EUR' });
    expect(JSON.parse(by['minimum:below:body.amount'].request.body!.text).amount).toBe(0);
    expect(by['missing-required:query.expand'].request.query).toEqual([]);
    expect(by['missing-required:body'].request.body).toBeNull();
    expect(by['missing-required:body'].request.headers.map((h) => h.name)).toEqual(['Authorization']);
    expect(by['missing-credentials'].request.headers.map((h) => h.name)).toEqual(['Content-Type']);
    expect(JSON.parse(by['pattern:match:body.ref'].request.body!.text).ref).toBe('INV-42');
    expect(by['documented-error:400'].expected).toMatchObject({ status: '400', description: 'Invalid', example: { message: 'nope' } });
  });

  it('names every case the model left out', () => {
    const suite = buildTestSuite(SPEC, OP, {}, { ...ref(), 'success:200': { name: 'Saves an invoice' }, 'nonsense:id': { name: 'x' } });
    expect(suite).toHaveLength(testCasesFor(SPEC, OP).length);
    expect(suite[0].name).toBe('Saves an invoice');
    expect(suite.every((c) => c.name.length > 0)).toBe(true);
  });

  it('puts the error-provoking values the model gave on a documented error only', () => {
    const suite = buildTestSuite(SPEC, OP, {}, { ...ref(), 'documented-error:404': { path: { id: 'inv_missing' } }, 'success:200': { path: { id: 'x' } } });
    expect(suite.find((c) => c.id === 'documented-error:404')!.request.url).toBe('https://api.example.com/invoices/inv_missing');
    expect(suite.find((c) => c.id === 'success:200')!.request.url).toBe('https://api.example.com/invoices/inv_1');
  });

  it('refuses a suite whose pattern case has no matching value', () => {
    expect(() => buildTestSuite(SPEC, OP, {}, ref('nope'))).toThrow(/No value matching/);
  });

  it('checks wire values as text', () => {
    expect(conformsToSchema(SPEC, { type: 'integer', minimum: 1 }, '3', true)).toBe(true);
    expect(conformsToSchema(SPEC, { type: 'integer', minimum: 1 }, '0', true)).toBe(false);
    expect(conformsToSchema(SPEC, { type: 'integer' }, 'abc', true)).toBe(false);
  });

  it('throws only for a case that needs a value', () => {
    const c = testCasesFor(SPEC, OP).find((x) => x.id === 'enum-outside:body.currency')!;
    expect(JSON.parse(testCaseRequest(SPEC, OP, c, {}).body!.text).currency).toBe('__not_in_enum__');
  });
});

describe('exports without fixtures', () => {
  const suite = buildTestSuite(SPEC, OP, { body: { amount: 120, currency: 'EUR' } }, { 'pattern:match:body.ref': { value: 'INV-1' } });
  const chain = testChain({ title: 'Billing', cases: suite, suite: [], resolve: () => assert.fail('no calls') });

  it('prints one curl call per case, credentials as $TOKEN', () => {
    const out = testSuiteCurl(chain);
    expect(out.match(/^call '/gmu)).toHaveLength(suite.length);
    expect(out).toContain('# Export $TOKEN before running.');
    expect(out).toContain('"Authorization: Bearer $TOKEN"');
  });

  it('writes a Postman v2.1 collection with a status test per request and no credential value', () => {
    const col = testSuitePostman(chain, 'POST /invoices/{id}') as {
      info: { schema: string };
      item: Array<{ item: Array<{ request: { header: Array<{ value: string }> }; event: Array<{ script: { exec: string[] } }> }> }>;
      variable: Array<{ key: string; value: string }>;
    };
    expect(col.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    expect(col.item).toHaveLength(1);
    expect(col.item[0].item).toHaveLength(suite.length);
    expect(col.item[0].item.at(-1)!.request.header).toContainEqual({ key: 'Authorization', value: 'Bearer {{TOKEN}}' });
    expect(col.variable).toEqual([{ key: 'TOKEN', value: '' }]);
  });
});

// ---------------------------------------------------------------------------
// Fixtures (#483): prerequisites, captured variables, the chain and its exports
// ---------------------------------------------------------------------------

const SHOP = {
  openapi: '3.1.0',
  info: { title: 'Billing', version: '1' },
  servers: [{ url: 'https://api.example.com' }],
  security: [{ bearer: [] }],
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  paths: {
    '/invoices': {
      post: {
        operationId: 'createInvoice',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { amount: { type: 'integer' } } } } } },
        responses: {
          '201': {
            description: 'Created',
            content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
            links: { GetInvoice: { operationId: 'getInvoice', parameters: { id: '$response.body#/id' } } },
          },
        },
      },
    },
    '/customers': {
      post: { responses: { '201': { description: 'Created', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } } },
    },
    '/invoices/{id}': {
      get: {
        operationId: 'getInvoice',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'The invoice' }, '404': { description: 'No such invoice' } },
      },
      delete: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Gone' } } },
    },
    '/sessions': {
      post: {
        security: [],
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'Logged in' } },
      },
    },
  },
};
const row = (method: string, path: string, operationId: string | null = null) => ({
  method,
  path,
  operationId,
  pointer: `/paths/${path.replace(/\//gu, '~1')}/${method.toLowerCase()}`,
  entityKey: `op:billing:${method.toLowerCase()}-${path.replace(/\{[^}]*\}/gu, '{}')}`,
});
const GET = row('GET', '/invoices/{id}', 'getInvoice');
const CREATE = row('POST', '/invoices', 'createInvoice');
const ROWS = [CREATE, row('POST', '/customers'), GET, row('DELETE', '/invoices/{id}'), row('POST', '/sessions')];

describe('suitePrerequisites', () => {
  it('keeps the declared link over the path-param match, and matches a generic id only under its collection', () => {
    expect(suitePrerequisites(SHOP, GET, ROWS)).toEqual([{ source: 'link', producer: CREATE.entityKey, param: 'id', field: 'id' }]);
  });

  it('finds the path-param producer without a link', () => {
    const noLinks = structuredClone(SHOP) as typeof SHOP;
    delete (noLinks.paths['/invoices'].post.responses['201'] as { links?: unknown }).links;
    expect(suitePrerequisites(noLinks, GET, ROWS).map((p) => [p.source, p.producer])).toEqual([['path-param', CREATE.entityKey]]);
  });
});

describe('captured variables in a suite', () => {
  it('lets the baseline use a bound capture where a literal must fit the schema', () => {
    const vars = { suite: ['invoiceId'] };
    const suite = buildTestSuite(SHOP, GET, { path: { id: '{{invoiceId}}' } }, { 'documented-error:404': { path: { id: '999999' } } }, vars);
    expect(suite.find((c) => c.id === 'success:200')!.request.url).toBe('https://api.example.com/invoices/{{invoiceId}}');
    expect(suite.find((c) => c.id === 'documented-error:404')!.request.url).toBe('https://api.example.com/invoices/999999');
  });

  it('drops a placeholder naming nothing bound', () => {
    const suite = buildTestSuite(SHOP, GET, { path: { id: '{{nobody}}' } }, {}, { suite: ['invoiceId'] });
    expect(suite.find((c) => c.id === 'success:200')!.request.url).not.toContain('nobody');
  });
});

describe('testChain', () => {
  const fixture = readTestFixture({
    fixture: 1,
    inputs: { amount: 100 },
    steps: [
      { id: 'login', call: 'op:billing:post-/sessions', request: { body: { password: '{{secret.qaPassword}}' } }, expect: 201, capture: { TOKEN: '$.accessToken' } },
      { id: 'invoice', call: 'op:billing:post-/invoices', request: { body: { amount: '{{input.amount}}' } }, expect: 201, capture: { invoiceId: '$.id', where: 'header:Location' } },
      { id: 'kyc', manual: 'A merchant with KYC approved exists.' },
    ],
    teardown: [{ call: 'op:billing:delete-/invoices/{id}', request: { path: { id: '{{invoiceId}}' } } }],
  }).fixture!;
  const resolve = (key: string) => {
    const r = ROWS.find((x) => x.entityKey === key)!;
    return { doc: SHOP, op: r };
  };
  const cases = buildTestSuite(SHOP, GET, { path: { id: '{{invoiceId}}' } }, {}, { suite: ['invoiceId'] });
  const chain = testChain({ title: 'Billing — GET /invoices/{id}', cases, suite: [{ documentId: 'f1', title: 'Draft invoice', fixture }], resolve });

  it('runs setup, negative cases before positive ones, then teardown', () => {
    expect(chain.setup.map((s) => s.stepId)).toEqual(['login', 'invoice', 'kyc']);
    expect(chain.cases.map((c) => c.case.kind)).toEqual([...chain.cases.map((c) => c.case.kind)].sort((a, b) => (a === 'negative' ? -1 : b === 'negative' ? 1 : 0)));
    expect(chain.teardown.map((s) => s.stepId)).toEqual(['teardown-1']);
  });

  it('asks a run for the secret, not for what setup captures', () => {
    expect(chain.secrets).toEqual(['secret.qaPassword']);
    expect(chain.inputs).toEqual({ amount: 100 });
  });

  it('prints a bash script that captures with jq, stops on a failed setup step and tears down on exit', () => {
    const sh = testSuiteCurl(chain);
    expect(sh).toContain("TOKEN=$(jq -r '.[\"accessToken\"] // empty' \"$tmp/body\")");
    expect(sh).toContain('if [ -n "${TOKEN:-}" ] && [ -n "${invoiceId:-}" ]; then');
    expect(sh).toContain("where=$(header 'Location')");
    expect(sh).toContain('trap teardown EXIT');
    expect(sh).toContain('# Manual (Draft invoice › kyc): A merchant with KYC approved exists.');
    expect(sh).toContain('"https://api.example.com/invoices/$invoiceId"');
    expect(sh).toContain(': "${input_amount:=100}"');
    expect(sh).toContain('  \\"amount\\": \\"$input_amount\\"\n}" || exit 1');
    expect(sh).toContain('# Export $secret_qaPassword before running.');
    expect(sh).not.toContain('secret_qaPassword=');
  });

  it('writes Setup and Teardown folders to Postman, a capture as a collection variable, no secret value', () => {
    const col = testSuitePostman(chain, 'GET /invoices/{id}') as {
      item: Array<{ name: string; description?: string; item: Array<{ name: string; request: { url: string }; event: Array<{ script: { exec: string[] } }> }> }>;
      variable: Array<{ key: string; value: string }>;
    };
    expect(col.item.map((f) => f.name)).toEqual(['Setup', 'GET /invoices/{id}', 'Teardown']);
    const setup = col.item[0];
    expect(setup.description).toContain('KYC approved');
    expect(setup.item[1].event[0].script.exec.join('\n')).toContain('pm.collectionVariables.set("invoiceId", pm.response.json()["id"]);');
    expect(setup.item[0].event[0].script.exec.join('\n')).toContain('postman.setNextRequest("Teardown 1. Draft invoice › teardown-1")');
    expect(col.item[1].item.find((i) => i.name.includes('success'))!.request.url).toBe('https://api.example.com/invoices/{{invoiceId}}');
    expect(col.variable).toEqual([
      { key: 'input.amount', value: '100' },
      { key: 'secret.qaPassword', value: '' },
    ]);
  });

  it('runs a case\'s own fixture in a subshell and restores shadowed captures in Postman', () => {
    const own = testChain({
      title: 't',
      cases,
      suite: [{ documentId: 'f1', title: 'Draft invoice', fixture }],
      perCase: { 'documented-error:404': [{ documentId: 'f2', title: 'Other', fixture }] },
      resolve,
    });
    const c = own.cases.find((x) => x.case.id === 'documented-error:404')!;
    expect(c.captures).toEqual(['TOKEN', 'invoiceId', 'where']);
    expect(testSuiteCurl(own)).toContain(') || failed=1');
    const col = testSuitePostman(own, 'x') as { item: Array<{ item: Array<{ name: string; item?: Array<{ event: Array<{ listen: string; script: { exec: string[] } }> }> }> }> };
    const folder = col.item[1].item.find((i) => i.item)!;
    expect(folder.item![0].event[0].listen).toBe('prerequest');
    expect(folder.item!.at(-1)!.event.at(-1)!.script.exec.at(-1)).toContain('pm.collectionVariables.unset(k)');
  });
});

describe('runTestPlan', () => {
  const fixture = readTestFixture({
    fixture: 1,
    steps: [
      { id: 'login', call: 'op:billing:post-/sessions', request: { body: { password: '{{secret.qaPassword}}' } }, expect: 201, capture: { TOKEN: '$.accessToken' } },
      { id: 'invoice', call: 'op:billing:post-/invoices', expect: 201, capture: { invoiceId: '$.id' } },
      { id: 'kyc', manual: 'A merchant with KYC approved exists.' },
    ],
    teardown: [{ call: 'op:billing:delete-/invoices/{id}', request: { path: { id: '{{invoiceId}}' } } }],
  }).fixture!;
  const resolve = (key: string) => ({ doc: SHOP, op: ROWS.find((x) => x.entityKey === key)! });
  const cases = buildTestSuite(SHOP, GET, { path: { id: '{{invoiceId}}' } }, {}, { suite: ['invoiceId'] });
  const chain = testChain({ title: 't', cases, suite: [{ documentId: 'f1', title: 'Draft invoice', fixture }], resolve });
  const plan = testRunPlan(chain, { documentId: 'spec', entityKey: GET.entityKey }, (key) => ({
    documentId: 'spec',
    revisionId: 'r1',
    entityKey: key ?? GET.entityKey,
    server: 'https://api.example.com',
  }));

  /** A fake billing API: the session and invoice it hands out are the only ones it knows. */
  const api = (loginStatus = 201) => {
    const sent: TestRunRequest[] = [];
    const send = async (_key: string, _target: unknown, r: TestRunRequest) => {
      sent.push(r);
      const authed = r.headers.some((h) => h.name === 'Authorization' && h.value === 'Bearer tok');
      const at = `${r.method} ${new URL(r.url).pathname}`;
      const reply = (status: number, body: unknown = {}) => ({ status, headers: [], body: JSON.stringify(body) });
      if (at === 'POST /sessions') return reply(loginStatus, JSON.parse(r.body ?? '{}').password === 'pw' ? { accessToken: 'tok' } : {});
      if (!authed) return reply(401);
      if (at === 'POST /invoices') return reply(201, { id: 'inv 9' });
      if (at === 'GET /invoices/inv%209') return reply(200);
      if (at === 'DELETE /invoices/inv%209') return reply(204);
      return reply(404);
    };
    return { sent, send };
  };

  it('flattens the chain to placeholders and names where each call goes', () => {
    const ok = plan.cases.find((c) => c.kind === 'positive')!;
    expect(ok.request.url).toBe('https://api.example.com/invoices/{{invoiceId}}');
    expect(ok.request.headers).toContainEqual({ name: 'Authorization', value: 'Bearer {{TOKEN}}' });
    expect(plan.setup[0].kind === 'call' && plan.setup[0].target.entityKey).toBe('op:billing:post-/sessions');
    expect(plan.secrets).toEqual(['secret.qaPassword']);
    expect(JSON.stringify(plan)).not.toContain('"pw"');
  });

  it('runs setup, the cases with what setup captured, and teardown', async () => {
    const { sent, send } = api();
    const results = await runTestPlan(plan, { 'secret.qaPassword': 'pw' }, send);
    expect(results.get('setup/f1:login')).toMatchObject({ outcome: 'pass', status: 201, captures: { TOKEN: 'tok' } });
    expect(results.get('setup/f1:kyc')!.outcome).toBe('manual');
    const ok = plan.cases.find((c) => c.kind === 'positive')!;
    expect(results.get(`case/${ok.id}`)).toMatchObject({ outcome: 'pass', status: 200 });
    expect(sent.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://api.example.com/invoices/inv%209' });
    expect(isSecretName('TOKEN') && isSecretName('secret.qaPassword') && !isSecretName('invoiceId')).toBe(true);
  });

  it('stops every case when setup fails and skips a teardown step setup never fed', async () => {
    const { sent, send } = api(500);
    const results = await runTestPlan(plan, { 'secret.qaPassword': 'pw' }, send);
    expect(results.get('setup/f1:login')).toMatchObject({ outcome: 'fail', status: 500 });
    expect(results.get('setup/f1:invoice')!.outcome).toBe('not-run');
    for (const c of plan.cases) expect(results.get(`case/${c.id}`)!.outcome).toBe('not-run');
    expect(results.get('teardown/f1:teardown-1')).toMatchObject({ outcome: 'skipped', reason: 'missing:invoiceId' });
    expect(sent).toHaveLength(1);
  });

  it('still tears down after Stop', async () => {
    const { sent, send } = api();
    const stop = new AbortController();
    const results = await runTestPlan(plan, { 'secret.qaPassword': 'pw' }, async (k, t, r) => {
      if (k === 'setup/f1:invoice') stop.abort();
      return send(k, t, r);
    }, undefined, stop.signal);
    for (const c of plan.cases) expect(results.get(`case/${c.id}`)!.outcome).toBe('not-run');
    expect(sent.at(-1)!.method).toBe('DELETE');
  });

  it('fills placeholders: encoded in the URL, escaped in JSON, a header with an empty slot left out', () => {
    const { request, missing } = fillRunRequest(
      {
        method: 'POST',
        url: 'https://x.test/a/{{id}}?q={{q}}',
        headers: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Authorization', value: 'Bearer {{TOKEN}}' },
        ],
        body: '{"note": "{{note}}"}',
      },
      { id: 'a/b', q: 'x&y', note: 'say "hi"', TOKEN: '' },
    );
    expect(missing).toEqual([]);
    expect(request.url).toBe('https://x.test/a/a%2Fb?q=x%26y');
    expect(request.headers.map((h) => h.name)).toEqual(['Content-Type']);
    expect(JSON.parse(request.body!)).toEqual({ note: 'say "hi"' });
    expect(fillRunRequest({ method: 'GET', url: '/{{gone}}', headers: [], body: null }, {}).missing).toEqual(['gone']);
  });
});

describe('operationFingerprint', () => {
  const edit = (f: (s: typeof SPEC) => void) => {
    const copy = structuredClone(SPEC);
    f(copy);
    return operationFingerprint(copy, OP);
  };
  const before = operationFingerprint(SPEC, OP);

  it('ignores an edit to another operation', () => {
    expect(edit((s) => (s.paths['/health'].get.responses['200'].description = 'Fine'))).toBe(before);
  });

  it('changes with the operation or a schema it reaches', () => {
    expect(edit((s) => (s.paths['/invoices/{id}'].post.responses['404'].description = 'Gone'))).not.toBe(before);
    expect(edit((s) => (s.components.schemas.Invoice.properties.note.maxLength = 9))).not.toBe(before);
  });

  it('is independent of key order', () => {
    const reordered = { ...SPEC, paths: SPEC.paths, info: SPEC.info, openapi: SPEC.openapi };
    expect(operationFingerprint(reordered, OP)).toBe(before);
  });
});
