/**
 * HTML → markdown. The inverse of render.ts, and the reason the WYSIWYG editor
 * can exist at all without changing what the backend stores: the ingestion
 * worker, the structural diff, merge requests and the frontmatter relation
 * extractor all still receive ordinary markdown.
 *
 * Every rule here has a matching branch in render.ts. When you add a node,
 * add both halves or it will round-trip lossily.
 */
import TurndownService from 'turndown';
import { KN } from './nodes.js';

const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
  blankReplacement: (_content, node) => {
    // Turndown routes every childless element straight here, before rules run,
    // so content-free nodes have to be recognised at this point or they vanish.
    const el = node as HTMLElement;
    if (el.hasAttribute?.(KN.toc)) return `\n\n<div ${KN.toc}="1"></div>\n\n`;
    // An empty paragraph between two blocks is deliberate spacing in a
    // WYSIWYG editor, not noise — default turndown would delete it.
    return el.nodeName === 'P' ? '\n\n' : '';
  },
});

/** Marks with no markdown equivalent stay as HTML — markdown allows it, and the value survives. */
turndown.keep(['u', 'mark', 'sub', 'sup']);
turndown.remove(['script', 'style']);

function attr(node: Node, name: string): string {
  return (node as HTMLElement).getAttribute?.(name) ?? '';
}

/**
 * Turndown runs against the real DOM in the browser but a minimal shim under
 * Node (tests, SSR). Only childNodes/nodeName are guaranteed on both, so these
 * two helpers replace querySelector rather than assume it exists.
 */
function children(node: Node): Element[] {
  return [...(node.childNodes ?? [])].filter((n): n is Element => n.nodeType === 1);
}

function firstDescendant(node: Node, tagName: string): Element | null {
  for (const child of children(node)) {
    if (child.nodeName === tagName) return child;
    const nested = firstDescendant(child, tagName);
    if (nested) return nested;
  }
  return null;
}

/** ```mermaid — the fence the read view and the ingestion worker already know. */
turndown.addRule('knMermaid', {
  filter: (node) => (node as HTMLElement).hasAttribute?.(KN.mermaid),
  replacement: (_content, node) => `\n\n\`\`\`mermaid\n${(node.textContent ?? '').trim()}\n\`\`\`\n\n`,
});

/** ```drawing — a whiteboard scene as JSON. No prose inside, so a fence loses nothing. */
turndown.addRule('knDrawing', {
  filter: (node) => (node as HTMLElement).hasAttribute?.(KN.drawing),
  replacement: (_content, node) => {
    const scene = attr(node, 'data-scene') || (node.textContent ?? '').trim();
    return `\n\n\`\`\`drawing\n${scene}\n\`\`\`\n\n`;
  },
});

/** Panels → GitHub alert blockquotes, so the prose stays indexable prose. */
turndown.addRule('knPanel', {
  filter: (node) => (node as HTMLElement).hasAttribute?.(KN.panel),
  replacement: (content, node) => {
    const kind = (attr(node, KN.panel) || 'note').toUpperCase();
    const body = content
      .trim()
      .split('\n')
      .map((line) => (line.trim() ? `> ${line}` : '>'))
      .join('\n');
    return `\n\n> [!${kind}]\n${body}\n\n`;
  },
});

/** Expand → <details>, which is valid markdown-embedded HTML and renders everywhere. */
turndown.addRule('knExpand', {
  filter: (node) => node.nodeName === 'DETAILS',
  replacement: (content, node) => {
    const el = node as HTMLElement;
    const summary = firstDescendant(el, 'SUMMARY')?.textContent?.trim() ?? 'Details';
    // `content` is body-only: the knSummary rule below erases the summary so it
    // is written once, in the <summary> tag, instead of twice.
    const body = content.trim();
    const open = el.hasAttribute('open') ? ' open' : '';
    return `\n\n<details${open}>\n<summary>${summary}</summary>\n\n${body}\n\n</details>\n\n`;
  },
});

turndown.addRule('knSummary', {
  filter: (node) => node.nodeName === 'SUMMARY',
  replacement: () => '',
});

/** Multi-column sections. Markdown has no columns; semantic divs keep the text flowing and indexable. */
turndown.addRule('knLayout', {
  filter: (node) => (node as HTMLElement).hasAttribute?.(KN.layout),
  replacement: (content, node) =>
    `\n\n<div ${KN.layout}="${attr(node, KN.layout) || '2'}">\n${content.trim()}\n</div>\n\n`,
});

