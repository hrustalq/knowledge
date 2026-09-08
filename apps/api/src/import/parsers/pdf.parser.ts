import { Injectable } from '@nestjs/common';
import { extractTextItems, getDocumentProxy, getMeta } from 'unpdf';
import type { ImportParserId } from '@knowledge/contracts';
import {
  asBullet,
  countSections,
  countWords,
  inferTitle,
  tidy,
  type DocumentParser,
  type ParseContext,
  type ParseResult,
} from './parser.types.js';

interface Line {
  text: string;
  size: number;
  page: number;
  /** Y in PDF space (origin bottom-left), used to spot running heads. */
  y: number;
}

/**
 * PDF → markdown.
 *
 * A PDF has no headings — it has glyphs at coordinates in a font size. So the
 * structure is *reconstructed*: text items are grouped back into lines, the
 * body size is taken as the size most of the document's characters are set in,
 * and the few larger sizes above it become h1/h2/h3 in rank order. That is what
 * a reader does at a glance, and it is the difference between an imported PDF
 * that chunks into sections and one that arrives as a single 40-page wall.
 *
 * Running heads and page numbers are dropped by repetition rather than by
 * position: a string that appears near the same edge on most pages is furniture,
 * whatever it says.
 */
@Injectable()
export class PdfParser implements DocumentParser {
  readonly id: ImportParserId = 'pdf';

  async parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParseResult> {
    await ctx.onStage('Opening the PDF');
    const pdf = await getDocumentProxy(bytes);
    const totalPages = pdf.numPages;

    await ctx.onStage(`Reading ${totalPages} ${totalPages === 1 ? 'page' : 'pages'}`, 0.1);
    const { items } = await extractTextItems(pdf);

    const lines: Line[] = [];
    for (let page = 0; page < items.length; page++) {
      // Text items arrive in reading order with `hasEOL` marking where the
      // renderer broke the line — far more reliable than clustering on y, which
      // multi-column layouts defeat.
      let buffer = '';
      let size = 0;
      let y = 0;
      for (const item of items[page]) {
        if (item.str) {
          buffer += item.str;
          size = Math.max(size, Math.round(item.fontSize * 10) / 10);
          y = item.y;
        }
        if (item.hasEOL) {
          const text = buffer.trim();
          if (text) lines.push({ text, size, page, y });
          buffer = '';
          size = 0;
        }
      }
      const tail = buffer.trim();
      if (tail) lines.push({ text: tail, size, page, y });

      if (page % 10 === 9) {
        await ctx.onStage(
          `Reading ${totalPages} ${totalPages === 1 ? 'page' : 'pages'}`,
          0.1 + 0.6 * ((page + 1) / Math.max(1, items.length)),
        );
      }
    }

    const warnings: string[] = [];
    const kept = dropRunningHeads(lines, totalPages, warnings);

    await ctx.onStage('Rebuilding structure', 0.8);
    const bodySize = modeSize(kept);
    const headingSizes = rankHeadingSizes(kept, bodySize);
    const markdown = assemble(kept, bodySize, headingSizes, medianLineGap(kept));

    const words = countWords(markdown);
    const sections = countSections(markdown);

    // A scanned page yields glyph-free pages: near-zero text over a real page
    // count is not a broken parse, it is a picture of a document.
    const needsOcr = words < Math.max(20, totalPages * 5);
    if (needsOcr) {
      warnings.push(
        'Almost no selectable text was found — this looks like a scanned PDF, so its pages are images rather than text.',
      );
    } else if (sections === 0) {
      warnings.push(
        'No headings could be detected, so the whole file became one section. Adding headings below will improve how it is chunked and searched.',
      );
    }

    const meta = await pdfMeta(pdf).catch(() => ({}) as Record<string, unknown>);
    const declaredTitle = typeof meta.Title === 'string' && meta.Title.trim() ? meta.Title.trim() : undefined;

    return {
      markdown,
      title: declaredTitle ?? inferTitle(markdown, ctx.filename),
      warnings,
      meta: { pages: totalPages, sections, words, needsOcr },
    };
  }
}

async function pdfMeta(pdf: Parameters<typeof getMeta>[0]): Promise<Record<string, unknown>> {
  const { info } = await getMeta(pdf);
  return info ?? {};
}

/**
 * Furniture removal. A line is a running head or foot when the same text shows
 * up on most pages; a page number is that plus being a bare numeral. Both are
 * noise in a knowledge base, and both wreck heading inference by repeating at a
 * consistent size.
 */
