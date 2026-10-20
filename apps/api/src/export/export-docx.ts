import {
  AlignmentType,
  Bookmark,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  ImageRun,
  InternalHyperlink,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type IRunOptions,
  type ISectionOptions,
  type ParagraphChild,
} from 'docx';
import { parseAttachmentPath } from '@knowledge/contracts/publishing';
import { markdownTokens, panelOf, slugifyHeading, type Token, type Tokens } from '@knowledge/editor-schema/markdown';
import { KN, isStatusColor, type PanelType, type StatusColor } from '@knowledge/editor-schema/nodes';

/**
 * The Word export (docs/features/45, #162): one `.docx` written in the worker
 * from the tokens of the one markdown parser (`markdownTokens`, the same
 * `marked` instance `markdownToHtml` renders with). Nothing here parses
 * markdown; it maps what the parser already decided.
 *
 * Why here and not in the web renderer like HTML and PDF: the worker holds the
 * attachment bytes a Word file embeds, and the web route answers JSON text
 * files. Writing the file where the bytes are keeps the render route as it is
 * and needs no Gotenberg.
 *
 * The mapping, pinned by export-docx.spec.ts:
 * - each page is its own section (a new sheet), its title Heading 1; a page's
 *   `#` is Heading 2 and so on, so the navigation pane nests pages' sections
 *   under their titles. More than one page adds a title page and contents.
 * - lists are Word lists (ordered ones restart per list), tasks a ☐/☑ prefix,
 *   tables Word tables with a repeating header row, code a monospace shaded
 *   paragraph.
 * - callouts (GitHub alerts) and `<details>` expands are shaded paragraphs
 *   with a coloured rule and a label line; a layout's columns flow one after
 *   another.
 * - links: a page in the export becomes an internal link to its title, a
 *   `#heading` one to that heading, a web address stays a web link; anything
 *   else keeps its text.
 * - images: an attachment the export carries is embedded (PNG, JPEG, GIF,
 *   BMP); a web image stays a link to its address.
 * - mermaid stays its source in a code block (Word cannot draw it); a drawing
 *   is named, since its scene is JSON.
 */

export interface DocxPage {
  documentId: string;
  title: string;
  depth: number;
  /** Frontmatter stripped. */
  markdown: string;
}

export interface DocxImage {
  bytes: Uint8Array;
  filename: string;
}

export interface DocxLabels {
  contents: string;
  /** "Exported 20 October 2026 · 3 pages", already formatted. */
  meta: string;
  onThisPage: string;
  noHeadings: string;
  diagramSource: string;
  drawing: string;
  /** `{name}` is the file's name. */
  attachment: string;
  panel: Record<PanelType, string>;
}

export interface DocxExportInput {
  title: string;
  pages: DocxPage[];
  /** Attachment id → bytes, for the image attachments of the exported pages. Anything absent is left out. */
  images: Map<string, DocxImage>;
  labels: DocxLabels;
}

export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/* ------------------------------------------------------------------ look */

const BODY_FONT = 'Calibri';
// Both carry Cyrillic, and every office suite has them or a metric twin (Carlito, Liberation Mono).
const CODE_FONT = 'Courier New';
const CODE_FILL = 'F3F4F6';
const RULE = 'D1D5DB';
/** Content width of an A4 sheet with 1" margins, in px at 96 dpi: images are scaled to fit. */
const MAX_IMAGE_PX = 600;
/** Twips per list level. */
const LIST_INDENT = 720;
const HANGING = 360;
const FRAME_INDENT = 240;

const PANEL_COLORS: Record<PanelType, { rule: string; fill: string }> = {
  note: { rule: '2563EB', fill: 'EFF6FF' },
  tip: { rule: '16A34A', fill: 'F0FDF4' },
  important: { rule: '7C3AED', fill: 'F5F3FF' },
  warning: { rule: 'D97706', fill: 'FFFBEB' },
  caution: { rule: 'DC2626', fill: 'FEF2F2' },
};

const STATUS_COLORS: Record<StatusColor, { color: string; fill: string }> = {
  neutral: { color: '374151', fill: 'E5E7EB' },
  blue: { color: '1E40AF', fill: 'DBEAFE' },
  green: { color: '166534', fill: 'DCFCE7' },
  amber: { color: '92400E', fill: 'FEF3C7' },
  red: { color: '991B1B', fill: 'FEE2E2' },
  violet: { color: '5B21B6', fill: 'EDE9FE' },
};

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

