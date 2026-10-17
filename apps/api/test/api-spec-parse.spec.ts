import { describe, expect, it, vi } from 'vitest';
import { UnprocessableEntityException } from '@nestjs/common';
import {
  apiSpecContentType,
  apiSpecSlug,
  channelEntityKey,
  normalizeApiPath,
  normalizeEntityKey,
  operationEntityKey,
} from '@knowledge/contracts';
import { ApiSpecError, keyOperations, parseApiSpec, readApiSpecDocument } from '../src/api-specs/api-spec.parser.js';
import { renderOperation, renderSpecProjection } from '../src/api-specs/api-spec.projection.js';
import { WRITE_TOOLS } from '../src/mcp/mcp-tools.js';
import { ApiSpecsService } from '../src/api-specs/api-specs.service.js';
import { splitMarkdown } from '../src/ingestion/markdown.js';
import { StorageService } from '../src/storage/storage.service.js';

const LIMITS = { maxBytes: 5_000_000, maxOperations: 2000 };

const OPENAPI_30 = `openapi: 3.0.3
info:
  title: Billing API
  version: '1.2'
  description: Invoices and the people who pay them.
servers: [{ url: 'https://api.example.com/v1' }]
tags:
  - { name: Users, description: People with an account. }
paths:
  /users/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      operationId: getUser
      tags: [Users]
      summary: Get a user
      responses:
        '200':
          description: The user
          content:
            application/json:
              schema: { $ref: '#/components/schemas/User' }
        '404': { description: Not found }
    delete:
      tags: [Users]
      deprecated: true
      responses: { '204': { description: Gone } }
  /invoices:
    post:
      summary: Create an invoice
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [amount]
              properties:
                amount: { type: integer, description: In cents }
                currency: { type: string, enum: [EUR, USD] }
      responses: { '201': { description: Created } }
components:
  schemas:
    User:
      type: object
      properties:
        id: { type: string }
        manager: { $ref: '#/components/schemas/User' }
`;

const OPENAPI_31 = `openapi: 3.1.0
info: { title: Ping, version: '1' }
x-knowledge-key: ping-svc
paths:
  /ping:
    get:
      responses: { '200': { description: pong } }
`;

const SWAGGER_2 = JSON.stringify({
  swagger: '2.0',
  info: { title: 'Legacy', version: '1' },
  host: 'legacy.example.com',
  basePath: '/v2',
  paths: {
    '/orders': {
      post: {
        summary: 'Place an order',
        parameters: [{ in: 'body', name: 'body', schema: { type: 'object' } }],
        responses: { '201': { description: 'Placed' } },
      },
    },
  },
});

const ASYNCAPI_26 = `asyncapi: 2.6.0
info: { title: User Events, version: '1' }
channels:
  user/{userId}/signedup:
    description: A user finished signing up.
    subscribe:
      summary: React to a signup
      message: { $ref: '#/components/messages/Signup' }
    publish:
      message: { $ref: '#/components/messages/Signup' }
  user/deleted: {}
components:
  messages:
    Signup:
      name: UserSignedUp
      payload: { type: object, properties: { userId: { type: string } } }
`;

const ASYNCAPI_30 = `asyncapi: 3.0.0
info: { title: User Events, version: '1' }
channels:
  signedUp:
    address: user/{userId}/signedup
    messages:
      signup: { $ref: '#/components/messages/Signup' }
  idle:
    address: system/idle
operations:
  onSignup:
    action: receive
    channel: { $ref: '#/channels/signedUp' }
    summary: React to a signup
components:
  messages:
    Signup:
      payload: { type: object, properties: { userId: { type: string } } }
`;

