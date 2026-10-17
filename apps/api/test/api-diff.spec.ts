import { afterAll, describe, expect, it } from 'vitest';
import { API_CHANGE_RULE_IDS, API_CHANGE_RULES, type ApiChangeRule, type ApiSpecChange } from '@knowledge/contracts';
import { diffApiSpecs } from '../src/api-specs/api-diff.js';
import { parseApiSpec } from '../src/api-specs/api-spec.parser.js';

const LIMITS = { maxBytes: 5_000_000, maxOperations: 2000 };

type Spec = Record<string, any>;

/** A small shop API: a path parameter, query + header params, a body, a recursive schema, two statuses. */
function shop(): Spec {
  return {
    openapi: '3.0.3',
    info: { title: 'Shop', version: '1' },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, apiKey: { type: 'apiKey', in: 'header', name: 'X-Key' } },
      schemas: {
        Node: {
          type: 'object',
          properties: { id: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } },
        },
      },
    },
    paths: {
      '/orders/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          operationId: 'getOrder',
          parameters: [
            { name: 'expand', in: 'query', schema: { type: 'string', enum: ['items', 'customer'] } },
            { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'The order',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { id: { type: 'string' }, total: { type: 'number' }, tree: { $ref: '#/components/schemas/Node' } },
                  },
                },
              },
            },
            '404': { description: 'Not found' },
          },
        },
        delete: { operationId: 'deleteOrder', responses: { '204': { description: 'Gone' } } },
      },
      '/orders': {
        post: {
          operationId: 'createOrder',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['sku'],
                  properties: {
                    sku: { type: 'string' },
                    note: { type: 'string' },
                    kind: { type: 'string', enum: ['retail', 'wholesale'] },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'Created' } },
        },
      },
    },
  };
}