/* ------------------------------------------------------------------ helpers */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
};

/** marked keeps entities as written (`&amp;`), for the HTML renderer to pass through; Word wants the character. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

type ImageKind = 'png' | 'jpg' | 'gif' | 'bmp';

/** The pixel size of a PNG, JPEG, GIF or BMP, read from its header; null for anything Word cannot embed as is. */
export function imageInfo(bytes: Uint8Array): { type: ImageKind; width: number; height: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.byteLength;
  if (n >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { type: 'png', width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (n >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { type: 'gif', width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  if (n >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { type: 'bmp', width: Math.abs(dv.getInt32(18, true)), height: Math.abs(dv.getInt32(22, true)) };
  }
  if (n >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < n) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      // Start-of-frame markers carry the size; C4, C8 and CC are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpg', height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      i += 2 + dv.getUint16(i + 2);
    }
  }
  return null;
}

interface HtmlPiece {
  /** Tag name, lower case; absent for text. */
  tag?: string;
  closing?: boolean;
  attrs: Record<string, string>;
  text?: string;
}

/**
 * The tags and text of an HTML fragment the parser handed over as an `html`
 * token. Not an HTML parser: these fragments are the serializer's own
 * encodings (docs/features/03 — `<details>`, `data-kn-*` blocks, `<u>`,
 * status spans), so a tag reader is all they need.
 */
export function htmlPieces(html: string): HtmlPiece[] {
  const out: HtmlPiece[] = [];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)|</g;
  for (const m of html.matchAll(re)) {
    if (m[2]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[3] ?? '').matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
      }
      out.push({ tag: m[2].toLowerCase(), closing: m[1] === '/', attrs });
    } else if (m[4] !== undefined || m[0] === '<') {
      out.push({ attrs: {}, text: decodeEntities(m[4] ?? m[0]) });
    }
  }
  return out;
}

function plainText(tokens: Token[] | undefined): string {
  let out = '';
  for (const t of tokens ?? []) {
    if (t.type === 'html') continue;
    const children = (t as { tokens?: Token[] }).tokens;
    if (children?.length) out += plainText(children);
    else if (t.type === 'br') out += ' ';
    else out += decodeEntities((t as { text?: string }).text ?? '');
  }
  return out;
}

/* ------------------------------------------------------------------ writer */

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  underline?: boolean;
  highlight?: boolean;
  superScript?: boolean;
  subScript?: boolean;
  code?: boolean;
  color?: string;
  fill?: string;
  link?: boolean;
}

/** The block a paragraph sits in: list indentation and the callout/expand/quote it is framed by. */
interface BlockCtx {
  indent: number;
  frame?: { rule: string; fill?: string };
  listLevel: number;
}

interface PageHeading {
  slug: string;
  text: string;
  level: number;
  bookmark: string;
}

type Block = Paragraph | Table;

class PageWriter {
  /** Heading bookmarks in document order, consumed as the walk meets them. */
  private headingCursor = 0;
  private readonly headings: PageHeading[];

  constructor(
    private readonly doc: DocxWriter,
    private readonly index: number,
    private readonly tokens: Token[],
  ) {
    this.headings = this.collectHeadings();
  }

