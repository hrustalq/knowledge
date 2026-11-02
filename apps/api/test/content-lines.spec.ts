import { describe, expect, it } from 'vitest';
import type { DocumentContentResponse } from '@knowledge/contracts';
import { contentLines, parseLinesParam } from '../src/documents/content-lines.js';

// #708: a passage of a content read, by 1-based line.
describe('contentLines', () => {
  const markdown = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
  const content: DocumentContentResponse = {
    documentId: 'doc-1',
    revisionId: 'rev-1',
    contentType: 'text/markdown',
    frontmatter: null,
    markdown,
  };

  it('returns exactly those lines, the bounds and a pinned reference', () => {
    const res = contentLines(content, { start: 40, end: 52 }, 'https://kb.example.com/');
    expect(res.markdown).toBe(markdown.split('\n').slice(39, 52).join('\n'));
    expect(res).toMatchObject({ startLine: 40, endLine: 52, totalLines: 60, revisionId: 'rev-1' });
    expect(res.reference).toBe('https://kb.example.com/documents/doc-1?revision=rev-1#L40-L52');
    expect(contentLines(content, { start: 7, end: 7 }, 'https://kb').reference).toMatch(/#L7$/);
  });

  it('refuses a span outside the body, or backwards, with a 400', () => {
    for (const span of [{ start: 59, end: 61 }, { start: 0, end: 2 }, { start: 5, end: 4 }]) {
      expect(() => contentLines(content, span, 'https://kb')).toThrow(expect.objectContaining({ status: 400 }));
    }
  });

  it('parses 40-52 and 40, and refuses anything else', () => {
    expect(parseLinesParam('40-52')).toEqual({ start: 40, end: 52 });
    expect(parseLinesParam('40')).toEqual({ start: 40, end: 40 });
    expect(() => parseLinesParam('L40')).toThrow(expect.objectContaining({ status: 400 }));
  });
});
