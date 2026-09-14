/**
 * markdown → HTML. The single parser for the whole app: the read view renders
 * this HTML directly, and the editor hands the same HTML to TipTap, whose node
 * `parseHTML` rules turn it into the document. One parser means a page can
 * never look one way when read and another way when opened for editing.
 */
import { Marked, type Tokens } from 'marked';
import { KN, escapeHtml, isPanelType } from './nodes.js';
import { pageTitleHref, type PageRefResolver } from '../page-refs.js';

export type { PageRefResolver };

export interface RenderOptions {
  /**
   * Turn `[text](Exact Page Title)` into a link to that page.
   *
   * Authors — the assistant especially — reach for a page by the name they see
   * in the sidebar, and CommonMark refuses it: an unescaped space ends a link
   * destination, so `[Модель данных](OrderHub — Модель данных)` is not a link
   * at all, it is literal text with brackets in it. Resolving those titles here
   * makes the reference work without any page being rewritten, exactly as
   * glossary terms are linked at read time and never stored (docs/features/14).
   *
   * Read surfaces only. Leave it off in an editor: the round trip back through
   * the serializer would rewrite the destination to `/documents/<id>`, turning
   * "someone opened the page" into a content change nobody asked for.
   */
  resolvePage?: PageRefResolver;
}

/** `> [!NOTE]` on the blockquote's first line, GitHub alert syntax. */
const ALERT_RE = /^\s*\[!([A-Za-z]+)\]\s*\n?/;

function stripAlertMarker(html: string): string {
  // The marker survives parsing as literal text at the top of the first
  // paragraph; remove it there rather than pre-lexing, so the body keeps its
  // normal markdown treatment (links, emphasis, nested lists all still work).
  return html.replace(/^(\s*<p>)\s*\[!([A-Za-z]+)\]\s*(<br\s*\/?>)?\s*/i, '$1').replace(/^\s*<p>\s*<\/p>\s*/, '');
}

const marked = new Marked({ gfm: true, breaks: false });

marked.use({
  renderer: {
    /** Fenced blocks: `mermaid` and `drawing` become rich nodes, everything else stays code. */
    code(token: Tokens.Code): string {
      const lang = (token.lang ?? '').trim().split(/\s+/)[0].toLowerCase();
      if (lang === 'mermaid') {
        return `<div ${KN.mermaid}="1"><pre>${escapeHtml(token.text)}</pre></div>`;
      }
      if (lang === 'drawing') {
        return `<div ${KN.drawing}="1"><pre>${escapeHtml(token.text)}</pre></div>`;
      }
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      return `<pre><code${cls}>${escapeHtml(token.text)}</code></pre>`;
    },

    /** GitHub alert blockquotes become panels; plain ones stay blockquotes. */
    blockquote(token: Tokens.Blockquote): string {
      const inner = this.parser.parse(token.tokens);
      const match = ALERT_RE.exec(token.text ?? '');
      const kind = match?.[1]?.toLowerCase();
      if (kind && isPanelType(kind)) {
        return `<div ${KN.panel}="${kind}">${stripAlertMarker(inner)}</div>`;
      }
      return `<blockquote>${inner}</blockquote>`;
    },

    /**
     * Task lists get TipTap's shape (`data-type`/`data-checked`) instead of
     * marked's disabled `<input>`, so the same HTML is both what the editor
     * parses and what the read view styles.
     */
    list(token: Tokens.List): string {
      const items = token.items.map((item) => this.listitem(item)).join('');
      if (token.items.some((i) => i.task)) return `<ul data-type="taskList">${items}</ul>`;
      if (token.ordered) {
        const start = token.start && token.start !== 1 ? ` start="${token.start}"` : '';
        return `<ol${start}>${items}</ol>`;
      }
      return `<ul>${items}</ul>`;
    },

    listitem(token: Tokens.ListItem): string {
      if (!token.task) return `<li>${this.parser.parse(token.tokens)}</li>`;
      // marked injects a checkbox token into the item; drop it and carry the
      // state on the <li> where TipTap's TaskItem expects it.
      const tokens = token.tokens.filter((t) => t.type !== 'checkbox');
      const body = this.parser.parse(tokens) || '<p></p>';
      return `<li data-type="taskItem" data-checked="${token.checked ? 'true' : 'false'}">${body}</li>`;
    },

    /** Internal document links become mention chips. */
    link(token: Tokens.Link): string {
      const href = token.href ?? '';
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      const text = this.parser.parseInline(token.tokens);
      if (/^\/documents\/[0-9a-fA-F-]{36}$/.test(href)) {
        return `<a href="${escapeHtml(href)}" ${KN.mention}="1"${title}>${text}</a>`;
      }
      // The other half of the page-title reference (see RenderOptions): a model
      // that percent-encodes the title writes a destination with no spaces in
      // it, so CommonMark *accepts* it — and the reader gets a relative link to
      // `OrderHub%20%E2%80%94%20...` that 404s. Same authored intent as the
      // unencoded form, so it resolves the same way, and stays exactly as it
      // is when the title names no page.
      const asTitle = pageTitleHref(href);
      if (asTitle) {
        const documentId = resolvePage?.(asTitle);
        if (documentId) {
          return `<a href="/documents/${encodeURIComponent(documentId)}" ${KN.mention}="1"${title}>${text}</a>`;
        }
      }
      const external = /^https?:\/\//i.test(href);
      const rel = external ? ' rel="noopener noreferrer nofollow" target="_blank"' : '';
      return `<a href="${escapeHtml(href)}"${title}${rel}>${text}</a>`;
    },
  },
});

