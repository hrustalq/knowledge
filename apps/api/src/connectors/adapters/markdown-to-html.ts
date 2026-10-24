import { marked } from 'marked';
import { rewriteEmbedGroups } from '@knowledge/editor-schema/markdown';
import { escapeHtml } from '@knowledge/editor-schema/nodes';

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
  return markdownToHtml(embedsAsSmartLinks(markdown)).replace(VOID_TAGS, (_m, tag: string, attrs: string) => `<${tag}${attrs} />`);
}

/**
 * An embed group (#470) as Confluence's own embed: one smart link per item
 * shown as an embed card (Cloud; Server shows a plain link), and the group
 * caption as a paragraph after. The layout is lost. Storage format would
 * reject the `<figure>` itself.
 */
function embedsAsSmartLinks(markdown: string): string {
  return rewriteEmbedGroups(markdown, (group) =>
    [
      ...group.items.map((item) => `<p><a href="${escapeHtml(item.url)}" data-card-appearance="embed">${escapeHtml(item.url)}</a></p>`),
      ...(group.caption ? [`<p>${escapeHtml(group.caption)}</p>`] : []),
    ].join('\n'),
  );
}
