import { describe, expect, it, vi } from 'vitest';
import type { SourceRecipe } from '@knowledge/contracts';
import { applyRules, checkExtraction, extractSource, readRecipe, sourceOutline } from '../src/connectors/source-recipe.js';
import { SourceRecipesService } from '../src/connectors/source-recipes.service.js';

/**
 * Extraction recipes (#674, phase 2).
 *
 * Pinned:
 * 1. A recipe selects its content, strips inside it and remaps headings.
 * 2. Normalization rules drop a section (to the next heading of its level or
 *    higher), rename a heading and rewrite a link prefix; never inside a fence.
 * 3. The checks: a missing landmark, a word count below 40% of the last good
 *    version, and (implicit recipe) most h1/h2 headings vanishing hold it.
 * 4. A content edit leaves the fingerprint alone; a layout change moves it;
 *    hashed class names do not count.
 * 5. readRecipe keeps the declared shape and names what it dropped.
 * 6. A failing version is held once (one draft), and a passing one releases it.
 * 7. A save that fails its checks is refused and writes nothing.
 */

const URL = 'https://docs.example.com/guide';
const html = (main: string, frame = 'main class="docs"') =>
  `<html><head><title>Guide</title></head><body><nav>Menu</nav><${frame}>${main}</${frame.split(' ')[0]}><footer>© Example</footer></body></html>`;
const BODY = '<h1>Guide</h1><p>' + 'Install the tool and run it. '.repeat(10) + '</p><h2>Setup</h2><p>Set it up.</p><div class="ad">Buy now</div><h2>Usage</h2><p>Use it.</p>';
const recipe = (over: Partial<SourceRecipe> = {}): SourceRecipe => ({ content: ['main.docs'], strip: ['.ad'], headings: {}, landmarks: ['main.docs'], rules: [], ...over });
const source = (body: string) => ({ body, contentType: 'text/html', url: URL });

describe('extractSource', () => {
  it('selects the content, strips inside it and remaps headings', async () => {
    const ex = await extractSource(source(html(BODY)), recipe({ headings: { h1: 2 } }));
    expect(ex.markdown).toContain('## Guide');
    expect(ex.markdown).toContain('Set it up.');
    expect(ex.markdown).not.toContain('Buy now');
    expect(ex.markdown).not.toContain('Menu');
    expect(ex.hits).toEqual({ 'main.docs': 1 });
    expect(ex.contentFound).toBe(true);
  });

  it('keeps the fingerprint through a content edit and moves it on a layout change', async () => {
    const a = await extractSource(source(html(BODY)), null);
    const edited = await extractSource(source(html(BODY.replace('Set it up.', 'Set it up quickly.'))), null);
    const hashed = await extractSource(source(html(BODY, 'main class="docs css-1x2y3"')), null);
    const moved = await extractSource(source(html(BODY, 'article class="content"')), null);
    expect(edited.fingerprint!.hash).toBe(a.fingerprint!.hash);
    expect(hashed.fingerprint!.hash).toBe(a.fingerprint!.hash);
    expect(moved.fingerprint!.hash).not.toBe(a.fingerprint!.hash);
  });

  it('applies rules to a markdown source and gives it no fingerprint', async () => {
    const ex = await extractSource(
      { body: '# A\n\n## Internal\n\nsecret\n\n## Public\n\nok', contentType: 'text/markdown', url: `${URL}.md` },
      recipe({ rules: [{ kind: 'drop-section', heading: 'internal' }] }),
    );
    expect(ex.markdown).toBe('# A\n\n## Public\n\nok');
    expect(ex.fingerprint).toBeNull();
  });
});

describe('applyRules', () => {
  const md = '# Guide\n\n## Changelog\n\nold\n\n### 1.0\n\nolder\n\n## Usage\n\nSee [docs](https://old.example.com/x).\n\n```\n## Changelog\n```';

  it('drops a section through its subsections, never inside a fence', () => {
    const out = applyRules(md, [{ kind: 'drop-section', heading: ' CHANGELOG ' }]);
    expect(out).not.toContain('older');
    expect(out).toContain('## Usage');
    expect(out).toContain('```\n## Changelog\n```');
  });

  it('renames a heading and rewrites a link prefix', () => {
    const out = applyRules(md, [
      { kind: 'rename-heading', from: 'usage', to: 'How to use it' },
      { kind: 'rewrite-links', from: 'https://old.example.com/', to: 'https://new.example.com/' },
    ]);
    expect(out).toContain('## How to use it');
    expect(out).toContain('](https://new.example.com/x)');
  });
});