turndown.addRule('knColumn', {
  filter: (node) => (node as HTMLElement).hasAttribute?.(KN.column),
  replacement: (content) => `\n<div ${KN.column}>\n\n${content.trim()}\n\n</div>\n`,
});

/** File / PDF embeds. The filename stays as link text so a plain renderer still shows something useful. */
turndown.addRule('knFile', {
  filter: (node) => (node as HTMLElement).hasAttribute?.(KN.file),
  replacement: (_content, node) => {
    const id = attr(node, KN.file);
    const name = attr(node, 'data-kn-name') || 'attachment';
    const mime = attr(node, 'data-kn-mime');
    const size = attr(node, 'data-kn-size');
    const href = firstDescendant(node, 'A')?.getAttribute('href') ?? '';
    return `\n\n<div ${KN.file}="${id}" data-kn-name="${name}" data-kn-mime="${mime}"${size ? ` data-kn-size="${size}"` : ''}><a href="${href}">${name}</a></div>\n\n`;
  },
});

/** Inline status lozenge. */
turndown.addRule('knStatus', {
  filter: (node) => (node as HTMLElement).hasAttribute?.(KN.status),
  replacement: (content, node) =>
    `<span ${KN.status}="${attr(node, KN.status) || 'neutral'}">${content.trim()}</span>`,
});

/**
 * Inline person mention. A `<span>`, not a link, because there is no page to
 * send a reader to — and a chip that navigates nowhere is worse than one that
 * never promised to. The name stays inside the element as ordinary text, so
 * the chunker still embeds "@Ada Lovelace" as words on the page.
 */
turndown.addRule('knUser', {
  filter: (node) => (node as HTMLElement).hasAttribute?.(KN.user),
  replacement: (content, node) =>
    `<span ${KN.user}="${attr(node, KN.user)}">${content.trim() || '@?'}</span>`,
});

/** Table-of-contents macro: a marker, resolved at read time from the real headings. */
turndown.addRule('knToc', {
  filter: (node) => (node as HTMLElement).hasAttribute?.(KN.toc),
  replacement: () => `\n\n<div ${KN.toc}="1"></div>\n\n`,
});

/**
 * Images keep markdown syntax unless the author resized them — a width is real
 * authored intent, and `![]()` has nowhere to put it.
 */
turndown.addRule('knImage', {
  filter: 'img',
  replacement: (_content, node) => {
    const el = node as HTMLImageElement;
    const src = el.getAttribute('src') ?? '';
    const alt = el.getAttribute('alt') ?? '';
    const width = el.getAttribute('width');
    if (!src) return '';
    if (width) return `<img src="${src}" alt="${alt}" width="${width}" />`;
    return `![${alt}](${src})`;
  },
});

/** Task lists — TipTap's `data-checked` shape back to GFM checkboxes. */
turndown.addRule('knTaskItem', {
  filter: (node) =>
    node.nodeName === 'LI' && (node as HTMLElement).getAttribute?.('data-type') === 'taskItem',
  replacement: (content, node) => {
    const checked = (node as HTMLElement).getAttribute('data-checked') === 'true';
    const body = content
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
      .replace(/\n/gm, '\n  ');
    return `- [${checked ? 'x' : ' '}] ${body}\n`;
  },
});

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
    const matrix = rows.map((row) => children(row).map((c) => cellText(c)));
    const width = Math.max(...matrix.map((r) => r.length));
    const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill('')];
    const [head, ...body] = matrix.map(pad);
    const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
    const divider = `| ${Array(width).fill('---').join(' | ')} |`;
    return `\n\n${[line(head), divider, ...body.map(line)].join('\n')}\n\n`;
  },
});

/** Fenced code blocks keep their language so highlighting survives the round trip. */
turndown.addRule('knCodeBlock', {
  filter: (node) =>
    node.nodeName === 'PRE' &&
    !!node.firstChild &&
    node.firstChild.nodeName === 'CODE' &&
    !(node.parentNode as HTMLElement)?.hasAttribute?.(KN.mermaid) &&
    !(node.parentNode as HTMLElement)?.hasAttribute?.(KN.drawing),
  replacement: (_content, node) => {
    const code = node.firstChild as HTMLElement;
    const cls = code.getAttribute('class') ?? '';
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
