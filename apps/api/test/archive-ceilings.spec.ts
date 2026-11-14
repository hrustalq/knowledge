import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

/**
 * #1109: an archive is inflated only up to a ceiling, counted from each entry's
 * declared size before it is inflated; fflate writes an entry into a buffer of
 * its declared size, so a lying header is cut short rather than believed.
 */
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));
const { safeFetch } = await import('../src/common/safe-fetch.js');
const { PptxParser } = await import('../src/import/parsers/pptx.parser.js');
const { DocxParser } = await import('../src/import/parsers/docx.parser.js');
const { downloadRepoArchive } = await import('../src/connectors/adapters/repo-archive.js');

const MB = 1024 * 1024;
const ctx = (maxInflatedBytes: number) => ({
  workspaceId: 'w',
  importId: 'i',
  userId: 'u',
  filename: 'f',
  contentType: 'application/octet-stream',
  onStage: async () => undefined,
  maxInflatedBytes,
});
/** An Office-shaped archive whose one big part compresses to almost nothing. */
const office = (parts: Record<string, string>, big: string) =>
  zipSync({ ...Object.fromEntries(Object.entries(parts).map(([n, x]) => [n, new TextEncoder().encode(x)])), [big]: new Uint8Array(8 * MB) }, { level: 9 });

describe('archive ceilings (#1109)', () => {
  it('PPTX: a deck that would inflate past the ceiling is refused before it is inflated', async () => {
    const deck = office({ 'ppt/slides/slide1.xml': '<p:sld><a:t>Hi</a:t></p:sld>' }, 'ppt/media/huge.bin');
    expect(deck.length).toBeLessThan(MB);
    await expect(new PptxParser().parse(deck, ctx(4 * MB))).rejects.toThrow(/inflate/);
    await expect(new PptxParser().parse(deck, ctx(16 * MB))).resolves.toMatchObject({ meta: { slides: 1 } });
  });

  it('DOCX: the same, before mammoth reads it', async () => {
    const doc = office({ '[Content_Types].xml': '<Types/>' }, 'word/media/huge.bin');
    await expect(new DocxParser().parse(doc, ctx(4 * MB))).rejects.toThrow(/inflate/);
  });

  it('a repository archive: past the ceiling is refused, a file over the per-file cap is skipped uninflated', async () => {
    const parts = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`repo-main/part-${i}.txt`, new TextEncoder().encode('b'.repeat(900_000))]));
    const zip = zipSync({ 'repo-main/README.md': new TextEncoder().encode('# Hi\n'), ...parts, 'repo-main/big.txt': new Uint8Array(8 * MB) }, { level: 9 });
    vi.mocked(safeFetch).mockImplementation(async () => new Response(zip, { status: 200 }));
    const repo = (archiveMaxBytes: number) =>
      downloadRepoArchive({
        connectorId: 'c',
        workspaceId: 'w',
        config: { repoUrl: 'https://github.com/o/repo', branch: 'main' },
        credential: null,
        onStage: async () => undefined,
        debug: () => undefined,
        allowPrivate: false,
        archiveMaxBytes,
      } as never);
    await expect(repo(4 * MB)).rejects.toThrow(/inflate/);
    const read = await repo(16 * MB);
    expect([...read.files.keys()].sort()).toEqual(['README.md', ...Object.keys(parts).map((n) => n.slice('repo-main/'.length))].sort());
    expect(read.skipped.oversize).toBe(1);
  });
});