describe('operation entity keys', () => {
  it('folds path parameters, so a renamed parameter is the same operation', () => {
    expect(operationEntityKey('Billing API', 'get', '/users/{id}')).toBe(
      operationEntityKey('billing-api', 'GET', '/users/{userId}/'),
    );
    expect(operationEntityKey('Billing API', 'post', '/invoices')).toBe('op:billing-api:post-/invoices');
  });

  it('is what a page writing the key by hand lands on', () => {
    // A frontmatter `relations:` target goes through normalizeEntityKey only.
    expect(normalizeEntityKey('op:billing-api:GET /users/{userId}')).toBe(
      operationEntityKey('billing-api', 'GET', '/users/{id}'),
    );
    expect(normalizeEntityKey('channel:events:user/{id}/signedup')).toBe(
      channelEntityKey('events', 'user/{userId}/signedup'),
    );
  });

  it('leaves braces alone on every other entity type', () => {
    expect(normalizeEntityKey('service:{billing}')).toBe('service:{billing}');
  });

  it('normalizes paths and slugs', () => {
    expect(normalizeApiPath('users//{id}/')).toBe('/users/{}');
    expect(normalizeApiPath('/')).toBe('/');
    expect(apiSpecSlug('Billing API: v2')).toBe('billing-api-v2');
    expect(apiSpecSlug('  ')).toBe('api');
    expect(apiSpecContentType('asyncapi', 'json')).toBe('application/vnd.aai.asyncapi+json');
  });
});