describe('checkExtraction', () => {
  it('holds a missing landmark, a collapsed word count, and lost headings', async () => {
    const good = await extractSource(source(html(BODY)), null);
    const baseline = { words: good.words, headings: good.headings };
    expect(checkExtraction(good, null, baseline)).toEqual([]);

    const moved = await extractSource(source(html(BODY, 'article class="x"')), recipe());
    expect(checkExtraction(moved, recipe(), baseline)).toEqual(['no-content', 'landmark', 'words']);

    const stub = await extractSource(source(html('<h1>Other</h1><p>Sign in to read.</p>')), null);
    expect(checkExtraction(stub, null, baseline)).toEqual(['words', 'headings']);
  });
});

describe('readRecipe', () => {
  it('keeps the declared shape and names what it dropped', () => {
    const { recipe: r, errors } = readRecipe({
      content: ['main', 'div[[', ''],
      headings: { h1: 2, h7: 1, h3: 9 },
      rules: [{ kind: 'drop-section', heading: 'x' }, { kind: 'eval', code: 'x' }],
      extra: true,
    });
    expect(r).toEqual({ content: ['main'], strip: [], headings: { h1: 2 }, landmarks: [], rules: [{ kind: 'drop-section', heading: 'x' }] });
    expect(errors).toHaveLength(3);
  });

  it('outlines a page without its scripts', () => {
    const outline = sourceOutline('<body><main id="m" class="docs"><script>x()</script><h1>Title</h1></main></body>', URL);
    expect(outline).toBe('body\n  main#m.docs\n    h1 "Title"');
  });
});

describe('SourceRecipesService', () => {
  function harness() {
    const link: Record<string, unknown> = {
      id: 'l1',
      connectorId: 'c1',
      documentId: 'd1',
      baseline: null,
      fingerprint: null,
      heldAt: null,
      heldReason: null,
      structureChangedAt: null,
      bodyHash: null,
      contentHash: 'h0',
      pausedAt: null,
    };
    const prisma = {
      connectorLink: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(link, data)),
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          if ('heldAt' in where && link.heldAt !== where.heldAt) return { count: 0 };
          Object.assign(link, data);
          return { count: 1 };
        }),
      },
      sourceRecipe: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      $transaction: vi.fn(),
    };
    const storage = { putObjectText: vi.fn(async () => undefined), sourceBodyObjectKey: () => 'k' };
    const service = new SourceRecipesService(prisma as never, storage as never, {} as never, {} as never, {} as never, {} as never);
    const draft = vi.spyOn(service, 'draft').mockResolvedValue(null);
    const row = { id: 'c1', workspaceId: 'w1' };
    return { link, prisma, service, draft, read: (body: string) => service.read(row as never, { ...link } as never, source(body)) };
  }

  it('holds a failing version once, drafts once, and releases on a passing one', async () => {
    const h = harness();
    expect(await h.read(html(BODY))).toMatchObject({ held: false });
    expect((h.link.baseline as { headings: string[] }).headings).toEqual(expect.arrayContaining(['setup', 'usage']));

    const stub = html('<h1>Other</h1><p>Sign in to read.</p>');
    expect(await h.read(stub)).toEqual({ held: true, newlyHeld: true });
    expect(await h.read(stub)).toEqual({ held: true, newlyHeld: false });
    expect(h.draft).toHaveBeenCalledTimes(1);
    expect(h.link.heldReason).toBe('words,headings');

    expect(await h.read(html(BODY))).toMatchObject({ held: false });
    expect(h.link.heldAt).toBeNull();
  });

  it('notes a layout change that still passes, with no draft', async () => {
    const h = harness();
    await h.read(html(BODY));
    expect(await h.read(html(BODY, 'section class="docs"'))).toMatchObject({ held: false });
    expect(h.link.structureChangedAt).toBeInstanceOf(Date);
    expect(h.draft).not.toHaveBeenCalled();
  });

  it('refuses to save a recipe whose checks fail, writing nothing', async () => {
    const h = harness();
    await h.read(html(BODY));
    (h.service as unknown as { body: () => Promise<unknown> }).body = async () => source(html(BODY));
    await expect(h.service.save({ id: 'c1' } as never, h.link as never, recipe({ landmarks: ['#gone'] }), undefined, 'u1')).rejects.toMatchObject({
      status: 409,
    });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});