function dropRunningHeads(lines: Line[], totalPages: number, warnings: string[]): Line[] {
  if (totalPages < 4) return lines.filter((l) => !isBareNumber(l.text));

  const pagesSeen = new Map<string, Set<number>>();
  for (const line of lines) {
    const key = normalize(line.text);
    if (!key || key.length > 120) continue;
    (pagesSeen.get(key) ?? pagesSeen.set(key, new Set()).get(key)!).add(line.page);
  }

  const repeated = new Set(
    [...pagesSeen.entries()]
      .filter(([, pages]) => pages.size >= Math.ceil(totalPages * 0.6))
      .map(([key]) => key),
  );

  const kept = lines.filter((l) => !isBareNumber(l.text) && !repeated.has(normalize(l.text)));
  if (repeated.size > 0) {
    warnings.push(
      `Removed ${repeated.size} repeating header/footer ${repeated.size === 1 ? 'line' : 'lines'} and page numbers.`,
    );
  }
  return kept;
}

const isBareNumber = (text: string) => /^[\s.\-–—]*\d{1,4}[\s.\-–—]*$/.test(text);
const normalize = (text: string) => text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();

/** Body size = the size most of the document's characters are set in. */
function modeSize(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const l of lines) weight.set(l.size, (weight.get(l.size) ?? 0) + l.text.length);
  let best = 0;
  let bestWeight = -1;
  for (const [size, w] of weight) {
    if (w > bestWeight) {
      best = size;
      bestWeight = w;
    }
  }
  return best;
}

/**
 * The distinct sizes meaningfully above body, largest first, capped at three —
 * markdown past h3 stops helping the reader and the chunker alike.
 */
function rankHeadingSizes(lines: Line[], bodySize: number): number[] {
  if (!bodySize) return [];
  const sizes = new Set<number>();
  for (const l of lines) {
    if (l.size > bodySize * 1.12 && l.text.length <= 120) sizes.add(l.size);
  }
  return [...sizes].sort((a, b) => b - a).slice(0, 3);
}

/**
 * The gap a single line of prose leaves behind, taken as the median of every
 * consecutive pair on a page. Anything meaningfully larger than it is the
 * blank line a PDF cannot express.
 */
function medianLineGap(lines: Line[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].page !== lines[i - 1].page) continue;
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Blocks are emitted as `\n\n`-joined entries, except consecutive bullets,
 * which are joined tight — a blank line between list items turns one list into
 * several in every markdown renderer there is.
 */
function assemble(lines: Line[], bodySize: number, headingSizes: number[], lineGap: number): string {
  const blocks: Array<{ text: string; bullet: boolean }> = [];
  let paragraph: string[] = [];
  let previous: Line | null = null;

  const flush = () => {
    if (!paragraph.length) return;
    blocks.push({ text: joinWrapped(paragraph), bullet: false });
    paragraph = [];
  };

  for (const line of lines) {
    // A gap wider than a line, or a page turn, ends the paragraph — without
    // this a whole page of uniform text arrives as one unbroken block.
    const broke =
      previous !== null &&
      (line.page !== previous.page || (lineGap > 0 && previous.y - line.y > lineGap * 1.6));
    if (broke) flush();
    previous = line;

    const level = headingSizes.indexOf(line.size);
    if (level !== -1 && isHeadingLike(line.text)) {
      flush();
      blocks.push({ text: `${'#'.repeat(level + 1)} ${line.text}`, bullet: false });
      continue;
    }
    const bullet = asBullet(line.text);
    if (bullet) {
      flush();
      blocks.push({ text: bullet, bullet: true });
      continue;
    }
    // A line noticeably smaller than body is a caption or a footnote: keep it,
    // but as its own paragraph rather than glued onto the prose above.
    if (bodySize && line.size < bodySize * 0.85) {
      flush();
      blocks.push({ text: line.text, bullet: false });
      continue;
    }
    paragraph.push(line.text);
  }
  flush();

  let out = '';
  for (const [i, block] of blocks.entries()) {
    if (i === 0) out = block.text;
    else out += (block.bullet && blocks[i - 1].bullet ? '\n' : '\n\n') + block.text;
  }
  return tidy(out);
}

/** Headings do not end in a full stop and are not whole sentences. */
function isHeadingLike(text: string): boolean {
  return text.length <= 120 && !/[.:;,]$/.test(text.trim());
}

/**
 * PDF line breaks are typographic, not semantic — rejoin them, healing the
 * hyphenation the justification introduced.
 */
function joinWrapped(lines: string[]): string {
  let out = '';
  for (const line of lines) {
    if (!out) {
      out = line;
      continue;
    }
    if (/[­-]$/.test(out) && /^[a-zà-ÿ]/.test(line)) out = `${out.slice(0, -1)}${line}`;
    else out = `${out} ${line}`;
  }
  return out;
}
