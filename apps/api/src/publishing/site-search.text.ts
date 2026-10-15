import { marked, type Token } from 'marked';
import type { SiteSearchTag } from '@knowledge/contracts';
import { readFrontmatterTags, tagEntityKey } from '../common/relations.js';

/**
 * What a published page is searched by (docs/features/44, issue #77 phase
 * 2b-2): its headings and its body as plain text, with the markup gone, so a
 * snippet reads as prose and `**Install**` matches `install`.
 *
 * Code blocks stay in — readers search for the identifiers in them — except
 * mermaid, whose source is diagram syntax, not words anyone looks for.
 */
export interface SearchText {
  headings: string;
  body: string;
}

/**
 * Longest body kept per page. A tsvector over 1 MB is an error, not a
 * truncation, and nobody searches past the first 100k characters of a page.
 */
export const SEARCH_BODY_MAX_CHARS = 100_000;
const SEARCH_HEADINGS_MAX_CHARS = 10_000;

export function searchTextOf(markdown: string): SearchText {
  const headings: string[] = [];
  const body: string[] = [];
  walk(marked.lexer(markdown), headings, body);
  return {
    headings: clean(headings.join('\n')).slice(0, SEARCH_HEADINGS_MAX_CHARS),
    body: clean(body.join('\n')).slice(0, SEARCH_BODY_MAX_CHARS),
  };
}

function walk(tokens: Token[], headings: string[], body: string[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        headings.push(inline(token.tokens ?? [], token.text));
        break;
      case 'paragraph':
      case 'text':
        body.push(inline(token.tokens ?? [], token.text));
        break;
      case 'code':
        if (token.lang !== 'mermaid') body.push(token.text);
        break;
      case 'blockquote':
        walk(token.tokens ?? [], headings, body);
        break;
      case 'list':
        for (const item of token.items) walk(item.tokens ?? [], headings, body);
        break;
      case 'table':
        for (const row of [token.header, ...token.rows]) {
          body.push(row.map((cell: { tokens: Token[]; text: string }) => inline(cell.tokens, cell.text)).join(' '));
        }
        break;
      case 'html':
        body.push(stripTags(token.text));
        break;
      default:
        // space, hr, def: nothing anyone searches for.
        break;
    }
  }
}

function inline(tokens: Token[], fallback: string): string {
  if (!tokens.length) return fallback;
  return tokens
    .map((token): string => {
      switch (token.type) {
        case 'strong':
        case 'em':
        case 'del':
        case 'link':
          return inline(token.tokens ?? [], token.text);
        case 'text':
          return token.tokens ? inline(token.tokens, token.text) : token.text;
        case 'image':
          return token.text; // the alt text
        case 'html':
          return stripTags(token.text);
        case 'br':
          return ' ';
        default:
          return 'text' in token && typeof token.text === 'string' ? token.text : '';
      }
    })
    .join('');
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/**
 * One line of plain text: entities decoded, GitHub alert markers (`[!NOTE]`)
 * and unpaired emphasis dropped, whitespace collapsed. Control characters go
 * too — the search snippet marks its hits with \u0001/\u0002, so the text must
 * never hold them.
 */
function clean(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gi, ' ')
    // Emphasis the lexer could not pair (`****Title`) is left as text.
    .replace(/\*{2,}/g, ' ')
    // eslint-disable-next-line no-control-regex -- removing them is the point (see above)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A revision's frontmatter tags as the reader filters them: one per canonical key, the author's spelling kept. */
export function searchTagsOf(frontmatter: Record<string, unknown>): SiteSearchTag[] {
  return readFrontmatterTags(frontmatter).map((name) => ({ key: tagEntityKey(name), name }));
}

/** The stored column back as tags; anything else reads as none. */
export function storedTags(value: unknown): SiteSearchTag[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (t): t is SiteSearchTag => !!t && typeof t === 'object' && typeof t.key === 'string' && typeof t.name === 'string',
  );
}