  write(title: string): Block[] {
    return [
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new Bookmark({ id: this.doc.pageBookmark(this.index), children: [new TextRun(title)] })],
      }),
      ...this.blocks(this.tokens, { indent: 0, listLevel: 0 }),
    ];
  }

  /**
   * The page's h1–h3 with the reader's ids (`slugifyHeading`, deduped as
   * public-render does), so `#section` links copied from the app land.
   */
  private collectHeadings(): PageHeading[] {
    const out: PageHeading[] = [];
    const seen = new Map<string, number>();
    const visit = (tokens: Token[]) => {
      for (const t of tokens) {
        if (t.type === 'heading' && t.depth <= 3) {
          const text = plainText(t.tokens);
          let slug = slugifyHeading(text) || 'section';
          const count = seen.get(slug) ?? 0;
          seen.set(slug, count + 1);
          if (count > 0) slug = `${slug}-${count}`;
          out.push({ slug, text, level: t.depth, bookmark: `kn_p${this.index}_h${out.length}` });
        }
        for (const child of childBlocks(t)) visit(child);
      }
    };
    visit(this.tokens);
    return out;
  }

  /* ---------------------------------------------------------------- blocks */

  private blocks(tokens: Token[], outer: BlockCtx): Block[] {
    const out: Block[] = [];
    // `<details>` opens in one html token and closes in a later sibling; what
    // lies between is framed as the expand's body.
    let ctx = outer;
    const saved: BlockCtx[] = [];
    for (const token of tokens) {
      switch (token.type) {
        case 'space':
        case 'def':
          break;
        case 'heading':
          out.push(this.heading(token as Tokens.Heading, ctx));
          break;
        case 'paragraph':
        case 'text':
          out.push(...this.paragraph(token as Tokens.Paragraph, ctx));
          break;
        case 'code':
          out.push(...this.code(token as Tokens.Code, ctx));
          break;
        case 'blockquote':
          out.push(...this.blockquote(token as Tokens.Blockquote, ctx));
          break;
        case 'list':
          out.push(...this.list(token as Tokens.List, ctx));
          break;
        case 'table':
          out.push(this.table(token as Tokens.Table));
          break;
        case 'hr':
          out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 1 } } }));
          break;
        case 'html': {
          const r = this.htmlBlock((token as Tokens.HTML).text, ctx, saved, outer);
          out.push(...r.blocks);
          ctx = r.ctx;
          break;
        }
        default: {
          const text = plainText([token]).trim();
          if (text) out.push(this.para(ctx, [new TextRun(text)]));
        }
      }
    }
    return out;
  }

  private para(ctx: BlockCtx, children: ParagraphChild[], extra: IParagraphOptions = {}): Paragraph {
    return new Paragraph({
      ...frameOptions(ctx),
      ...extra,
      children,
    });
  }

  private heading(token: Tokens.Heading, ctx: BlockCtx): Paragraph {
    const runs = this.inline(token.tokens, {});
    const level = HEADINGS[Math.min(token.depth, HEADINGS.length - 1)];
    const bookmark = token.depth <= 3 ? this.headings[this.headingCursor++]?.bookmark : undefined;
    return this.para(ctx, bookmark ? [new Bookmark({ id: bookmark, children: runs })] : runs, { heading: level });
  }

  private paragraph(token: Tokens.Paragraph | Tokens.Text, ctx: BlockCtx): Block[] {
    const tokens = token.tokens ?? [{ type: 'text', raw: token.raw, text: token.text } as Tokens.Text];
    // A paragraph that is only an image (the editor writes images as their
    // own block) is centred like the reader shows it.
    const children = this.inline(tokens, {});
    if (children.length === 0) return [];
    const imageOnly = tokens.every((t) => t.type === 'image' || (t.type === 'text' && !t.raw.trim()));
    return [this.para(ctx, children, imageOnly ? { alignment: AlignmentType.CENTER } : {})];
  }

  private code(token: Tokens.Code, ctx: BlockCtx): Block[] {
    const lang = (token.lang ?? '').trim().split(/\s+/)[0].toLowerCase();
    const { labels } = this.doc;
    if (lang === 'drawing') {
      return [this.para(ctx, [new TextRun({ text: labels.drawing, italics: true, color: '6B7280' })])];
    }
    const out: Block[] = [];
    if (lang === 'mermaid') {
      out.push(this.para(ctx, [new TextRun({ text: labels.diagramSource, italics: true, color: '6B7280' })], { keepNext: true }));
    }
    const lines = token.text.split('\n');
    out.push(
      new Paragraph({
        style: 'KnCode',
        indent: ctx.indent ? { left: ctx.indent } : undefined,
        children: lines.map((line, i) => new TextRun({ text: line, break: i > 0 ? 1 : undefined })),
      }),
    );
    return out;
  }

  private blockquote(token: Tokens.Blockquote, ctx: BlockCtx): Block[] {
    const panel = panelOf(token);
    if (!panel) {
      return this.blocks(token.tokens, { ...ctx, indent: ctx.indent + FRAME_INDENT, frame: { rule: RULE } });
    }
    const colors = PANEL_COLORS[panel.kind];
    const inner: BlockCtx = { ...ctx, indent: ctx.indent + FRAME_INDENT, frame: colors };
    return [
      this.para(inner, [new TextRun({ text: this.doc.labels.panel[panel.kind], bold: true, color: colors.rule })], { keepNext: true }),
      ...this.blocks(markdownTokens(panel.body), inner),
    ];
  }

  private list(token: Tokens.List, ctx: BlockCtx): Block[] {
    const level = ctx.listLevel;
    const task = token.items.some((i) => i.task);
    const reference = token.ordered && !task ? this.doc.orderedList(Number(token.start) || 1) : null;
    const left = ctx.indent + LIST_INDENT * (level + 1);
    const out: Block[] = [];
    for (const item of token.items) {
      let first = true;
      for (const block of item.tokens) {
        if (block.type === 'checkbox') continue;
        if (first && (block.type === 'text' || block.type === 'paragraph')) {
          const runs = this.inline((block as Tokens.Text).tokens ?? [], {});
          if (item.task) {
            out.push(this.para(ctx, [new TextRun(item.checked ? '☑ ' : '☐ '), ...runs], { indent: { left, hanging: HANGING } }));
          } else {
            out.push(
              this.para(ctx, runs, {
                ...(reference ? { numbering: { reference, level: Math.min(level, 8) } } : { bullet: { level: Math.min(level, 8) } }),
                indent: { left, hanging: HANGING },
              }),
            );
          }
        } else if (block.type === 'list') {
          out.push(...this.list(block as Tokens.List, { ...ctx, listLevel: level + 1 }));
        } else {
          out.push(...this.blocks([block], { ...ctx, indent: left, listLevel: level + 1 }));
        }
        first = false;
      }
    }
    return out;
  }

  private table(token: Tokens.Table): Table {
    const align = (i: number) =>
      token.align[i] === 'center' ? AlignmentType.CENTER : token.align[i] === 'right' ? AlignmentType.RIGHT : undefined;
    const row = (cells: Tokens.TableCell[], header: boolean) =>
      new TableRow({
        tableHeader: header,
        children: cells.map(
          (cell, i) =>
            new TableCell({
              shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: CODE_FILL } : undefined,
              children: [new Paragraph({ alignment: align(i), children: this.inline(cell.tokens, header ? { bold: true } : {}) })],
            }),
        ),
      });
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [row(token.header, true), ...token.rows.map((r) => row(r, false))],
    });
  }

  /**
   * A block `html` token: the expand, layout, file and contents encodings of
   * docs/features/03. Layout and API wrappers carry no text of their own, so
   * their content simply flows.
   */
  private htmlBlock(html: string, ctx: BlockCtx, saved: BlockCtx[], outer: BlockCtx): { blocks: Block[]; ctx: BlockCtx } {
    const out: Block[] = [];
    let summary: string | null = null;
    let file: { id: string; name: string } | null = null;
    let text = '';
    const flushText = () => {
      if (text.trim()) out.push(this.para(ctx, [new TextRun(text.trim().replace(/\s+/g, ' '))]));
      text = '';
    };
    for (const piece of htmlPieces(html)) {
      if (!piece.tag) {
        if (summary !== null) summary += piece.text;
        else if (!file) text += piece.text;
        continue;
      }
      const { tag, closing, attrs } = piece;
      if (tag === 'details' && !closing) {
        flushText();
        saved.push(ctx);
        ctx = { ...ctx, indent: ctx.indent + FRAME_INDENT, frame: { rule: RULE, fill: 'F9FAFB' } };
      } else if (tag === 'details') {
        flushText();
        ctx = saved.pop() ?? outer;
      } else if (tag === 'summary' && !closing) {
        flushText();
        summary = '';
      } else if (tag === 'summary') {
        out.push(this.para(ctx, [new TextRun({ text: `▸ ${summary?.trim() ?? ''}`, bold: true })], { keepNext: true }));
        summary = null;
      } else if (tag === 'div' && !closing && attrs[KN.file] !== undefined) {
        flushText();
        file = { id: attrs[KN.file], name: attrs['data-kn-name'] || 'attachment' };
      } else if (tag === 'div' && closing && file) {
        out.push(...this.fileCard(file, ctx));
        file = null;
      } else if (tag === 'div' && !closing && attrs[KN.toc] !== undefined) {
        flushText();
        out.push(...this.toc(ctx));
      } else if (tag === 'img' && !file) {
        flushText();
        const runs = this.image(attrs.src ?? '', attrs.alt ?? '', Number(attrs.width) || undefined);
        if (runs.length) out.push(this.para(ctx, runs, { alignment: AlignmentType.CENTER }));
      } else if (tag === 'hr') {
        flushText();
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 1 } } }));
      }
    }
    if (file) out.push(...this.fileCard(file, ctx));
    flushText();
    return { blocks: out, ctx };
  }

  /** A file embed: an image attachment the export carries is shown, anything else is named (a Word file cannot link to one beside it). */
  private fileCard(file: { id: string; name: string }, ctx: BlockCtx): Block[] {
    const image = this.doc.embed(file.id, file.name);
    if (image) return [this.para(ctx, [image], { alignment: AlignmentType.CENTER })];
    return [this.para(ctx, [new TextRun({ text: this.doc.labels.attachment.replace('{name}', file.name), bold: true })])];
  }

  /** The table-of-contents macro: this page's headings, linked. */
  private toc(ctx: BlockCtx): Block[] {
    const { labels } = this.doc;
    const head = this.para(ctx, [new TextRun({ text: labels.onThisPage, bold: true })], { keepNext: true });
    if (this.headings.length === 0) return [head, this.para(ctx, [new TextRun({ text: labels.noHeadings, italics: true })])];
    return [
      head,
      ...this.headings.map((h) =>
        this.para(ctx, [new InternalHyperlink({ anchor: h.bookmark, children: [new TextRun({ text: h.text, style: 'Hyperlink' })] })], {
          indent: { left: ctx.indent + FRAME_INDENT * (h.level - 1) },
        }),
      ),
    ];
  }

  /* ---------------------------------------------------------------- inline */

  private inline(tokens: Token[] | undefined, base: RunStyle): ParagraphChild[] {
    const out: ParagraphChild[] = [];
    // Inline HTML (`<u>`, status and mention spans) opens and closes in
    // sibling tokens: a stack of the styles they open.
    const stack: { tag: string; style: RunStyle }[] = [];
    const style = (): RunStyle => Object.assign({}, base, ...stack.map((s) => s.style));
    for (const token of tokens ?? []) {
      switch (token.type) {
        case 'text':
        case 'escape': {
          const t = token as Tokens.Text;
          if (t.tokens?.length) out.push(...this.inline(t.tokens, style()));
          // A soft line break inside a paragraph is a space, as in the reader.
          else if (t.text) out.push(textRun(decodeEntities(t.text).replace(/\n/g, ' '), style()));
          break;
        }
        case 'strong':
          out.push(...this.inline((token as Tokens.Strong).tokens, { ...style(), bold: true }));
          break;
        case 'em':
          out.push(...this.inline((token as Tokens.Em).tokens, { ...style(), italics: true }));
          break;
        case 'del':
          out.push(...this.inline((token as Tokens.Del).tokens, { ...style(), strike: true }));
          break;
        case 'codespan':
          out.push(textRun(decodeEntities((token as Tokens.Codespan).text), { ...style(), code: true }));
          break;
        case 'br':
          out.push(new TextRun({ break: 1 }));
          break;
        case 'link':
          out.push(...this.link(token as Tokens.Link, style()));
          break;
        case 'image': {
          const img = token as Tokens.Image;
          out.push(...this.image(img.href, img.text, undefined, style().link));
          break;
        }
        case 'html': {
          for (const piece of htmlPieces((token as Tokens.Tag).text)) {
            if (!piece.tag) {
              if (piece.text) out.push(textRun(piece.text, style()));
            } else if (piece.closing) {
              const at = stack.map((s) => s.tag).lastIndexOf(piece.tag);
              if (at >= 0) stack.splice(at);
            } else if (piece.tag === 'br') {
              out.push(new TextRun({ break: 1 }));
            } else if (piece.tag === 'img') {
              out.push(...this.image(piece.attrs.src ?? '', piece.attrs.alt ?? '', Number(piece.attrs.width) || undefined, style().link));
            } else {
              stack.push({ tag: piece.tag, style: tagStyle(piece) });
            }
          }
          break;
        }
        default: {
          const text = plainText([token]);
          if (text) out.push(textRun(text, style()));
        }
      }
    }
    return out;
  }

  /** Where a link can go in a Word file: another page or heading of this export, or the web. Anywhere else keeps its text. */
  private link(token: Tokens.Link, style: RunStyle): ParagraphChild[] {
    const href = token.href ?? '';
    const page = /^\/documents\/([0-9a-fA-F-]{36})(?:#.*)?$/.exec(href);
    const linked = () => this.inline(token.tokens, { ...style, link: true });
    if (page) {
      const anchor = this.doc.bookmarkOf(page[1]);
      return anchor ? [new InternalHyperlink({ anchor, children: linked() })] : this.inline(token.tokens, style);
    }
    if (href.startsWith('#')) {
      const slug = decodeURIComponent(href.slice(1));
      const heading = this.headings.find((h) => h.slug === slug);
      return heading ? [new InternalHyperlink({ anchor: heading.bookmark, children: linked() })] : this.inline(token.tokens, style);
    }
    if (/^(https?:|mailto:)/i.test(href)) return [new ExternalHyperlink({ link: href, children: linked() })];
    return this.inline(token.tokens, style);
  }

  /**
   * An attachment of the export is embedded; a web image stays a link to its
   * address (Word would fetch it on open, or not at all); a member-only path
   * or an attachment the export does not carry is left out, as in the reader.
   */
  private image(src: string, alt: string, width?: number, inLink = false): ParagraphChild[] {
    const attachment = parseAttachmentPath(src);
    if (attachment) {
      const run = this.doc.embed(attachment.attachmentId, alt, width);
      if (run) return [run];
      const name = this.doc.images.get(attachment.attachmentId)?.filename;
      return name ? [new TextRun({ text: `[${alt || name}]`, italics: true })] : [];
    }
    if (/^https?:\/\//i.test(src)) {
      const text = new TextRun({ text: alt || src, style: 'Hyperlink' });
      // Word refuses a hyperlink inside a hyperlink: inside one, the image is the link's text.
      return [inLink ? text : new ExternalHyperlink({ link: src, children: [text] })];
    }
    return [];
  }
}

