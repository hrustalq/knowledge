import type { DocumentCategory } from '@knowledge/contracts/documents';

// ---------------------------------------------------------------------------

/**
 * Word boundaries for term matching, as lookaround sources.
 *
 * Shared because two implementations must agree: the read-side linker in
 * `apps/web/src/lib/glossary.ts` decides what a reader sees, and
 * `countOccurrences` in the API's glossary service decides which AI proposals
 * are grounded enough to offer. They drifted the moment one was fixed alone.
 *
 * `\b` is wrong here — the terms most in need of defining are the ones it
 * breaks on (`.env`, `C++`, `@Access`). Underscore counts as a word character
 * even though it is neither letter nor digit, because it joins words into one
 * identifier: `customer_id` is not a mention of *Customer*, and a page
 * documenting a data model is mostly such identifiers.
 */
export const GLOSSARY_BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}_])';
export const GLOSSARY_BOUNDARY_AFTER = '(?![\\p{L}\\p{N}_])';

/** Where a term came from: hand-written, or accepted from an AI suggestion. */
export type GlossaryTermSource = 'manual' | 'ai';

export interface GlossaryTerm {
  termId: string;
  workspaceId: string;
  /** Workspace > Project > Document: vocabulary belongs to a project. */
  projectId: string;
  term: string;
  /** Alternative spellings, abbreviations and inflections that link to this entry. */
  aliases: string[];
  /** Short definition shown in the hover card wherever the term appears. */
  definition: string;
  /** Page that defines the term in full; the hover card links to it. */
  documentId: string | null;
  /** Resolved on read (no FK — a deleted page leaves the entry intact). */
  documentTitle: string | null;
  source: GlossaryTermSource;
  /** Disabled terms stay in the glossary but stop being linked in documents. */
  enabled: boolean;
  /**
   * Link the aliases too, or the headword only. False is the escape hatch for
   * an alias that is also an ordinary word: «Заказ» would otherwise link in
   * every sentence that happens to use it.
   */
  matchAliases: boolean;
  /** For terms that are only terms in one casing — "IT" against "it". */
  caseSensitive: boolean;
  /** Occurrences linked per page; null = the shared default. */
  maxLinksPerPage: number | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListGlossaryResponse {
  workspaceId: string;
  projectId: string | null;
  terms: GlossaryTerm[];
}



/**
 * Where an excluded occurrence sits, as a quote plus a little context.
 *
 * The `ReviewThreadAnchor` text shape minus `revisionId`: an exclusion is about
 * the words, not about a version of them, so it keeps applying across edits
 * that leave the sentence recognisable and stops applying when it is gone.
 */
export interface GlossaryExclusionAnchor {
  quote: string;
  prefix?: string;
  suffix?: string;
}

/** One occurrence of one term, on one page, that is not a mention of it. */
export interface GlossaryExclusion {
  exclusionId: string;
  documentId: string;
  termId: string;
  anchor: GlossaryExclusionAnchor;
  createdBy: string | null;
  createdAt: string;
}

// GET /v1/documents/:id/glossary-exclusions
export interface ListGlossaryExclusionsResponse {
  documentId: string;
  exclusions: GlossaryExclusion[];
}



export interface GlossaryTermSuggestion {
  term: string;
  aliases: string[];
  definition: string;
  /** Occurrences counted deterministically in the source text, not by the model. */
  occurrences: number;
  /** Already in the glossary — the UI offers "update" instead of "add". */
  existingTermId: string | null;
}

export interface SuggestGlossaryTermsResponse {
  /** false when the assistant provider is `none` — the UI hints instead of erroring. */
  enabled: boolean;
  /** Project the proposals were checked against, and where accepting one puts it. */
  projectId: string | null;
  suggestions: GlossaryTermSuggestion[];
}

// ---------------------------------------------------------------------------
// Document import (docs/features/16) — a file becoming a page.
//
// Reserve → PUT → start → poll → review → submit. The bytes go straight to
// object storage exactly like revisions and attachments do; what is new is that
// a worker parses them into markdown *before* any document exists, so the
// result can be read and corrected by a human before it is committed.

/** One accepted source format: what the picker offers and what the server routes on. */
export interface ImportFormat {
  /** Parser id the server will use. */
  parser: ImportParserId;
  label: string;
  extensions: string[];
  contentTypes: string[];
}

export type ImportParserId =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'html'
  | 'tabular'
  | 'structured'
  | 'plaintext'
  | 'ocr';

/**
 * The single source of truth for what can be imported, shared by the drop zone,
 * the server's reserve guard and the parser registry — so a file the picker
 * accepts can never be one the worker refuses.
 *
 * Order matters: the first entry whose extension or content type matches wins,
 * which is why `plaintext` (the catch-all for text/*) sits last.
 */
export const IMPORT_FORMATS: readonly ImportFormat[] = [
  {
    parser: 'pdf',
    label: 'PDF',
    extensions: ['.pdf'] as string[],
    contentTypes: ['application/pdf'] as string[],
  },
  {
    parser: 'docx',
    label: 'Word',
    extensions: ['.docx'] as string[],
    contentTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] as string[],
  },
  {
    parser: 'pptx',
    label: 'PowerPoint',
    extensions: ['.pptx'] as string[],
    contentTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'] as string[],
  },
  {
    parser: 'html',
    label: 'HTML',
    extensions: ['.html', '.htm'] as string[],
    contentTypes: ['text/html', 'application/xhtml+xml'] as string[],
  },
  {
    parser: 'tabular',
    label: 'Spreadsheet data',
    extensions: ['.csv', '.tsv'] as string[],
    contentTypes: ['text/csv', 'text/tab-separated-values'] as string[],
  },
  {
    parser: 'structured',
    label: 'JSON / YAML',
    extensions: ['.json', '.yaml', '.yml'] as string[],
    contentTypes: ['application/json', 'application/yaml', 'text/yaml', 'text/x-yaml'] as string[],
  },
  {
    parser: 'ocr',
    label: 'Image (OCR)',
    extensions: ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as string[],
    contentTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as string[],
  },
  {
    parser: 'plaintext',
    label: 'Markdown / text',
    extensions: ['.md', '.markdown', '.txt', '.text'] as string[],
    contentTypes: ['text/markdown', 'text/plain', 'text/x-markdown'] as string[],
  },
] as const;

