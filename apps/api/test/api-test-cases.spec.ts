import { describe, expect, it } from 'vitest';
import {
  buildTestSuite,
  conformsToSchema,
  operationFingerprint,
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

describe('exports', () => {
  const suite = buildTestSuite(SPEC, OP, { body: { amount: 120, currency: 'EUR' } }, { 'pattern:match:body.ref': { value: 'INV-1' } });

  it('prints one curl command per case, credentials as $TOKEN', () => {
    const out = testSuiteCurl(suite);
    expect(out.match(/^curl /gmu)).toHaveLength(suite.length);
    expect(out).toContain('# Set $TOKEN before running.');
    expect(out).toContain('"Authorization: Bearer $TOKEN"');
  });

  it('writes a Postman v2.1 collection with a status test per request and no credential value', () => {
    const col = testSuitePostman({ title: 'Billing — test requests', folder: 'POST /invoices/{id}', cases: suite }) as {
      info: { schema: string };
      item: Array<{ item: Array<{ request: { header: Array<{ value: string }> }; event: Array<{ script: { exec: string[] } }> }> }>;
      variable: Array<{ key: string; value: string }>;
    };
    expect(col.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    expect(col.item[0].item).toHaveLength(suite.length);
    expect(col.item[0].item[0].request.header).toContainEqual({ key: 'Authorization', value: 'Bearer {{token}}' });
    expect(col.item[0].item[0].event[0].script.exec[0]).toContain('pm.response.to.have.status(200)');
    expect(col.variable).toEqual([{ key: 'token', value: '' }]);
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