function tagStyle(piece: HtmlPiece): RunStyle {
  switch (piece.tag) {
    case 'u':
      return { underline: true };
    case 'mark':
      return { highlight: true };
    case 'sub':
      return { subScript: true };
    case 'sup':
      return { superScript: true };
    case 'strong':
    case 'b':
      return { bold: true };
    case 'em':
    case 'i':
      return { italics: true };
    case 's':
    case 'del':
      return { strike: true };
    case 'code':
    case 'kbd':
      return { code: true };
    case 'span': {
      const status = piece.attrs[KN.status];
      if (status !== undefined) {
        const c = STATUS_COLORS[isStatusColor(status) ? status : 'neutral'];
        return { bold: true, color: c.color, fill: c.fill };
      }
      if (piece.attrs[KN.user] !== undefined || piece.attrs[KN.agent] !== undefined) return { color: '2563EB' };
      return {};
    }
    default:
      return {};
  }
}

function textRun(text: string, style: RunStyle): TextRun {
  const options: IRunOptions = {
    text,
    bold: style.bold,
    italics: style.italics,
    strike: style.strike,
    underline: style.underline ? {} : undefined,
    highlight: style.highlight ? 'yellow' : undefined,
    superScript: style.superScript,
    subScript: style.subScript,
    color: style.color,
    font: style.code ? CODE_FONT : undefined,
    shading: style.code || style.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: style.fill ?? CODE_FILL } : undefined,
    style: style.link ? 'Hyperlink' : undefined,
  };
  return new TextRun(options);
}

