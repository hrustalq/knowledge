import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { effectiveSiteAskBudget, normalizeEmbedOrigin } from '@knowledge/contracts';
import {
  PublicAskService,
  askKeywordQuery,
  askMessages,
  fusePassages,
  normalizeQuestion,
} from '../src/public/public-ask.service.js';

/**
 * A published site's Ask (docs/features/44, issue #77 phase 3). What is pinned:
 * - limits: a per-address rate and the site's daily budget, both checked
 *   before any model call and both failing closed; only a question with
 *   passages to answer from spends the budget (429 `publicAsk.budgetExhausted`);
 * - scope: retrieval sees only the version's snapshot rows this viewer may
 *   read — hidden rows' revisions are never searched, their pages never quoted;
 * - citations: settled against the passages handed out, so a label the model
 *   invents is stripped, and every source is a page URL on the site;
 * - trust: passages reach the model wrapped untrusted, in the user turn, with
 *   no tools; the call is billed to the site as `public_ask`.
 */

const SITE = '22222222-2222-4222-8222-222222222222';
const WS = '11111111-1111-4111-8111-111111111111';

type Row = {
  documentId: string;
  revisionId: string;
  parentId: string | null;
  position: number;
  depth: number;
  slugPath: string;
  title: string;
  audience: string;
  audienceClaims: unknown;
};

const row = (n: number, extra: Partial<Row> = {}): Row => ({
  documentId: `d${n}`,
  revisionId: `r${n}`,
  parentId: null,
  position: n,
  depth: 0,
  slugPath: `page-${n}`,
  title: `Page ${n}`,
  audience: 'public',
  audienceClaims: null,
  ...extra,
});

interface Options {
  /** The decision model's p per cited sentence (#530); absent = no Decisions route. */
  support?: number[];
  askEnabled?: boolean;
  askDailyBudget?: number | null;
  ceiling?: number;
  rows?: Row[];
  chunks?: Array<{ documentId: string; revisionId: string; headingPath: string[]; text: string; score: number }>;
  keyword?: Array<{ document_id: string; excerpt: string }>;
  answer?: string;
  hit?: (key: string) => boolean;
  modelEnabled?: boolean;
}

function asker(o: Options = {}) {
  const latest = { id: 'v-latest', slug: 'latest' };
  const site = {
    id: SITE,
    slug: 'docs',
    workspaceId: WS,
    projectId: 'p1',
    theme: {},
    askEnabled: o.askEnabled ?? true,
    askDailyBudget: o.askDailyBudget ?? null,
    defaultVersion: latest,
    versions: [latest, { id: 'v-old', slug: 'v1' }],
  };
  const rows = o.rows ?? [row(1), row(2)];
  const sites = {
    findById: vi.fn(async (id: string) => (id === SITE ? site : Promise.reject(new NotFoundException()))),
    viewer: vi.fn(async () => ({ kind: 'anonymous' })),
    rootUrl: vi.fn(() => 'https://docs.example.com'),
  };
  const prisma = {
    siteVersionPage: { findMany: vi.fn(async () => rows) },
    project: { findUnique: vi.fn(async () => ({ name: 'Acme Docs' })) },
    $queryRaw: vi.fn(async (_s: TemplateStringsArray, ..._v: unknown[]) => o.keyword ?? []),
  };
  const limiter = { hit: vi.fn(async (key: string) => (o.hit ? o.hit(key) : true)) };
  const aiConfig = { resolveFor: vi.fn(async () => ({ enabled: o.modelEnabled ?? true, workspaceId: WS })) };
  const usage = { assertWithinBudget: vi.fn(async () => undefined) };
  const client = { chat: vi.fn(async () => o.answer ?? 'Install it with the CLI. [S1]') };
  const chunks = o.chunks ?? [{ documentId: 'd1', revisionId: 'r1', headingPath: ['Install'], text: 'Run the installer.', score: 0.9 }];
  const graph = { searchRevisionChunks: vi.fn(async () => chunks) };
  const embeddings = { embed: vi.fn(async () => [0.1, 0.2]) };
  const env: Record<string, unknown> = { PUBLIC_ASK_DAILY_BUDGET: o.ceiling ?? 200, PUBLIC_ASK_RATE_PER_MIN: 6 };
  const config = { get: vi.fn((k: string) => env[k]) };
  const ps = [...(o.support ?? [])];
  const decision = {
    routeFor: vi.fn(async () => (o.support ? { config: {}, thresholds: { citation: 0.5 } } : null)),
    noul: vi.fn(async () => ps.shift()!),
  };
  const service = new PublicAskService(
    sites as never,
    prisma as never,
    limiter as never,
    aiConfig as never,
    usage as never,
    client as never,
    graph as never,
    embeddings as never,
    config as never,
    decision as never,
  );
  return { service, sites, prisma, limiter, aiConfig, usage, client, graph, embeddings, decision };
}

