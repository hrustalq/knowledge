import { marked } from 'marked';

/**
 * Markdown → HTML, server side. The push-direction mirror of
 * `import/parsers/html-to-markdown.ts`.
 *
 * Confluence stores pages as XHTML ("storage format"), so publishing a page
 * back means rendering its markdown. Kept deliberately plain: no raw HTML
 * passthrough and no ids on headings, because Confluence rejects unknown markup
 * in storage format and generates its own anchors.
 */
marked.setOptions({ gfm: true, breaks: false });

export function markdownToHtml(markdown: string): string {
  const html = marked.parse(markdown, { async: false });
  return typeof html === 'string' ? html.trim() : '';
}

/**
 * Confluence storage format is XHTML: every tag must close. `marked` emits HTML5
 * void elements unclosed, which the storage-format parser rejects outright, so
 * they are closed here rather than by hand at each call site.
 */
const VOID_TAGS = /<(br|hr|img|col)([^>]*?)\s*\/?>/gi;

export function markdownToStorageFormat(markdown: string): string {
  return markdownToHtml(markdown).replace(VOID_TAGS, (_m, tag: string, attrs: string) => `<${tag}${attrs} />`);
}