function frameOptions(ctx: BlockCtx): IParagraphOptions {
  if (!ctx.frame && !ctx.indent) return {};
  return {
    indent: ctx.indent ? { left: ctx.indent } : undefined,
    border: ctx.frame ? { left: { style: BorderStyle.SINGLE, size: 18, color: ctx.frame.rule, space: 8 } } : undefined,
    shading: ctx.frame?.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: ctx.frame.fill } : undefined,
  };
}

/** The blocks a container token holds, as the writer walks them. */
function childBlocks(token: Token): Token[][] {
  if (token.type === 'blockquote') {
    const panel = panelOf(token as Tokens.Blockquote);
    return [panel ? markdownTokens(panel.body) : (token as Tokens.Blockquote).tokens];
  }
  if (token.type === 'list') return (token as Tokens.List).items.map((i) => i.tokens);
  return [];
}

class DocxWriter {
  private readonly pageIndex: Map<string, number>;
  private readonly ordered: string[] = [];
  private readonly orderedStarts: number[] = [];

  constructor(
    readonly images: Map<string, DocxImage>,
    readonly labels: DocxLabels,
    pages: DocxPage[],
  ) {
    this.pageIndex = new Map(pages.map((p, i) => [p.documentId, i]));
  }

  pageBookmark(index: number): string {
    return `kn_p${index}`;
  }