describe('parseApiSpec — OpenAPI', () => {
  it('reads a 3.0 spec into operations with pointers, tags and path-level parameters', async () => {
    const spec = await parseApiSpec(OPENAPI_30, 'openapi', LIMITS);
    expect(spec).toMatchObject({ kind: 'openapi', specVersion: '3.0.3', title: 'Billing API', version: '1.2', keyHint: null });
    const ops = keyOperations(spec, apiSpecSlug(spec.title));
    expect(ops.map((o) => `${o.method} ${o.path}`)).toEqual(['GET /users/{id}', 'DELETE /users/{id}', 'POST /invoices']);
    expect(ops[0]).toMatchObject({
      operationId: 'getUser',
      tags: ['Users'],
      summary: 'Get a user',
      pointer: '/paths/~1users~1{id}/get',
      entityKey: 'op:billing-api:get-/users/{}',
    });
    expect(ops[1].deprecated).toBe(true);
  });

  it('reads 3.1 and its x-knowledge-key', async () => {
    const spec = await parseApiSpec(OPENAPI_31, 'openapi', LIMITS);
    expect(spec.keyHint).toBe('ping-svc');
    expect(spec.operations).toHaveLength(1);
  });

  it('up-converts Swagger 2.0, request body and servers included', async () => {
    const spec = await parseApiSpec(SWAGGER_2, 'openapi', LIMITS);
    expect(spec.specVersion).toBe('2.0');
    expect(spec.operations[0].raw.requestBody).toBeTruthy();
    expect(spec.document.servers).toEqual([{ url: 'http://legacy.example.com/v2' }]);
  });

  it('refuses a spec that does not validate, with the validator path', async () => {
    const broken = 'openapi: 3.0.0\ninfo: { title: B, version: "1" }\npaths: { /x: { get: { responses: 7 } } }\n';
    const err = await parseApiSpec(broken, 'openapi', LIMITS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiSpecError);
    expect((err as ApiSpecError).issues[0]).toMatchObject({ path: '/paths/~1x/get/responses' });
  });

  it('refuses YAML that does not parse, and a document that is not OpenAPI', async () => {
    await expect(parseApiSpec('a: [1', 'openapi', LIMITS)).rejects.toBeInstanceOf(ApiSpecError);
    await expect(parseApiSpec('title: notes', 'openapi', LIMITS)).rejects.toThrow(/no top-level `openapi`/u);
  });

  it('refuses a remote $ref without fetching it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const remote = `openapi: 3.1.0
info: { title: R, version: '1' }
paths:
  /x:
    get:
      responses:
        '200': { description: ok, content: { application/json: { schema: { $ref: 'https://evil.example/s.json' } } } }
`;
    const err = await parseApiSpec(remote, 'openapi', LIMITS).catch((e: unknown) => e);
    expect((err as ApiSpecError).message).toMatch(/external reference/iu);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('enforces the size and operation limits', async () => {
    await expect(parseApiSpec(OPENAPI_30, 'openapi', { maxBytes: 100, maxOperations: 2000 })).rejects.toThrow(/limit is 100/u);
    await expect(parseApiSpec(OPENAPI_30, 'openapi', { maxBytes: 5_000_000, maxOperations: 2 })).rejects.toThrow(
      /3 operations; the limit is 2/u,
    );
  });

  it('keeps the first of two operations that fold to one key', async () => {
    const dup = `openapi: 3.1.0
info: { title: D, version: '1' }
paths:
  /u/{id}:
    get:
      summary: first
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { '200': { description: ok } }
  /u/{userId}:
    get:
      summary: second
      parameters: [{ name: userId, in: path, required: true, schema: { type: string } }]
      responses: { '200': { description: ok } }
`;
    const ops = keyOperations(await parseApiSpec(dup, 'openapi', LIMITS), 'd');
    expect(ops.map((o) => o.summary)).toEqual(['first']);
  });
});

describe('parseApiSpec — AsyncAPI', () => {
  it('reads 2.6 channels, one row per action and one for a channel with none', async () => {
    const spec = await parseApiSpec(ASYNCAPI_26, 'asyncapi', LIMITS);
    const ops = keyOperations(spec, apiSpecSlug(spec.title));
    expect(ops.map((o) => [o.method, o.path])).toEqual([
      ['publish', 'user/{userId}/signedup'],
      ['subscribe', 'user/{userId}/signedup'],
      [null, 'user/deleted'],
    ]);
    // Both actions are one channel entity.
    expect(new Set(ops.map((o) => o.entityKey)).size).toBe(2);
    expect(ops[0].entityKey).toBe('channel:user-events:user/{}/signedup');
  });

  it('reads 3.0 operations through their channel $ref, plus unused channels', async () => {
    const spec = await parseApiSpec(ASYNCAPI_30, 'asyncapi', LIMITS);
    const ops = keyOperations(spec, 'events');
    expect(ops.map((o) => [o.method, o.path, o.operationId])).toEqual([
      ['receive', 'user/{userId}/signedup', 'onSignup'],
      [null, 'system/idle', null],
    ]);
    expect(ops[0].pointer).toBe('/operations/onSignup');
  });

  it('refuses an unsupported version and a missing title', async () => {
    await expect(parseApiSpec('asyncapi: 1.2.0\ninfo: {title: x}', 'asyncapi', LIMITS)).rejects.toThrow(/not supported/u);
    await expect(parseApiSpec('asyncapi: 2.6.0\ninfo: {version: "1"}', 'asyncapi', LIMITS)).rejects.toThrow(/title/u);
  });
});

describe('renderSpecProjection', () => {
  it('sections one operation per heading under its tag, with params, body and responses', async () => {
    const spec = await parseApiSpec(OPENAPI_30, 'openapi', LIMITS);
    const md = renderSpecProjection(spec);
    expect(md).toContain('# Billing API 1.2');
    expect(md).toContain('- `https://api.example.com/v1`');
    expect(md).toContain('| id | path | string | yes |  |');
    expect(md).toContain('amount*: integer — In cents');
    expect(md).toContain('currency: string (EUR, USD)');
    const paths = splitMarkdown(md).map((s) => s.headingPath.join(' > '));
    expect(paths).toContain('Billing API 1.2 > Users > GET /users/{id}');
    expect(paths).toContain('Billing API 1.2 > Operations > POST /invoices');
  });

  it('stops at a recursive schema instead of looping', async () => {
    const md = renderSpecProjection(await parseApiSpec(OPENAPI_30, 'openapi', LIMITS));
    expect(md).toContain('manager: object');
    expect(md).toContain('… (recursive)');
  });

  it('demotes a description heading so it cannot split an operation', async () => {
    const spec = await parseApiSpec(OPENAPI_31.replace("version: '1' }", "version: '1', description: '# Big' }"), 'openapi', LIMITS);
    expect(renderSpecProjection(spec)).toContain('##### Big');
  });

  it('renders AsyncAPI messages', async () => {
    const md = renderSpecProjection(await parseApiSpec(ASYNCAPI_26, 'asyncapi', LIMITS));
    expect(md).toContain('### subscribe user/{userId}/signedup');
    expect(md).toContain('#### Message UserSignedUp');
    expect(md).toContain('userId: string');
  });
});

