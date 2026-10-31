import type { DocumentCategory } from '@knowledge/contracts/documents';

// ---------------------------------------------------------------------------

/**
 * Word boundaries for term matching, as lookaround sources.
 *
 * Shared because two implementations must agree: the read-side linker in
 * `apps/web/src/modules/documents/model/glossary.ts` decides what a reader sees, and
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

/**
 * Where a term came from: hand-written, accepted from an AI suggestion, or
 * approved from an agent-session capture (issue #73). Only the first two can
 * be sent to `POST /v1/glossary`; `captured` is written by the approve route.
 */
export type GlossaryTermSource = 'manual' | 'ai' | 'captured';

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

// ---- Page AI actions (issue #68) -------------------------------------------

/**
 * Every entry in a page's AI actions menu. The menu, the admin setting and
 * their specs read these, so what the setting gates cannot drift from what the
 * menu hides.
 */
export const AI_ACTION_IDS = [
  'copy-markdown',
  'view-markdown',
  'open-chatgpt',
  'open-claude',
  'open-cursor',
  'copy-mcp-config',
  'copy-agent-link',
] as const;
export type AiActionId = (typeof AI_ACTION_IDS)[number];

/**
 * The actions that hand page content to a third-party AI vendor through a URL.
 * Only these are gated by `ai_settings.external_ai_actions` and its
 * `AI_EXTERNAL_ACTIONS_ENABLED` ceiling; copying to the reader's own clipboard
 * is never gated.
 */
export const EXTERNAL_AI_ACTIONS: ReadonlySet<AiActionId> = new Set<AiActionId>([
  'open-chatgpt',
  'open-claude',
  'open-cursor',
]);

/** The actions a reader is offered, given whether external actions are allowed. */
export function visibleAiActions(externalAllowed: boolean): AiActionId[] {
  return AI_ACTION_IDS.filter((id) => externalAllowed || !EXTERNAL_AI_ACTIONS.has(id));
}

// ---- Page references (lifted from the web for #74) --------------------------
//
// Authors reach for a page by the name they see in the sidebar —
// `[Модель данных](OrderHub — Модель данных)` — as well as by id
// (`/documents/<id>`). The web renders both; the quality auditor checks both
// resolve. One implementation, so a link the reader sees as broken is the link
// the auditor reports, and no other.

/**
 * Titles are compared on collapsed whitespace, case-insensitively.
 *
 * Both halves earn their place: a title that wrapped in the source arrives with
 * a newline in it, and the model routinely varies the case of a word it is
 * quoting back. Nothing else is normalised — em dashes, colons and punctuation
 * are part of the title, and a reference that differs in those is a reference
 * to something else.
 */
export function pageRefKey(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Resolves a page *title* to its document id, or null when nothing in the
 * workspace carries that title.
 */
export type PageRefResolver = (title: string) => string | null;

/** A page as the roster knows it: enough to resolve a title, and no more. */
export interface PageRef {
  documentId: string;
  title: string;
  /** Which project it lives in — the tiebreak when a title is not unique. */
  projectId?: string | null;
}

/**
 * Build a resolver over a set of pages.
 *
 * Titles are not unique across a workspace — the same page name recurs in every
 * project that documents the same thing — so a title alone can be ambiguous.
 * `preferProjectId` is the tiebreak that makes the common case work: a
 * reference written on a page in project X almost always means the page of that
 * name in project X, which is the containment feature 11 exists to express.
 *
 * When that still leaves more than one, the reference resolves to **nothing**.
 * Picking the first would send readers somewhere plausible and wrong, and a
 * reference that kept its brackets at least says it is unresolved.
 */
export function buildPageRefResolver(pages: readonly PageRef[], preferProjectId?: string | null): PageRefResolver {
  const byTitle = new Map<string, PageRef[]>();
  for (const page of pages) {
    const key = pageRefKey(page.title);
    if (!key) continue;
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(page);
    else byTitle.set(key, [page]);
  }
  return (title) => {
    const matches = byTitle.get(pageRefKey(title));
    if (!matches?.length) return null;
    if (matches.length === 1) return matches[0].documentId;
    const local = preferProjectId ? matches.filter((p) => p.projectId === preferProjectId) : [];
    return local.length === 1 ? local[0].documentId : null;
  };
}

/**
 * A link destination that could be a page title rather than a location.
 *
 * Anything that addresses something — a scheme, a root-relative path, an
 * in-page anchor — is a location, and comes back null. What is left is a bare
 * relative reference, which this product has no other use for: there are no
 * relative paths between pages, only `/documents/<id>`.
 *
 * The percent-decoding is the whole point of the second form. A model that
 * escapes the title it is linking to produces a destination with no spaces in
 * it, so CommonMark *accepts* it and the reader gets a relative link to
 * `OrderHub%20%E2%80%94%20…` that 404s — the same authored intent as the
 * unencoded form, and invisible to any check that looks for a space.
 * A malformed escape decodes to itself rather than throwing.
 */
export function pageTitleHref(href: string): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) {
    return null;
  }
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

