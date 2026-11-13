import { afterEach, describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/common/frontmatter.js';
import { parseStoredTemplateSource, parseTemplateSource, TemplateSourceError } from '../src/templates/template-source.js';

// gray-matter reads the engine name from the text after the opening fence, and
// its defaults include one that evaluates the block. Page text must never pick it.
const g = globalThis as { __frontmatterRan?: number };
const fenced = (lang: string) => `---${lang}\n{ title: (globalThis.__frontmatterRan = 1, 'ran') }\n---\n# Body\n`;
const LANGS = ['js', 'javascript', 'JS', ' javascript ', 'coffee'];

afterEach(() => {
  delete g.__frontmatterRan;
});

describe('frontmatter fence language', () => {
  it.each(LANGS)('a page fenced %j is read as body and nothing is evaluated', (lang) => {
    const source = fenced(lang);
    const parsed = parseMarkdown(source);
    expect(g.__frontmatterRan).toBeUndefined();
    expect(parsed).toEqual({ data: {}, body: source });
  });

  it.each(LANGS)('a template fenced %j is refused, and a stored one reads as body, with nothing evaluated', (lang) => {
    const source = fenced(lang);
    expect(() => parseTemplateSource(source)).toThrowError(TemplateSourceError);
    expect(parseStoredTemplateSource(source)).toMatchObject({ body: source, data: {} });
    expect(g.__frontmatterRan).toBeUndefined();
  });

  it('still reads YAML, fenced bare or by name', () => {
    expect(parseMarkdown('---\ntitle: a\n---\n# A\n').data).toEqual({ title: 'a' });
    expect(parseMarkdown('---yaml\ntitle: b\n---\n# B\n').data).toEqual({ title: 'b' });
  });
});