describe('ApiSpecsService', () => {
  function service(doc: { specSlug: string | null }) {
    const prisma = {
      document: {
        findUnique: vi.fn(async () => ({ ...doc })),
        update: vi.fn(async ({ data }: { data: { specSlug: string } }) => Object.assign(doc, data)),
        updateMany: vi.fn(async ({ data }: { data: { specSlug: string } }) => {
          if (doc.specSlug === null) Object.assign(doc, data);
          return { count: 1 };
        }),
      },
      apiOperation: { deleteMany: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})) },
      withTransaction: async (fn: () => Promise<unknown>) => fn(),
    };
    const config = { get: (k: string) => (k === 'API_SPEC_MAX_BYTES' ? 5_000_000 : 2000) };
    return { svc: new ApiSpecsService(prisma as never, config as never), prisma };
  }
  const input = { workspaceId: 'w', documentId: 'd', revisionId: 'r', kind: 'openapi' as const, live: true };

  it('pins the slug from the title on first projection and keeps it when the title changes', async () => {
    const doc = { specSlug: null as string | null };
    const { svc, prisma } = service(doc);
    expect((await svc.project({ ...input, raw: OPENAPI_30 })).slug).toBe('billing-api');
    const renamed = OPENAPI_30.replace('title: Billing API', 'title: Payments');
    const second = await svc.project({ ...input, raw: renamed });
    expect(second.slug).toBe('billing-api');
    expect(second.operations[0].entityKey).toBe('op:billing-api:get-/users/{}');
    expect(prisma.apiOperation.deleteMany).toHaveBeenCalledWith({ where: { revisionId: 'r' } });
  });

  it('re-pins only on an explicit x-knowledge-key at the live head', async () => {
    const doc = { specSlug: 'ping' as string | null };
    const { svc } = service(doc);
    expect((await svc.project({ ...input, live: false, raw: OPENAPI_31 })).slug).toBe('ping-svc');
    expect(doc.specSlug).toBe('ping');
    expect((await svc.project({ ...input, raw: OPENAPI_31 })).slug).toBe('ping-svc');
    expect(doc.specSlug).toBe('ping-svc');
  });

  it('turns a bad spec into a 422 carrying the issues', async () => {
    const { svc } = service({ specSlug: null });
    const err = await svc.assertValid('openapi: 3.0.0\ninfo: {}\n', 'openapi').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    const body = (err as UnprocessableEntityException).getResponse() as { statusCode: number; issues: unknown[] };
    expect(body.statusCode).toBe(422);
    expect(body.issues.length).toBeGreaterThan(0);
  });
});

describe('StorageService.sourceObjectName', () => {
  const name = StorageService.prototype.sourceObjectName;
  it('names a spec by its syntax and everything else source.md', () => {
    expect(name('application/vnd.oai.openapi+yaml')).toBe('source.yaml');
    expect(name('application/vnd.aai.asyncapi+json')).toBe('source.json');
    expect(name('text/markdown')).toBe('source.md');
    expect(name('text/plain')).toBe('source.md');
  });
});

describe('read helpers (phase 2)', () => {
  it('serves OpenAPI upgraded to 3.1 with its $refs kept, so a recursive schema stays JSON', () => {
    const { document: doc, specVersion } = readApiSpecDocument(OPENAPI_30, 'openapi');
    expect(doc.openapi).toMatch(/^3\.1/u);
    expect(specVersion).toBe('3.0.3');
    expect(JSON.stringify(doc)).toContain('"$ref":"#/components/schemas/User"');
    expect(readApiSpecDocument(ASYNCAPI_26, 'asyncapi').document.asyncapi).toBe('2.6.0');
  });

  it('renders one operation alone', async () => {
    const spec = await parseApiSpec(OPENAPI_30, 'openapi', LIMITS);
    const md = renderOperation(spec.operations[2]);
    expect(md.startsWith('### POST /invoices')).toBe(true);
    expect(md).not.toContain('GET /users');
  });

  it('keeps the API operation tools read-only', () => {
    expect(WRITE_TOOLS.has('knowledge_list_api_operations')).toBe(false);
    expect(WRITE_TOOLS.has('knowledge_get_api_operation')).toBe(false);
    expect(WRITE_TOOLS.has('knowledge_diff_api_spec')).toBe(false);
  });
});

