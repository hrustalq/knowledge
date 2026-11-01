import { describe, expect, it, vi } from 'vitest';

/**
 * OpenAPI URL sources (#674, phase 4).
 *
 * Pinned:
 * 1. A JSON or YAML body with an `openapi` / `swagger` / `asyncapi` key reads
 *    as a spec, stored as written, titled by `info.title`, with no recipe body.
 *    A JSON body that is not a spec is still refused.
 * 2. A spec version is held, alerting once, when it is split across files,
 *    the parser refuses it, or its kind no longer matches the page; a version
 *    that parses releases the hold. A plain page with a plain body is untouched.
 * 3. A landed version with breaking changes alerts `breaking`; removed
 *    operations also flag the pages linking the spec `requested`. A
 *    non-breaking version does neither.
 */
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));

const { safeFetch } = await import('../src/common/safe-fetch.js');
const { WebAdapter, UnsupportedSourceError } = await import('../src/connectors/adapters/web.adapter.js');
const { WebSourcesService } = await import('../src/connectors/web-sources.service.js');
const { ApiSpecError } = await import('../src/api-specs/api-spec.parser.js');

const fetchMock = vi.mocked(safeFetch);
const SPEC_URL = 'https://api.example.com/openapi.json';

const ctx = {
  connectorId: 'c1',
  workspaceId: 'w1',
  config: { url: SPEC_URL },
  credential: null,
  onStage: async () => undefined,
  debug: () => undefined,
  allowPrivate: false,
  userId: 'u1',
  locale: 'en' as const,
};

describe('WebAdapter spec bodies', () => {
  const adapter = new WebAdapter();
  const read = (body: string, type: string, url = SPEC_URL) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': type } }));
    return adapter.fetch(ctx, { externalId: url, title: url, url });
  };

  it('reads an OpenAPI document as a spec, stored as written', async () => {
    const body = JSON.stringify({ openapi: '3.0.3', info: { title: 'Billing API', version: '1' }, paths: {} });
    const doc = await read(body, 'application/vnd.oai.openapi+json');
    expect(doc.spec).toEqual({ kind: 'openapi', syntax: 'json' });
    expect(doc.title).toBe('Billing API');
    expect(doc.markdown).toBe(body);
    expect(doc.source).toBeUndefined();
  });

  it('reads YAML served as text under a .yaml path, and AsyncAPI', async () => {
    const doc = await read('asyncapi: 2.6.0\ninfo:\n  title: Events\n  version: "1"\nchannels: {}\n', 'text/plain', 'https://x.example.com/events.yaml');
    expect(doc.spec).toEqual({ kind: 'asyncapi', syntax: 'yaml' });
  });

  it('still refuses a JSON body that is not a spec', async () => {
    await expect(read('{"hello":"world"}', 'application/json')).rejects.toBeInstanceOf(UnsupportedSourceError);
  });
});

function service(opts: { pageKind?: string; diff?: unknown } = {}) {
  const calls = { alerts: [] as string[], flagged: [] as Array<[string, string]>, held: [] as string[], released: 0 };
  let held = false;
  const prisma = {
    document: { findUnique: vi.fn(async () => ({ kind: opts.pageKind ?? 'openapi', title: 'Billing API' })) },
    pageLink: { findMany: vi.fn(async () => [{ sourceDocumentId: 'dep1' }]) },
  };
  const recipes = {
    invalidSpec: vi.fn(async (_link: unknown, detail: string) => {
      calls.held.push(detail);
      return !held && (held = true);
    }),
    specParsed: vi.fn(async () => {
      calls.released += 1;
      held = false;
    }),
  };
  const notifications = {
    notify: vi.fn(async (input: { metadata: { alert: string } }) => {
      calls.alerts.push(input.metadata.alert);
      return [];
    }),
  };
  const verification = { flag: vi.fn(async (id: string, flag: string) => calls.flagged.push([id, flag])) };
  const specs = {
    parse: vi.fn(async (raw: string) => {
      if (raw.includes('broken')) throw new ApiSpecError([{ path: 'paths', message: 'is broken' }] as never);
      return {};
    }),
  };
  const specDiff = { diff: vi.fn(async () => opts.diff ?? null) };
  const svc = new WebSourcesService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    verification as never,
    notifications as never,
    { announce: vi.fn(async () => undefined) } as never,
    {} as never,
    recipes as never,
    {} as never,
    specs as never,
    specDiff as never,
  );
  const row = { id: 'c1', workspaceId: 'w1', createdBy: 'owner', config: { url: SPEC_URL } };
  const link = { id: 'l1', documentId: 'd1', heldAt: null };
  const gate = (markdown: string, spec: unknown) => svc.specHeld(row as never, link as never, { markdown, spec } as never);
  const landed = () => svc.specLanded(row as never, 'd1', 'r1', 'r2');
  return { calls, gate, landed };
}

const OPENAPI = { kind: 'openapi', syntax: 'yaml' };

describe('WebSourcesService.specHeld', () => {
  it('holds a split, broken or re-kinded spec, alerting once, and releases on a good one', async () => {
    const { calls, gate } = service();
    expect(await gate('openapi: 3.0.3\npaths:\n  /a:\n    $ref: "./paths/a.yaml"\n', OPENAPI)).toBe(true);
    expect(calls.held[0]).toBe('error.source.splitSpec'); // t() returns the key without a loaded catalogue
    expect(await gate('openapi: 3.0.3\nbroken: true\n', OPENAPI)).toBe(true);
    expect(calls.held[1]).toContain('is broken');
    expect(await gate('# Now a page', undefined)).toBe(true);
    expect(calls.alerts).toEqual(['held']);
    expect(await gate('openapi: 3.0.3\npaths:\n  /a:\n    $ref: "#/components/x"\n', OPENAPI)).toBe(false);
    expect(calls.released).toBe(1);
  });

  it('leaves a plain page with a plain body alone', async () => {
    const { calls, gate } = service({ pageKind: 'page' });
    expect(await gate('# Guide', undefined)).toBe(false);
    expect(calls.held).toEqual([]);
    expect(calls.released).toBe(0);
  });
});

describe('WebSourcesService.specLanded', () => {
  const change = (rule: string) => ({ rule, severity: 'breaking', method: 'get', path: '/users' });

  it('alerts on a breaking version and flags the pages linking it when an operation is gone', async () => {
    const { calls, landed } = service({ diff: { summary: { breaking: 1, nonBreaking: 0, info: 0 }, changes: [change('operation-removed')] } });
    await landed();
    expect(calls.alerts).toEqual(['breaking']);
    expect(calls.flagged).toEqual([['dep1', 'requested']]);
  });

  it('alerts without flagging when nothing was removed, and stays quiet when nothing breaks', async () => {
    const breaking = service({ diff: { summary: { breaking: 1, nonBreaking: 0, info: 0 }, changes: [change('param-required-added')] } });
    await breaking.landed();
    expect(breaking.calls.alerts).toEqual(['breaking']);
    expect(breaking.calls.flagged).toEqual([]);

    const quiet = service({ diff: { summary: { breaking: 0, nonBreaking: 2, info: 0 }, changes: [] } });
    await quiet.landed();
    expect(quiet.calls.alerts).toEqual([]);
  });
});