const PAGE_LINK_RE = /(!?)\[((?:\\.|[^[\]\\\n])+)\]\(([^()\n]*)\)/g;
/** A CommonMark link title: `"…"`, `'…'` or `(…)`. */
const PAGE_LINK_TITLE_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))$/;
const DOCUMENT_HREF_RE = /^\/documents\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[?#].*)?$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE_RE = /(`+)[^`\n][\s\S]*?\1/g;

/** One reference from a page to another page, as written. */
export type PageLink =
  | { kind: 'id'; documentId: string; text: string; href: string }
  | { kind: 'title'; title: string; text: string; href: string };

/**
 * Cheap pre-check: is it even worth loading the page roster for this text?
 *
 * Most markdown this app renders is a comment or a chat reply with no page
 * reference in it at all, and the roster costs a request. Both spellings count:
 * a destination containing a space (which CommonMark refuses outright, so it
 * never becomes a link) and a bare relative one (which it accepts, and which
 * then goes nowhere). Whether either *resolves* is the resolver's business.
 */
export function mayContainPageRef(markdown: string): boolean {
  return extractPageLinks(markdown).some((link) => link.kind === 'title');
}

/**
 * Every page reference in a markdown body: `/documents/<id>` links and
 * title-style references, in order of appearance. Images and anything inside
 * code — a fenced block or an inline span — are not references.
 */
export function extractPageLinks(markdown: string): PageLink[] {
  const text = withoutFences(markdown ?? '').replace(INLINE_CODE_RE, '');
  const links: PageLink[] = [];
  for (const match of text.matchAll(PAGE_LINK_RE)) {
    if (match[1]) continue; // an image
    const label = match[2];
    let inner = match[3].trim();
    if (!inner) continue;
    if (inner.startsWith('<') && inner.endsWith('>')) inner = inner.slice(1, -1).trim();
    // A bare destination runs to the first space; what follows may only be a
    // title. Anything else after the space is no link to CommonMark, which is
    // exactly the title-reference an author or a model wrote.
    const split = /^(\S+)\s+([\s\S]+)$/.exec(inner);
    if (split && !PAGE_LINK_TITLE_RE.test(split[2].trim())) {
      links.push({ kind: 'title', title: inner, text: label, href: match[3] });
      continue;
    }
    const destination = split ? split[1] : inner;
    const id = DOCUMENT_HREF_RE.exec(destination);
    if (id) {
      links.push({ kind: 'id', documentId: id[1].toLowerCase(), text: label, href: destination });
      continue;
    }
    const title = pageTitleHref(destination);
    if (title?.trim()) links.push({ kind: 'title', title, text: label, href: destination });
  }
  return links;
}

/** The body with fenced code blocks removed; an unclosed fence runs to the end, as CommonMark reads it. */
function withoutFences(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const open = FENCE_OPEN_RE.exec(line);
    if (fence === null) {
      if (open) fence = open[1];
      else out.push(line);
    } else if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !line.trim().slice(open[1].length).trim()) {
      fence = null;
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------

/**
 * Markdown → plain text, for the places that can only show plain text: a
 * `title` attribute, a one-line preview of a collapsed thread, the excerpt of
 * the comment a reply answers, and a search snippet (#645), which the API
 * windows and marks after stripping so no backtick or `**` reaches a reader.
 *
 * This is deliberately a stripper, not a parser. Rendering the markdown and
 * reading `textContent` would be more correct and needs a DOM, which two of
 * the three callers do not have (SSR, and a `title=` built before mount) — and
 * for a single line of preview text, dropping the markers is indistinguishable
 * from the real thing.
 */
export function plainText(markdown: string): string {
  return (markdown ?? '')
    // A fence goes, its code stays: a search hit can be inside it.
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, ' $1 ')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/(\*\*|\*|~~)/g, '')
    // Underscore emphasis only at a word's edge: `snake_case` and
    // `AGENT_SCHEDULE_ENABLED` keep theirs.
    .replace(/(?<![\p{L}\p{N}])__?|__?(?![\p{L}\p{N}])/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
