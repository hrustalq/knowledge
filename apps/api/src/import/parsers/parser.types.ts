import type { ImportMeta, ImportParserId } from '@knowledge/contracts';

/**
 * What a parser is handed. `onStage` is the only channel between a parse and
 * the person watching it: it writes the row the wizard polls, so the label
 * under the progress ring is the worker's own account of what it is doing
 * rather than a guess made in the browser.
 */
export interface ParseContext {
  workspaceId: string;
  importId: string;
  /** Who started the import — the OCR parser bills its call to them. */
  userId: string;
  filename: string;
  contentType: string;
  onStage(stage: string, progress?: number | null): Promise<void>;
}

/**
 * An image lifted out of the source file. It is written to import staging
 * immediately so the review step renders the real picture; `path` is the API
 * route the markdown points at, and submit rewrites it to the attachment that
 * replaces it.
 */
export interface ParsedImage {
  index: number;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface ParseResult {
  markdown: string;
  /** Title the file itself claims — an h1, a docx heading, PDF metadata. */
  title?: string;
  /**
   * Everything the parse could not carry across. These are surfaced to the
   * reviewer verbatim: a lossy import that says nothing is the failure mode
   * this whole flow exists to avoid.
   */
  warnings: string[];
  meta: ImportMeta;
  images?: ParsedImage[];
}

export interface DocumentParser {
  readonly id: ImportParserId;
  parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParseResult>;
}

/** DI token for the registry's parser set. */
export const DOCUMENT_PARSERS = Symbol('DOCUMENT_PARSERS');

// --- shared helpers ---------------------------------------------------------

const BULLET = /^[ \t]*[\u2022\u25aa\u25e6\u2023\u00b7]\s+/;

/** Collapse the runs of whitespace every extractor leaves behind. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // Leading whitespace is structure — it is what makes a nested list item
    // nested — so only runs *inside* a line are collapsed. Exotic spaces
    // (non-breaking, figure, narrow) are folded to ordinary ones on the way.
    .map((line) => {
      const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
      return indent + line.slice(indent.length).replace(/\s+/g, ' ').trimEnd();
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A line that reads as a list item in the source becomes one in the output.
 * Hyphens are deliberately excluded: a leading dash in prose is usually a dash,
 * and markdown already treats `-` as a list marker anyway.
 */
export function asBullet(line: string): string | null {
  return BULLET.test(line) ? `- ${line.replace(BULLET, '').trim()}` : null;
}

/**
 * Title fallback: the first heading, else the first substantial line, else the
 * filename without its extension. Never returns an empty string, because the
 * review step's title field is what becomes `documents.title`.
 */
export function inferTitle(markdown: string, filename: string): string {
  const heading = /^#{1,3}\s+(.+)$/m.exec(markdown);
  if (heading) return trimTitle(heading[1]);
  const line = markdown
    .split('\n')
    .map((l) => l.replace(/^[#>\-*\s]+/, '').trim())
    .find((l) => l.length >= 3);
  if (line) return trimTitle(line);
  return filename.replace(/\.[^.]+$/, '') || 'Untitled import';
}

/**
 * A title is a name, not the opening paragraph. When the candidate is really a
 * sentence, take the sentence; when it is longer than a title can be, cut on a
 * word rather than mid-syllable.
 */
function trimTitle(candidate: string): string {
  const text = candidate.trim().replace(/\s+/g, ' ');
  if (text.length <= 120) return text;
  const sentence = /^(.{10,120}?[.!?])\s/.exec(text);
  if (sentence) return sentence[1].replace(/[.!?]$/, '');
  const cut = text.slice(0, 120);
  return `${cut.slice(0, cut.lastIndexOf(' ')) || cut}…`;
}

/** Word count for the provenance strip — cheap, and the one number reviewers check. */
export function countWords(markdown: string): number {
  const m = markdown.match(/\S+/g);
  return m ? m.length : 0;
}

/** Sections, as the ingestion chunker will later see them. */
export function countSections(markdown: string): number {
  const m = markdown.match(/^#{1,6}\s+\S/gm);
  return m ? m.length : 0;
}

/**
 * Drop the body's opening heading when it is simply the title again.
 *
 * Almost every real document names itself on its first line, and the review
 * step puts that name in the title field — so leaving it in the body too means
 * every imported page opens by saying its own name twice. The read side already
 * strips a leading `# Title` that matches `documents.title`; doing it here means
 * the *stored markdown* is right, not just its rendering.
 *
 * Only an exact match is removed. A first heading that differs from the title
 * is a real section and stays.
 */
export function stripLeadingTitle(markdown: string, title: string | undefined): string {
  if (!title) return markdown;
  const normalized = title.trim().toLowerCase();
  if (!normalized) return markdown;

  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;

  const heading = /^#{1,3}\s+(.+?)\s*$/.exec(lines[i] ?? '');
  if (!heading || heading[1].trim().toLowerCase() !== normalized) return markdown;

  return lines
    .slice(i + 1)
    .join('\n')
    .replace(/^\n+/, '');
}