function events(): Spec {
  return {
    asyncapi: '2.6.0',
    info: { title: 'Events', version: '1' },
    channels: {
      'user/signedup': {
        subscribe: {
          message: { payload: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' } } } },
        },
      },
      'user/deleted': { subscribe: { message: { payload: { type: 'object', properties: { id: { type: 'string' } } } } } },
    },
  };
}

const seen = new Set<ApiChangeRule>();

async function diff(before: Spec | null, after: Spec, kind: 'openapi' | 'asyncapi' = 'openapi') {
  const parse = (s: Spec) => parseApiSpec(JSON.stringify(s), kind, LIMITS);
  const result = diffApiSpecs(before ? await parse(before) : null, await parse(after), 'shop');
  for (const c of result.changes) seen.add(c.rule);
  return result;
}

function edit(base: Spec, mutate: (s: Spec) => void): Spec {
  const copy = structuredClone(base);
  mutate(copy);
  return copy;
}

const rules = (changes: ApiSpecChange[]) => changes.map((c) => c.rule);
const getOrder = (s: Spec) => s.paths['/orders/{id}'].get;
const createBody = (s: Spec) => s.paths['/orders'].post.requestBody.content['application/json'].schema;

describe('diffApiSpecs — what is not a change', () => {
  it('an unchanged spec, recursive schema included, has no changes', async () => {
    const { changes, summary } = await diff(shop(), shop());
    expect(changes).toEqual([]);
    expect(summary).toEqual({ breaking: 0, nonBreaking: 0, info: 0 });
  });

  it('reordering parameters is no change', async () => {
    const after = edit(shop(), (s) => getOrder(s).parameters.reverse());
    expect((await diff(shop(), after)).changes).toEqual([]);
  });

  it('renaming a path parameter keeps the same operation', async () => {
    const after = edit(shop(), (s) => {
      const item = s.paths['/orders/{id}'];
      item.parameters[0].name = 'orderId';
      s.paths['/orders/{orderId}'] = item;
      delete s.paths['/orders/{id}'];
    });
    expect((await diff(shop(), after)).changes).toEqual([]);
  });

  it('header names compare case-insensitively', async () => {
    const after = edit(shop(), (s) => (getOrder(s).parameters[1].name = 'x-trace'));
    expect((await diff(shop(), after)).changes).toEqual([]);
  });

  it('a description edit is no change', async () => {
    const after = edit(shop(), (s) => (getOrder(s).summary = 'Read one order'));
    expect((await diff(shop(), after)).changes).toEqual([]);
  });
});

describe('diffApiSpecs — operations', () => {
  it('a removed operation is breaking, keyed and pointed at the old side', async () => {
    const after = edit(shop(), (s) => delete s.paths['/orders/{id}'].delete);
    const { changes, summary } = await diff(shop(), after);
    expect(changes).toEqual([
      expect.objectContaining({
        rule: 'operation-removed',
        severity: 'breaking',
        entityKey: 'op:shop:delete-/orders/{}',
        method: 'DELETE',
        path: '/orders/{id}',
        pointer: '/paths/~1orders~1{id}/delete',
        before: 'DELETE /orders/{id}',
      }),
    ]);
    expect(summary.breaking).toBe(1);
  });

  it('an added operation is non-breaking', async () => {
    const after = edit(shop(), (s) => (s.paths['/orders'].get = { responses: { '200': { description: 'All' } } }));
    expect(rules((await diff(shop(), after)).changes)).toEqual(['operation-added']);
  });

  it('a first revision adds every operation', async () => {
    const { changes, summary } = await diff(null, shop());
    expect(rules(changes)).toEqual(['operation-added', 'operation-added', 'operation-added']);
    expect(summary).toEqual({ breaking: 0, nonBreaking: 3, info: 0 });
  });

  it('deprecating an operation is info', async () => {
    const after = edit(shop(), (s) => (getOrder(s).deprecated = true));
    expect(rules((await diff(shop(), after)).changes)).toEqual(['operation-deprecated']);
  });
});

describe('diffApiSpecs — parameters', () => {
  it('a new required parameter is breaking, a new optional one is not', async () => {
    const after = edit(shop(), (s) => {
      getOrder(s).parameters.push({ name: 'tenant', in: 'query', required: true, schema: { type: 'string' } });
      getOrder(s).parameters.push({ name: 'fields', in: 'query', schema: { type: 'string' } });
    });
    const { changes } = await diff(shop(), after);
    expect(changes.map((c) => [c.rule, c.subject])).toEqual([
      ['required-param-added', 'query.tenant'],
      ['optional-param-added', 'query.fields'],
    ]);
  });

  it('a removed parameter is non-breaking', async () => {
    const after = edit(shop(), (s) => getOrder(s).parameters.pop());
    expect((await diff(shop(), after)).changes).toEqual([
      expect.objectContaining({ rule: 'param-removed', severity: 'non-breaking', subject: 'header.X-Trace' }),
    ]);
  });

  it('an optional parameter becoming required is breaking', async () => {
    const after = edit(shop(), (s) => (getOrder(s).parameters[0].required = true));
    expect(rules((await diff(shop(), after)).changes)).toEqual(['param-became-required']);
  });

  it('a parameter type change is breaking, including a path parameter matched by position', async () => {
    const after = edit(shop(), (s) => {
      getOrder(s).parameters[0].schema = { type: 'integer' };
      s.paths['/orders/{id}'].parameters[0].schema = { type: 'integer' };
    });
    const { changes } = await diff(shop(), after);
    expect(changes.filter((c) => c.method === 'GET').map((c) => [c.rule, c.subject, c.before, c.after])).toEqual([
      ['param-type-changed', 'query.expand', 'string', 'integer'],
      ['param-type-changed', 'path.id', 'string', 'integer'],
    ]);
  });

  it('a removed enum value on a parameter is breaking, an added one is info', async () => {
    const after = edit(shop(), (s) => (getOrder(s).parameters[0].schema.enum = ['items', 'lines']));
    const { changes } = await diff(shop(), after);
    expect(changes.map((c) => [c.rule, c.before, c.after])).toEqual([
      ['enum-value-removed', 'customer', null],
      ['enum-value-added', null, 'lines'],
    ]);
  });
});

describe('diffApiSpecs — request body', () => {
  it('a body becoming required is breaking', async () => {
    const after = edit(shop(), (s) => (s.paths['/orders'].post.requestBody.required = true));
    expect(rules((await diff(shop(), after)).changes)).toEqual(['request-body-required']);
  });

  it('a new required property, or an existing one becoming required, is breaking; a new optional one is not', async () => {
    const after = edit(shop(), (s) => {
      const body = createBody(s);
      body.properties.qty = { type: 'integer' };
      body.properties.gift = { type: 'boolean' };
      body.required.push('qty', 'note');
    });
    const { changes } = await diff(shop(), after);
    expect(changes.map((c) => [c.rule, c.subject])).toEqual([
      ['request-property-required-added', 'body.note'],
      ['request-property-required-added', 'body.qty'],
    ]);
  });

  it('a property type change is breaking', async () => {
    const after = edit(shop(), (s) => (createBody(s).properties.note = { type: 'integer' }));
    expect((await diff(shop(), after)).changes).toEqual([
      expect.objectContaining({ rule: 'property-type-changed', subject: 'body.note', before: 'string', after: 'integer' }),
    ]);
  });

  it('a nullable type (3.1 `[string, null]`) is the same type', async () => {
    const before = edit(shop(), (s) => (s.openapi = '3.1.0'));
    const after = edit(before, (s) => (createBody(s).properties.note = { type: ['string', 'null'] }));
    expect((await diff(before, after)).changes).toEqual([]);
  });

  it('a removed enum value in the body is breaking', async () => {
    const after = edit(shop(), (s) => (createBody(s).properties.kind.enum = ['retail']));
    expect((await diff(shop(), after)).changes).toEqual([
      expect.objectContaining({ rule: 'enum-value-removed', subject: 'body.kind', before: 'wholesale' }),
    ]);
  });

  it('folds allOf before comparing', async () => {
    const before = edit(shop(), (s) => {
      s.paths['/orders'].post.requestBody.content['application/json'].schema = {
        allOf: [{ type: 'object', properties: { sku: { type: 'string' } } }, { required: ['sku'] }],
      };
    });
    const after = edit(before, (s) => {
      s.paths['/orders'].post.requestBody.content['application/json'].schema.allOf.push({
        properties: { qty: { type: 'integer' } },
        required: ['qty'],
      });
    });
    expect((await diff(before, after)).changes.map((c) => [c.rule, c.subject])).toEqual([
      ['request-property-required-added', 'body.qty'],
    ]);
  });
});

describe('diffApiSpecs — responses', () => {
  it('a removed status is breaking, an added one is not', async () => {
    const after = edit(shop(), (s) => {
      delete getOrder(s).responses['404'];
      getOrder(s).responses['410'] = { description: 'Archived' };
    });
    const { changes } = await diff(shop(), after);
    expect(changes.map((c) => [c.rule, c.subject])).toEqual([
      ['response-status-removed', '404'],
      ['response-status-added', '410'],
    ]);
  });

  it('a removed response property is breaking, an added one is info, inside a recursive schema too', async () => {
    const after = edit(shop(), (s) => {
      const schema = getOrder(s).responses['200'].content['application/json'].schema;
      delete schema.properties.total;
      schema.properties.currency = { type: 'string' };
      s.components.schemas.Node.properties.label = { type: 'string' };
    });
    const { changes, summary } = await diff(shop(), after);
    // The dereferenced `tree` is a copy of Node whose `children` are Node
    // itself, so the walk meets the field once more one level down, then stops.
    expect(changes.map((c) => [c.rule, c.subject])).toEqual([
      ['response-property-removed', '200 body.total'],
      ['response-property-added', '200 body.currency'],
      ['response-property-added', '200 body.tree.label'],
      ['response-property-added', '200 body.tree.children[].label'],
    ]);
    expect(summary).toEqual({ breaking: 1, nonBreaking: 0, info: 3 });
  });
});

describe('diffApiSpecs — security', () => {
  it('requiring auth on an anonymous operation is breaking; dropping it is not', async () => {
    const secured = edit(shop(), (s) => (getOrder(s).security = [{ bearerAuth: [] }]));
    expect((await diff(shop(), secured)).changes).toEqual([
      expect.objectContaining({ rule: 'security-requirement-added', subject: 'bearerAuth', severity: 'breaking' }),
    ]);
    expect(rules((await diff(secured, shop())).changes)).toEqual(['security-requirement-removed']);
  });

  it('a new alternative scheme is not breaking; replacing the only one is', async () => {
    const bearer = edit(shop(), (s) => (s.security = [{ bearerAuth: [] }]));
    const either = edit(bearer, (s) => (s.security = [{ bearerAuth: [] }, { apiKey: [] }]));
    const key = edit(bearer, (s) => (s.security = [{ apiKey: [] }]));
    expect((await diff(bearer, either)).changes).toEqual([]);
    expect((await diff(bearer, key)).changes.map((c) => [c.rule, c.subject])).toEqual([
      ['security-requirement-added', 'apiKey'],
      ['security-requirement-added', 'apiKey'],
      ['security-requirement-added', 'apiKey'],
    ]);
  });
});

describe('diffApiSpecs — AsyncAPI', () => {
  it('a removed channel is one breaking change; an added one is non-breaking', async () => {
    const after = edit(events(), (s) => {
      delete s.channels['user/deleted'];
      s.channels['order/placed'] = { publish: { message: { payload: { type: 'object' } } } };
    });
    const { changes } = await diff(events(), after, 'asyncapi');
    expect(changes.map((c) => [c.rule, c.path])).toEqual([
      ['channel-removed', 'user/deleted'],
      ['channel-added', 'order/placed'],
    ]);
  });

  it('removing an action from a channel that stays is an operation removal', async () => {
    const before = edit(events(), (s) => (s.channels['user/deleted'].publish = { message: { payload: { type: 'object' } } }));
    expect(rules((await diff(before, events(), 'asyncapi')).changes)).toEqual(['operation-removed']);
  });

  it('a removed payload field is breaking, an added one is info', async () => {
    const after = edit(events(), (s) => {
      const payload = s.channels['user/signedup'].subscribe.message.payload;
      delete payload.properties.email;
      payload.properties.locale = { type: 'string' };
    });
    expect((await diff(events(), after, 'asyncapi')).changes.map((c) => [c.rule, c.subject])).toEqual([
      ['message-payload-field-removed', 'payload.email'],
      ['message-payload-field-added', 'payload.locale'],
    ]);
  });

  it('AsyncAPI 3.0: a removed channel and its operation are one change', async () => {
    const v3 = (withDeleted: boolean): Spec => ({
      asyncapi: '3.0.0',
      info: { title: 'Events', version: '1' },
      channels: {
        signedUp: { address: 'user/signedup', messages: { m: { payload: { type: 'object' } } } },
        ...(withDeleted ? { deleted: { address: 'user/deleted', messages: { m: { payload: { type: 'object' } } } } } : {}),
      },
      operations: {
        onSignedUp: { action: 'receive', channel: { $ref: '#/channels/signedUp' } },
        ...(withDeleted ? { onDeleted: { action: 'receive', channel: { $ref: '#/channels/deleted' } } } : {}),
      },
    });
    expect((await diff(v3(true), v3(false), 'asyncapi')).changes.map((c) => [c.rule, c.path])).toEqual([
      ['channel-removed', 'user/deleted'],
    ]);
  });
});

describe('diffApiSpecs — ordering and the catalogue', () => {
  it('lists breaking changes first', async () => {
    const after = edit(shop(), (s) => {
      getOrder(s).deprecated = true;
      s.paths['/orders'].get = { responses: { '200': { description: 'All' } } };
      delete s.paths['/orders/{id}'].delete;
    });
    expect((await diff(shop(), after)).changes.map((c) => c.severity)).toEqual(['breaking', 'non-breaking', 'info']);
  });

  it('every severity in a change is the catalogue severity of its rule', async () => {
    const { changes } = await diff(null, shop());
    for (const c of changes) expect(c.severity).toBe(API_CHANGE_RULES[c.rule]);
  });

  // A closed vocabulary must not promise a value the code never emits.
  afterAll(() => {
    expect([...seen].sort()).toEqual([...API_CHANGE_RULE_IDS].sort());
  });
});
