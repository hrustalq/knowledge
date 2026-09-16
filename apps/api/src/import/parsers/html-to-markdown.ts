import TurndownService from 'turndown';
import { Defuddle } from 'defuddle/node';
import { countWords } from './parser.types.js';

/**
 * HTML → markdown, server side.
 *
 * The settings mirror `apps/web/src/lib/markdown/serialize.ts` deliberately:
 * imported markdown has to be indistinguishable from markdown the WYSIWYG
 * editor wrote, or the first save of an imported page would produce a diff full
 * of formatting churn nobody asked for.
 *
 * Turndown ships `@mixmark-io/domino`, so this needs no DOM in Node.
 */
const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});

turndown.keep(['u', 'mark', 'sub', 'sup']);
/** Chrome around the content: never part of the document being imported. */
// `head` matters as much as the rest: turndown renders <title> as ordinary
// text, so without this the page title arrives twice — once as the title and
// again as the first line of the body.
turndown.remove(['head', 'title', 'meta', 'link', 'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'iframe']);

function children(node: Node): Element[] {
  return [...(node.childNodes ?? [])].filter((n): n is Element => n.nodeType === 1);
}

/** GFM tables. Turndown has no table support out of the box. */
turndown.addRule('knTable', {
  filter: 'table',
  replacement: (_content, node) => {
    const rows: Element[] = [];
    const collectRows = (parent: Node) => {
      for (const child of children(parent)) {
        if (child.nodeName === 'TR') rows.push(child);
        else collectRows(child);
      }
    };
    collectRows(node);
    if (rows.length === 0) return '';
    const cellText = (cell: Element) =>
      (cell.textContent ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
    const matrix = rows.map((row) => children(row).map(cellText));
    const width = Math.max(...matrix.map((r) => r.length));
    const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill('')];
    const [head, ...body] = matrix.map(pad);
    const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
    const divider = `| ${Array(width).fill('---').join(' | ')} |`;
    return `\n\n${[line(head), divider, ...body.map(line)].join('\n')}\n\n`;
  },
});

/** Fenced code blocks keep their language so highlighting survives. */
turndown.addRule('knCodeBlock', {
  filter: (node) => node.nodeName === 'PRE' && !!node.firstChild && node.firstChild.nodeName === 'CODE',
  replacement: (_content, node) => {
    const code = node.firstChild as HTMLElement;
    const cls = code.getAttribute?.('class') ?? '';
    const lang = /language-([\w+-]+)/.exec(cls)?.[1] ?? '';
    return `\n\n\`\`\`${lang}\n${(code.textContent ?? '').replace(/\n$/, '')}\n\`\`\`\n\n`;
  },
});

export function htmlToMarkdown(html: string): string {
  return turndown
    .turndown(html)
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** `<title>` when the document declares one — the best title a web page offers. */
export function htmlTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const text = m?.[1]?.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 200) : undefined;
}

/** What a page turned out to be, once the chrome around it was scored away. */
export interface ExtractedArticle {
  markdown: string;
  title?: string;
  author?: string;
  published?: string;
  site?: string;
  /**
   * Words in the article that survived scoring. This is the number that says
   * whether extraction actually found anything, and it is the only honest
   * trigger for a fallback: a client-rendered page answers 200 with an empty
   * shell, and some anti-bot walls answer with nonstandard codes, so HTTP
   * status is the wrong signal in both directions.
   */
  wordCount: number;
  /** True when the serializer ran over the whole document, scoring having failed. */
  fellBack: boolean;
}

/**
 * Article extraction, then markdown — two questions, two answers.
 *
 * `htmlToMarkdown` answers "how does HTML become *our* markdown", and its
 * settings are pinned to the editor's serializer so an imported page does not
 * churn on its first save. It does not answer "which part of this page is the
 * article", and it was never asked to: its denylist drops `nav`/`header`/
 * `footer`/`aside`, so everything boilerplate that does not happen to sit
 * inside one of those — sidebars, related-article rails, comment sections,
 * cookie-notice remnants — survives into the reader's context. On the standard
 * extraction benchmark that gap is roughly 0.67 F1 against roughly 0.92.
 *
 * So Defuddle scores the DOM and hands back the article as HTML, and the
 * existing serializer turns that into markdown. One serializer, one scoring
 * pass in front of it — not a second answer to the first question, which is
 * what feature 25 was right to refuse.
 */
export async function extractArticle(html: string, url: string): Promise<ExtractedArticle> {
  try {
    const result = await Defuddle(html, url, {
      // Defuddle's async extractors fetch from third-party APIs when local
      // extraction comes up empty. That is an outbound request to a host no
      // source policy ever authorized, issued from inside what the caller
      // believes is one fetch of one URL — precisely the ordering feature 25
      // exists to protect (policy decides whether a page is fetched at all).
      // Off, always.
      useAsync: false,
      // An image is a link in markdown. The model cannot see it, and each one
      // spends context on a URL nobody will follow.
      removeImages: true,
    });

    const article = (result.content ?? '').trim();
    // Non-empty markup is not non-empty text, and the gap between them is
    // exactly a script-rendered shell: Defuddle hands back `<div id="root">`,
    // which is truthy, scores zero words, and would otherwise be reported as a
    // successful extraction that happens to say nothing — passing the caller a
    // page with no text *and* no warning, since a thin-content check keyed on
    // a word count cannot fire on zero. Words are the honest test, so a scored
    // result carrying none falls through to serializing the whole document,
    // which cannot do worse and usually does better.
    if (article && (result.wordCount ?? 0) > 0) {
      return {
        markdown: htmlToMarkdown(article),
        title: metaField(result.title),
        author: metaField(result.author),
        published: metaField(result.published),
        site: metaField(result.site),
        wordCount: result.wordCount ?? 0,
        fellBack: false,
      };
    }
  } catch {
    // Scoring is an improvement on the fallback, never a precondition for it:
    // a page Defuddle cannot score is still a page we can serialize, and a
    // thrown extractor must not turn a retrieved page into "the page was empty".
  }

  const markdown = htmlToMarkdown(html);
  return {
    markdown,
    title: htmlTitle(html),
    wordCount: countWords(markdown),
    fellBack: true,
  };
}

/** Defuddle reports absent metadata as `''`; a caller wants absence to read as absence. */
function metaField(value: string | undefined): string | undefined {
  const text = value?.trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, 200) : undefined;
}