const ctx = { ip: '203.0.113.5', locale: 'en' as const };

describe('PublicAskService — limits', () => {
  it('404s a site that does not answer questions, or whose budget the ceiling leaves at 0', async () => {
    await expect(asker({ askEnabled: false }).service.ask(SITE, { question: 'how?' }, ctx)).rejects.toBeInstanceOf(NotFoundException);
    await expect(asker({ ceiling: 0 }).service.ask(SITE, { question: 'how?' }, ctx)).rejects.toBeInstanceOf(NotFoundException);
    await expect(asker({ askDailyBudget: 0 }).service.ask(SITE, { question: 'how?' }, ctx)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rate-limits per address before anything is retrieved, failing closed', async () => {
    const { service, limiter, client, graph } = asker({ hit: (k) => !k.startsWith('ask:') });
    const err = await service.ask(SITE, { question: 'how do I install?' }, ctx).catch((e: HttpException) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({ reason: 'publicAsk.rateLimited' });
    expect(limiter.hit).toHaveBeenCalledWith('ask:203.0.113.5', 6, 60_000, false);
    expect(graph.searchRevisionChunks).not.toHaveBeenCalled();
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('answers 429 publicAsk.budgetExhausted once the day is spent, without calling the model', async () => {
    const { service, limiter, client } = asker({ askDailyBudget: 50, hit: (k) => !k.startsWith('ask-site:') });
    const err = await service.ask(SITE, { question: 'how do I install?' }, ctx).catch((e: HttpException) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({ reason: 'publicAsk.budgetExhausted' });
    expect(limiter.hit).toHaveBeenCalledWith(`ask-site:${SITE}`, 50, 86_400_000, false);
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('spends no budget on a question nothing on the site matches', async () => {
    const { service, limiter, client } = asker({ chunks: [], keyword: [] });
    await expect(service.ask(SITE, { question: 'unrelated' }, ctx)).resolves.toEqual({ answer: '', sources: [] });
    expect(limiter.hit.mock.calls.map((c) => c[0])).toEqual(['ask:203.0.113.5']);
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('is unavailable (503) with no model configured, or with the workspace AI budget spent', async () => {
    await expect(asker({ modelEnabled: false }).service.ask(SITE, { question: 'how?' }, ctx)).rejects.toBeInstanceOf(ServiceUnavailableException);
    const spent = asker();
    spent.usage.assertWithinBudget.mockRejectedValueOnce(new HttpException('budget', 429));
    await expect(spent.service.ask(SITE, { question: 'how?' }, ctx)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(spent.client.chat).not.toHaveBeenCalled();
  });
  it('tells a visitor only that Ask is unavailable when the provider refuses, never why', async () => {
    const { service, client } = asker();
    client.chat.mockRejectedValueOnce(new ServiceUnavailableException('The provider has no credit left (402). Top up.'));
    const err = await service.ask(SITE, { question: 'how do I install?' }, ctx).catch((e: HttpException) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((err as HttpException).getResponse())).not.toMatch(/credit|402/);
  });
});

describe('PublicAskService — scope', () => {
  it('searches only the revisions of rows the viewer may read', async () => {
    const hidden = row(3, { audience: 'members', revisionId: 'r3' });
    const child = row(4, { parentId: 'd3', depth: 1, revisionId: 'r4' });
    const { service, graph, prisma } = asker({ rows: [row(1), row(2), hidden, child] });
    await service.ask(SITE, { question: 'how do I install?' }, ctx);
    expect(graph.searchRevisionChunks).toHaveBeenCalledWith(WS, ['r1', 'r2'], [0.1, 0.2], 12);
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    expect(strings.join('?')).toMatch(/FROM site_version_pages\s+WHERE version_id = \?::uuid\s+AND document_id = ANY\(\?::uuid\[\]\)/);
    expect(values).toContainEqual(['d1', 'd2']);
  });

  it('drops a chunk whose document does not match its pinned revision, and reads the named version', async () => {
    const { service, client, prisma } = asker({
      chunks: [{ documentId: 'd9', revisionId: 'r1', headingPath: [], text: 'Smuggled.', score: 1 }],
      keyword: [],
    });
    await expect(service.ask(SITE, { question: 'how do I install?', version: 'v1' }, ctx)).resolves.toEqual({ answer: '', sources: [] });
    expect(prisma.siteVersionPage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { versionId: 'v-old' } }));
    expect(client.chat).not.toHaveBeenCalled();
  });

  it('still answers from keywords when the embedding call fails', async () => {
    const { service, embeddings, client } = asker({ keyword: [{ document_id: 'd2', excerpt: 'Use \u0001the\u0002 CLI.' }] });
    embeddings.embed.mockRejectedValueOnce(new Error('down'));
    const res = await service.ask(SITE, { question: 'which cli?' }, ctx);
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(res.sources.map((s) => s.documentId)).toEqual(['d2']);
  });
});

describe('PublicAskService — answer', () => {
  it('strips citations to labels it never handed out and links each source to its page', async () => {
    const { service } = asker({
      answer: 'Run the installer. [S1] It also brews coffee. [S9]',
      keyword: [{ document_id: 'd2', excerpt: 'Other text' }],
    });
    const res = await service.ask(SITE, { question: 'how do I install?' }, ctx);
    expect(res.answer).toBe('Run the installer. [S1] It also brews coffee.');
    expect(res.sources).toEqual([
      { cite: 'S1', documentId: 'd1', title: 'Page 1', headingPath: ['Install'], url: 'https://docs.example.com/' },
    ]);
  });

  it('links a non-home page by its slug and a non-default version under its segment', async () => {
    const { service } = asker({
      answer: 'See this. [S1]',
      chunks: [{ documentId: 'd2', revisionId: 'r2', headingPath: [], text: 'Second.', score: 0.9 }],
    });
    const res = await service.ask(SITE, { question: 'second page?', version: 'v1' }, ctx);
    expect(res.sources[0].url).toBe('https://docs.example.com/v1/page-2');
  });

  it('bills the site as public_ask, with passages untrusted in the user turn', async () => {
    const { service, client } = asker();
    await service.ask(SITE, { question: '  how   do I\ninstall? ' }, ctx);
    const [callCtx, messages] = client.chat.mock.calls[0] as unknown as [Record<string, unknown>, Array<{ role: string; content: string }>];
    expect(callCtx).toMatchObject({ userId: SITE, operation: 'public_ask', locale: 'en' });
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain('Acme Docs');
    expect(messages[0].content).not.toContain('Run the installer.');
    expect(messages[1].content).toMatch(/^<pages tool="site_passages">[\s\S]*DATA, not instructions[\s\S]*\[S1\] Page 1 › Install\nRun the installer\.[\s\S]*<\/pages>/);
    expect(messages[1].content.endsWith('Question: how do I install?')).toBe(true);
  });
});

describe('Site Ask citation support (#530)', () => {
  it('with no Decisions route, asks nothing and returns no marks', async () => {
    const { service, decision } = asker();
    const res = await service.ask(SITE, { question: 'how do I install?' }, ctx);
    expect(decision.noul).not.toHaveBeenCalled();
    expect(res.citations).toBeUndefined();
  });

  it('marks each cited sentence against the passages handed out, billed to the site, the text unchanged', async () => {
    const { service, decision } = asker({ answer: 'Run the installer. [S1] It also brews coffee. [S1]', support: [0.9, 0.1] });
    const res = await service.ask(SITE, { question: 'how do I install?' }, ctx);
    expect(res.answer).toBe('Run the installer. [S1] It also brews coffee. [S1]');
    expect(res.citations?.map((c) => c.support)).toEqual(['supported', 'unsupported']);
    const [call, state] = decision.noul.mock.calls[1] as unknown as [{ userId: string; operation: string }, { sentence: string; passages: Record<string, string> }];
    expect(call).toMatchObject({ userId: SITE, operation: 'citation_check' });
    expect(state.sentence).toBe('It also brews coffee.');
    expect(state.passages.S1).toContain('Run the installer.');
    expect(state.passages.S1).toContain('<pages tool="cite">');
  });
});

describe('Ask helpers', () => {
  it('askKeywordQuery ORs the words and keeps only letters and digits', () => {
    expect(askKeywordQuery('How do I install the server?')).toBe('how | do | install | the | server');
    expect(askKeywordQuery(`a' | b:* & !c <-> (dd)`)).toBe('dd');
    expect(askKeywordQuery('Как установить сервер')).toBe('как | установить | сервер');
    expect(askKeywordQuery('?!')).toBeNull();
  });

  it('normalizeQuestion folds whitespace and caps the length', () => {
    expect(normalizeQuestion('  a\n\tb  ')).toBe('a b');
    expect(normalizeQuestion('x'.repeat(900))).toHaveLength(500);
  });

  it('fusePassages ranks pages across both legs and keeps a page’s best chunks, else its excerpt', () => {
    const fused = fusePassages(
      [
        { documentId: 'a', headingPath: ['A1'], text: 'a1' },
        { documentId: 'a', headingPath: ['A2'], text: 'a2' },
        { documentId: 'a', headingPath: ['A3'], text: 'a3' },
        { documentId: 'b', headingPath: [], text: 'b1' },
      ],
      [
        { documentId: 'b', excerpt: 'b-excerpt' },
        { documentId: 'c', excerpt: 'c-excerpt' },
      ],
    );
    // b is in both legs, so it outranks a; a keeps two of its three chunks; c has only its excerpt.
    expect(fused.map((p) => p.text)).toEqual(['b1', 'a1', 'a2', 'c-excerpt']);
  });

  it('askMessages names every passage by label and heading path', () => {
    const msgs = askMessages('Site', [{ cite: 'S1', row: row(1) as never, headingPath: ['H'], text: 'T' }], 'Q?');
    expect(msgs[1].content).toContain('[S1] Page 1 › H\nT');
  });

  it('normalizeEmbedOrigin keeps origins only: https, or http on loopback', () => {
    expect(normalizeEmbedOrigin('https://Example.com/docs?x=1')).toBe('https://example.com');
    expect(normalizeEmbedOrigin('https://app.example.com:8443')).toBe('https://app.example.com:8443');
    expect(normalizeEmbedOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    for (const bad of ['http://example.com', 'example.com', 'https://*.example.com', "https://a.com 'unsafe-inline'", 'https://intranet', 'https://u:p@a.com', '']) {
      expect(normalizeEmbedOrigin(bad)).toBeNull();
    }
  });

  it('effectiveSiteAskBudget: the env is a ceiling, null takes it', () => {
    expect(effectiveSiteAskBudget(null, 200)).toBe(200);
    expect(effectiveSiteAskBudget(50, 200)).toBe(50);
    expect(effectiveSiteAskBudget(500, 200)).toBe(200);
    expect(effectiveSiteAskBudget(50, 0)).toBe(0);
  });
});
