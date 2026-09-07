/**
 * markdown → HTML. The single parser for the whole app: the read view renders
 * this HTML directly, and the editor hands the same HTML to TipTap, whose node
 * `parseHTML` rules turn it into the document. One parser means a page can
 * never look one way when read and another way when opened for editing.
 */
import { Marked, type Tokens } from 'marked';
import { KN, escapeHtml, isPanelType } from './nodes.js';

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
      const external = /^https?:\/\//i.test(href);
      const rel = external ? ' rel="noopener noreferrer nofollow" target="_blank"' : '';
      return `<a href="${escapeHtml(href)}"${title}${rel}>${text}</a>`;
    },
  },
});

export function markdownToHtml(md: string): string {
  return marked.parse(md ?? '', { async: false }) as string;
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
