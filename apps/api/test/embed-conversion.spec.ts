import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEmbedUrl } from '@knowledge/contracts';
import { embedGroupsOf, embedLoneUrls } from '@knowledge/editor-schema/markdown';

/**
 * Figma embeds on their way in and out (#470, phase 7): every converter reads
 * them through `parseEmbedUrl` and writes one group spelling; pulls pin the
 * version; pushes write the target's own embed.
 */
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));
const { safeFetch } = await import('../src/common/safe-fetch.js');
const { htmlToMarkdown } = await import('../src/import/parsers/html-to-markdown.js');
const { countMacros } = await import('../src/connectors/adapters/confluence.adapter.js');
const { markdownToStorageFormat } = await import('../src/connectors/adapters/markdown-to-html.js');
const { markdownToBlocks, renderBlock } = await import('../src/connectors/adapters/notion.adapter.js');
const { FigmaFilesService } = await import('../src/embeds/figma-files.service.js');
const mockFetch = vi.mocked(safeFetch);
afterEach(() => mockFetch.mockReset());

const KEY = 'AbCdEfGhIj12';
const CANONICAL = `https://www.figma.com/design/${KEY}/?node-id=1-2`;
const one = (md: string) => {
  const groups = embedGroupsOf(md);
  expect(groups).toHaveLength(1);
  return groups[0]!;
};

describe('Figma embed URLs', () => {
  it.each([
    `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(`https://www.figma.com/file/${KEY}/App?node-id=1-2`)}`,
    `https://embed.figma.com/design/${KEY}/App?node-id=1-2&embed-host=share`,
  ])('reads %s as the frame it shows', (url) => {
    expect(parseEmbedUrl(url)).toEqual({ provider: 'figma', fileKey: KEY, nodeId: '1:2', board: false });
  });
});

describe('pulled HTML (the importer and Confluence)', () => {
  it('turns a Figma iframe into an unpinned group, where other iframes are still dropped', () => {
    const md = htmlToMarkdown(
      `<p>Before</p><iframe title="Checkout" src="https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(CANONICAL)}"></iframe><iframe src="https://evil.test/x"></iframe><p>After</p>`,
    );
    expect(one(md)).toEqual({ layout: 'strip', caption: 'Checkout', items: [{ url: CANONICAL, version: null, caption: '' }] });
    expect(md).not.toContain('evil.test');
    expect(md).toMatch(/^Before\n\n<figure/);
  });

  it('reads a Confluence smart link shown as an embed, and a macro that wraps a Figma link', () => {
    expect(one(htmlToMarkdown(`<p><a href="${CANONICAL}" data-card-appearance="embed">${CANONICAL}</a></p>`)).items[0]!.url).toBe(CANONICAL);
    const macro = `<ac:structured-macro ac:name="figma"><ac:parameter ac:name="url">${CANONICAL}</ac:parameter></ac:structured-macro>`;
    expect(one(htmlToMarkdown(macro)).items[0]!.url).toBe(CANONICAL);
    // A plain link stays a link.
    expect(embedGroupsOf(htmlToMarkdown(`<p>See <a href="${CANONICAL}">the design</a></p>`))).toEqual([]);
  });

  it('does not report a Figma macro as lost, and still reports others', () => {
    const storage =
      `<ac:structured-macro ac:name="figma-embed"><ac:parameter ac:name="url">${CANONICAL}</ac:parameter></ac:structured-macro>` +
      '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">X-1</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="toc"/>';
    expect(countMacros(storage)).toEqual(['jira', 'toc']);
  });
});

describe('a Notion page', () => {
  it('turns a Figma embed block into a group, and still reports any other embed as unsupported', () => {
    const unsupported = new Set<string>();
    const md = renderBlock({ id: 'b1', type: 'embed', embed: { url: `https://www.figma.com/file/${KEY}/App?node-id=1-2`, caption: [{ plain_text: 'Checkout' }] } }, unsupported);
    expect(one(md!)).toEqual({ layout: 'strip', caption: 'Checkout', items: [{ url: CANONICAL, version: null, caption: '' }] });
    expect(renderBlock({ id: 'b2', type: 'embed', embed: { url: 'https://www.youtube.com/watch?v=x' } }, unsupported)).toBeNull();
    expect([...unsupported]).toEqual(['embed']);
  });
});

