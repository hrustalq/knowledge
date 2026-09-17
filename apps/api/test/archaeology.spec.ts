import { describe, expect, it } from 'vitest';

/**
 * The archaeologist's deterministic half (docs/features/31): which files are
 * documents, which are candidates and in what order, which of them the
 * declared text covers, and what the model's answer must carry to count.
 * Pure functions over a fake archive — no model, no Nest, no network.
 */
const {
  decisionScore,
  headingDigest,
  isCandidatePath,
  isCovered,
  rankCandidates,
  readExcavation,
  selectRepoDocs,
} = await import('../src/agents/archaeology.js');

const enc = new TextEncoder();
const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, enc.encode(text)]));

describe('selectRepoDocs', () => {
  it('takes the documents, README first, docs directories next, and drops the noise', () => {
    const docs = selectRepoDocs(
      files({
        'src/a.ts': 'code',
        'docs/guide.md': '# Guide',
        'README.md': '# Hello',
        'CHANGELOG.md': '# 1.0',
        'LICENSE': 'MIT',
        'packages/x/README.md': '# x',
        'notes.txt': 'hi',
      }),
    );
    expect(docs.map((d) => d.path)).toEqual(['README.md', 'packages/x/README.md', 'docs/guide.md', 'notes.txt']);
    expect(docs[0].text).toBe('# Hello');
  });
});

describe('isCandidatePath', () => {
  it('keeps parseable source and drops tests, config, generated and hidden trees', () => {
    expect(isCandidatePath('src/pricing.ts')).toBe(true);
    expect(isCandidatePath('cmd/api/main.go')).toBe(true);
    expect(isCandidatePath('src/pricing.spec.ts')).toBe(false);
    expect(isCandidatePath('src/__tests__/pricing.ts')).toBe(false);
    expect(isCandidatePath('vite.config.ts')).toBe(false);
    expect(isCandidatePath('src/types.d.ts')).toBe(false);
    expect(isCandidatePath('prisma/migrations/x/migration.sql')).toBe(false);
    expect(isCandidatePath('.github/workflows/ci.yml')).toBe(false);
    expect(isCandidatePath('README.md')).toBe(false);
  });
});

describe('rankCandidates', () => {
  const branchy = Array.from({ length: 40 }, (_, i) => `if (order.status === 'paid' && price > ${i}) throw new Error('limit')`).join('\n');
  const flat = Array.from({ length: 40 }, (_, i) => `export const NAME_${i} = 'value ${i}';`).join('\n');

  it('puts the file that decides the most first and skips files that are too small', () => {
    const ranked = rankCandidates(files({ 'src/flat.ts': flat, 'src/rules.ts': branchy, 'src/tiny.ts': 'export {}' }), 10);
    expect(ranked.map((c) => c.path)).toEqual(['src/rules.ts', 'src/flat.ts']);
    expect(decisionScore(branchy, branchy.length).score).toBeGreaterThan(decisionScore(flat, flat.length).score);
  });

  it('honours the limit', () => {
    expect(rankCandidates(files({ 'a.ts': branchy, 'b.ts': branchy, 'c.ts': branchy }), 2)).toHaveLength(2);
  });
});

describe('isCovered', () => {
  const declared = 'the pricing engine lives in src/billing/pricing.ts and applies discounttiers via applydiscount'.toLowerCase();

  it('is covered by path, by a specific filename, or by two exported names', () => {
    expect(isCovered(declared, 'src/billing/pricing.ts', [])).toBe(true);
    expect(isCovered('see pricing.ts for the rules', 'lib/pricing.ts', [])).toBe(true);
    expect(isCovered(declared, 'src/other.ts', ['DiscountTiers', 'applyDiscount'])).toBe(true);
  });

  it('is not covered by a generic name or a single common export', () => {
    expect(isCovered('the index handles everything', 'src/index.ts', ['run'])).toBe(false);
    expect(isCovered(declared, 'src/other.ts', ['applyDiscount'])).toBe(false);
    expect(isCovered(declared, 'src/other.ts', ['Order'])).toBe(false);
  });
});

describe('headingDigest', () => {
  it('lists pages and the headings of each document', () => {
    const digest = headingDigest(
      [{ path: 'README.md', text: '# Title\n\ntext\n## Install\n### Deep\n#### too deep' }],
      [{ title: 'Ops runbook', markdown: '...' }],
    );
    expect(digest).toBe('- workspace page "Ops runbook"\n- README.md: Title / Install / Deep');
  });
});

describe('readExcavation', () => {
  const snapshot = {
    files: files({ 'src/rules.ts': 'x', 'src/other.ts': 'y' }),
    host: { kind: 'github' as const, origin: 'https://github.com', owner: 'a', repo: 'b' },
    blobUrl: (path: string, lines?: readonly [number, number?]) =>
      `https://github.com/a/b/blob/main/${path}${lines ? `#L${lines[0]}${lines[1] ? `-L${lines[1]}` : ''}` : ''}`,
  } as never;
  const draft = { title: 'Refund windows', markdown: 'p'.repeat(300) };
  const good = {
    title: 'Refunds close after 30 days',
    detail: 'Nothing declares the window.',
    severity: 'warning',
    draft,
    sources: [{ path: 'src/rules.ts', startLine: 10, endLine: 20, note: 'the window' }],
  };

  it('keeps a grounded proposal, building the citation from the path', () => {
    const finding = readExcavation(good, snapshot, new Set(['src/rules.ts']));
    expect(finding).toMatchObject({
      kind: 'gap',
      severity: 'warning',
      documentIds: [],
      draft,
      sources: [
        {
          kind: 'web',
          url: 'https://github.com/a/b/blob/main/src/rules.ts#L10-L20',
          site: 'github.com',
          title: 'src/rules.ts:10-20',
          snippet: 'the window',
        },
      ],
    });
  });

  it('drops a proposal that cites a file it did not read, a file not in the snapshot, or no file', () => {
    expect(readExcavation(good, snapshot, new Set(['src/other.ts']))).toBeNull();
    expect(readExcavation({ ...good, sources: [{ path: 'src/missing.ts' }] }, snapshot, new Set(['src/missing.ts']))).toBeNull();
    expect(readExcavation({ ...good, sources: [] }, snapshot, new Set(['src/rules.ts']))).toBeNull();
  });

  it('drops a proposal without a real page', () => {
    expect(readExcavation({ ...good, draft: { title: 'x', markdown: 'short' } }, snapshot, new Set(['src/rules.ts']))).toBeNull();
    expect(readExcavation({ ...good, draft: undefined }, snapshot, new Set(['src/rules.ts']))).toBeNull();
    expect(readExcavation({ ...good, title: '' }, snapshot, new Set(['src/rules.ts']))).toBeNull();
  });

  it('never trusts a model-supplied url and caps the citations', () => {
    const finding = readExcavation(
      {
        ...good,
        sources: [
          { path: 'src/rules.ts', url: 'https://evil.example/x', startLine: 1 },
          { path: 'src/rules.ts', startLine: 1 },
          ...Array.from({ length: 12 }, (_, i) => ({ path: 'src/rules.ts', startLine: i + 5 })),
        ],
      },
      snapshot,
      new Set(['src/rules.ts']),
    );
    expect(finding?.sources?.every((s) => s.url.startsWith('https://github.com/a/b/'))).toBe(true);
    expect(finding?.sources?.length).toBe(8);
  });
});
