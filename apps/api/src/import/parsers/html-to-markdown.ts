import TurndownService from 'turndown';

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