  bookmarkOf(documentId: string): string | null {
    const i = this.pageIndex.get(documentId);
    return i === undefined ? null : this.pageBookmark(i);
  }

  /** A numbering of its own per ordered list, so each one counts from its own start. */
  orderedList(start: number): string {
    const reference = `kn-ol-${this.ordered.length}`;
    this.ordered.push(reference);
    this.orderedStarts.push(start);
    return reference;
  }

  numbering() {
    return {
      config: this.ordered.map((reference, n) => ({
        reference,
        levels: Array.from({ length: 9 }, (_, level) => ({
          level,
          format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
          text: `%${level + 1}.`,
          start: level === 0 ? this.orderedStarts[n] : 1,
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: LIST_INDENT * (level + 1), hanging: HANGING } } },
        })),
      })),
    };
  }

  embed(attachmentId: string, alt: string, width?: number): ImageRun | null {
    const image = this.images.get(attachmentId);
    const info = image ? imageInfo(image.bytes) : null;
    if (!image || !info || !info.width || !info.height) return null;
    const target = Math.min(width ?? info.width, info.width, MAX_IMAGE_PX);
    const scale = target / info.width;
    return new ImageRun({
      type: info.type,
      data: image.bytes,
      transformation: { width: Math.round(info.width * scale), height: Math.max(1, Math.round(info.height * scale)) },
      altText: { name: image.filename, description: alt || image.filename, title: alt || image.filename },
    });
  }
}