/** Resolve a file to its parser the same way on both sides of the wire. */
export function importFormatFor(filename: string, contentType?: string): ImportFormat | null {
  const ext = filename.toLowerCase().replace(/^.*(?=\.)/, '');
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return (
    IMPORT_FORMATS.find((f) => f.extensions.includes(ext)) ??
    IMPORT_FORMATS.find((f) => type !== '' && f.contentTypes.includes(type)) ??
    null
  );
}

/**
 * `awaiting-upload` exists because the row is created before the bytes land:
 * the presigned PUT is the client's job, and until the bucket confirms the
 * object there is nothing to parse.
 */
export type ImportStatus =
  | 'awaiting-upload'
  | 'queued'
  | 'running'
  | 'parsed'
  | 'failed'
  | 'submitted';

/** Counts the review step reports, filled in by whichever parser ran. */
export interface ImportMeta {
  pages?: number;
  slides?: number;
  sections?: number;
  words?: number;
  images?: number;
  /** A PDF with no text layer: the review step offers OCR instead of a dead end. */
  needsOcr?: boolean;
}

export interface ImportJobInfo {
  importId: string;
  workspaceId: string;
  projectId: string;
  parentId: string | null;
  category: DocumentCategory;
  status: ImportStatus;
  /** Human phrase for the current act ("Reading 48 pages"); null when idle. */
  stage: string | null;
  /** 0..1, or null when the worker cannot honestly say — the ring goes indeterminate. */
  progress: number | null;
  sourceFilename: string;
  contentType: string;
  sizeBytes: number;
  parser: ImportParserId | null;
  title: string | null;
  /** What the parse could not carry. Never swallowed. */
  warnings: string[];
  meta: ImportMeta;
  error: string | null;
  documentId: string | null;
  createdAt: string;
}

export interface CreateImportResponse {
  import: ImportJobInfo;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string };
}

// POST /v1/imports/:id/start  and  GET /v1/imports/:id
export interface ImportJobResponse {
  import: ImportJobInfo;
}

// GET /v1/imports/:id/content
export interface ImportContentResponse {
  importId: string;
  title: string | null;
  markdown: string;
  warnings: string[];
  meta: ImportMeta;
}

export interface SubmitImportResponse {
  documentId: string;
  revisionId: string;
  /** The original file, promoted from staging onto the new page. */
  attachmentId: string | null;
}

// ---------------------------------------------------------------------------
// Dynamic document workflows (docs/features/17)