describe('markdown-git', () => {
  it('embeds a Figma link alone on its line, and leaves one inside a sentence', () => {
    const md = embedLoneUrls(`Intro\n\n${CANONICAL}\n\nSee ${CANONICAL} too.\n\n<${CANONICAL}>\n`);
    expect(embedGroupsOf(md)).toHaveLength(2);
    expect(md).toContain(`See ${CANONICAL} too.`);
    expect(embedLoneUrls('Nothing here.\n')).toBe('Nothing here.\n');
  });
});

describe('pushing a group', () => {
  const group = `Intro\n\n<figure data-kn-embed="grid">\n<a href="${CANONICAL}" data-kn-version="7">Sign-in</a>\n<a href="https://www.figma.com/board/${KEY}/" data-kn-version="3">Flow</a>\n<figcaption>Checkout &amp; more</figcaption>\n</figure>\n\nAfter`;

  it('to Notion: one embed block per item, then the caption', () => {
    const blocks = markdownToBlocks(group);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'embed', 'embed', 'paragraph', 'paragraph']);
    expect(blocks[1]).toMatchObject({ embed: { url: CANONICAL } });
    expect(JSON.stringify(blocks[3])).toContain('Checkout & more');
  });

  it('to Confluence: a smart link shown as an embed per item, never the <figure>', () => {
    const storage = markdownToStorageFormat(group);
    expect(storage).not.toContain('<figure');
    expect(storage).toContain(`<a href="${CANONICAL}" data-card-appearance="embed">`);
    expect(storage).toContain('<p>Checkout &amp; more</p>');
  });
});

describe('pinning a pulled page', () => {
  it('pins each unpinned item the allowlist reaches, captions it, and leaves the rest', async () => {
    const prisma = {
      connector: { findMany: vi.fn(async () => [{ id: 'c1', kind: 'figma', enabled: true, workspaceId: 'ws', config: { allowlist: 'project:222' } }]) },
      embedFile: {
        findUnique: vi.fn(async ({ where }: { where: { workspaceId_provider_fileKey: { fileKey: string } } }) =>
          where.workspaceId_provider_fileKey.fileKey === KEY ? { fileKey: KEY, projectId: '222', teamId: null, connectorId: 'c1' } : null,
        ),
        deleteMany: vi.fn(() => 'd'),
        upsert: vi.fn(() => 'u'),
      },
      $transaction: vi.fn(async () => []),
    };
    const connectors = { contextFor: vi.fn(async (row: { config: unknown }) => ({ config: row.config, credential: 'x', allowPrivate: false, debug: () => undefined })) };
    mockFetch.mockImplementation(async (url) => {
      const u = new URL(String(url));
      if (u.pathname === `/v1/files/${KEY}/nodes`) return new Response(JSON.stringify({ version: '42', nodes: { '1:2': { document: { name: 'Sign-in' } } } }));
      if (u.pathname === '/v1/projects/222/files') return new Response(JSON.stringify({ files: [{ key: KEY, name: 'App' }] }));
      throw new Error(`unexpected ${u}`);
    });
    const service = new FigmaFilesService(prisma as never, connectors as never);
    const md = `<figure data-kn-embed="strip">\n<a href="${CANONICAL}">${CANONICAL}</a>\n<a href="https://www.figma.com/design/OTHERKEY9999/">https://www.figma.com/design/OTHERKEY9999/</a>\n</figure>`;
    const pinned = await service.pinMarkdown('ws', md);
    expect(one(pinned).items).toEqual([
      { url: CANONICAL, version: '42', caption: 'Sign-in' },
      { url: 'https://www.figma.com/design/OTHERKEY9999/', version: null, caption: '' },
    ]);
    await expect(service.pinMarkdown('ws', 'No embeds.')).resolves.toBe('No embeds.');
  });
});