const PAGE = { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } };

/** One `.docx` for the export: a title page and contents when it holds more than one page, then a section per page. */
export async function writeDocx(input: DocxExportInput): Promise<Uint8Array> {
  const writer = new DocxWriter(input.images, input.labels, input.pages);
  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 16, color: '6B7280' })],
      }),
    ],
  });
  const section = (children: Block[]): ISectionOptions => ({
    properties: { page: PAGE },
    footers: { default: footer },
    children,
  });

  const sections: ISectionOptions[] = [];
  if (input.pages.length > 1) {
    sections.push(
      section([
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(input.title)] }),
        new Paragraph({ children: [new TextRun({ text: input.labels.meta, color: '6B7280' })], spacing: { after: 480 } }),
        new Paragraph({ children: [new TextRun({ text: input.labels.contents, bold: true, size: 28 })], spacing: { after: 160 } }),
        ...input.pages.map(
          (p, i) =>
            new Paragraph({
              indent: p.depth ? { left: FRAME_INDENT * 2 * p.depth } : undefined,
              children: [
                new InternalHyperlink({
                  anchor: writer.pageBookmark(i),
                  children: [new TextRun({ text: p.title, style: 'Hyperlink' })],
                }),
              ],
            }),
        ),
      ]),
    );
  }
  input.pages.forEach((p, i) => sections.push(section(new PageWriter(writer, i, markdownTokens(p.markdown)).write(p.title))));

  const doc = new Document({
    title: input.title,
    styles: {
      default: {
        document: { run: { font: BODY_FONT, size: 22 }, paragraph: { spacing: { after: 120 } } },
        heading1: { run: { size: 36, bold: true }, paragraph: { outlineLevel: 0, spacing: { before: 240, after: 120 }, keepNext: true } },
        heading2: { run: { size: 30, bold: true }, paragraph: { outlineLevel: 1, spacing: { before: 240, after: 120 }, keepNext: true } },
        heading3: { run: { size: 26, bold: true }, paragraph: { outlineLevel: 2, spacing: { before: 200, after: 80 }, keepNext: true } },
        heading4: { run: { size: 24, bold: true }, paragraph: { outlineLevel: 3, spacing: { before: 160, after: 80 }, keepNext: true } },
        heading5: { run: { size: 22, bold: true }, paragraph: { outlineLevel: 4, keepNext: true } },
        heading6: { run: { size: 22, bold: true, italics: true }, paragraph: { outlineLevel: 5, keepNext: true } },
      },
      paragraphStyles: [
        {
          id: 'KnCode',
          name: 'Code',
          basedOn: 'Normal',
          run: { font: CODE_FONT, size: 19 },
          paragraph: {
            spacing: { before: 80, after: 160, line: 260 },
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: CODE_FILL },
          },
        },
      ],
    },
    numbering: writer.numbering(),
    sections,
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}