/* --------------------------------------------------- page-title references */

/** `[text](anything but a newline or a paren)`, before CommonMark judges it. */
const PAGE_REF_RE = /^\[((?:\\.|[^[\]\\\n])+)\]\(([^()\n]+)\)/;

/** A CommonMark link title: `"…"`, `'…'` or `(…)`. */
const LINK_TITLE_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))$/;

/**
 * True when CommonMark would *not* read this as a link, so claiming it steals
 * nothing. A bare destination runs to the first space; what follows may only be
 * a title. `OrderHub — Модель данных` leaves `— Модель данных` after the first
 * space, which is no title, so the construct fails and marked emits the whole
 * thing as text — which is the only case this extension exists to catch.
 */
function commonMarkRefuses(inner: string): boolean {
  if (inner.startsWith('<')) return false; // `<a b>` is a legal destination
  const split = /^(\S+)\s+([\s\S]+)$/.exec(inner);
  if (!split) return false; // no space: an ordinary link, leave it alone
  return !LINK_TITLE_RE.test(split[2].trim());
}

interface PageRefToken extends Tokens.Generic {
  type: 'pageRef';
  documentId: string;
  tokens: Tokens.Generic[];
}

/**
 * Set for the duration of one `markdownToHtml` call. A module-level slot rather
 * than an option threaded through marked because `parse` is synchronous — no
 * two renders can be in flight at once — and marked gives an extension no other
 * channel to per-call state.
 */
let resolvePage: PageRefResolver | null = null;

marked.use({
  extensions: [
    {
      name: 'pageRef',
      level: 'inline',
      // `start` decides where marked cuts a plain-text run short to give this
      // extension a look. With no resolver there is nothing to look for, and
      // returning -1 keeps text tokens whole — so a render without the option
      // is byte-for-byte the render this file did before the extension existed.
      start: (src: string) => (resolvePage ? src.indexOf('[') : -1),
      tokenizer(src: string): PageRefToken | undefined {
        if (!resolvePage) return undefined;
        const match = PAGE_REF_RE.exec(src);
        if (!match) return undefined;
        if (!commonMarkRefuses(match[2])) return undefined;
        // Unresolvable titles are deliberately left as the literal text they
        // are today. Inventing a link to a page that does not exist would be
        // worse than the brackets: it reads as a promise the workspace cannot
        // keep, and this corpus is full of references to pages never created.
        const documentId = resolvePage(match[2]);
        if (!documentId) return undefined;
        return {
          type: 'pageRef',
          raw: match[0],
          documentId,
          tokens: this.lexer.inlineTokens(match[1]),
        };
      },
      renderer(token) {
        const ref = token as PageRefToken;
        const text = this.parser.parseInline(ref.tokens);
        return `<a href="/documents/${encodeURIComponent(ref.documentId)}" ${KN.mention}="1">${text}</a>`;
      },
    },
  ],
});

export function markdownToHtml(md: string, options: RenderOptions = {}): string {
  resolvePage = options.resolvePage ?? null;
  try {
    return marked.parse(md ?? '', { async: false }) as string;
  } finally {
    resolvePage = null;
  }
}

/**
 * Attributes DOMPurify must not strip. The read view sanitizes this HTML, and
 * every rich block is identified by a data-* attribute — losing them would
 * silently degrade every panel, layout and embed into a bare <div>.
 */
export const SANITIZE_CONFIG: { ADD_TAGS: string[]; ADD_ATTR: string[] } = {
  ADD_TAGS: ['details', 'summary', 'time', 'mark', 'u', 'object'],
  ADD_ATTR: [
    'data-kn-mermaid',
    'data-kn-drawing',
    'data-kn-panel',
    'data-kn-layout',
    'data-kn-col',
    'data-kn-file',
    'data-kn-name',
    'data-kn-mime',
    'data-kn-size',
    'data-kn-status',
    'data-kn-toc',
    'data-kn-mention',
    'data-kn-user',
    'data-kn-agent',
    'data-kn-api',
    'data-kn-path',
    'data-kn-api-section',
    'data-type',
    'data-checked',
    'data-align',
    'colspan',
    'rowspan',
    'colwidth',
    'width',
    'height',
    'open',
    'start',
    'target',
  ],
};

/**
 * Heading text → anchor id. Shared, not copied, because three surfaces assign
 * these ids independently — the read view (MarkdownView), the read-only editor
 * (DocumentCanvas) and the docs rail's section links — and a deep link into a
 * section only survives the move between them while all three agree.
 *
 * Callers dedupe repeats themselves (`id`, `id-1`, `id-2`), since the counter
 * belongs to one document's traversal rather than to the function.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
}
