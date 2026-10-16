// Agent-session memory (issue #73): what a coding agent learned in a session,
// proposed back into the knowledge base as a merge request a person reviews.
//
// Buildless package: no enums, no relative cross-file imports (see
// packages/contracts/src/index.ts).

/**
 * What a capture says. The first four and `answer` become page text; `glossary`
 * a term; `relation` a frontmatter relation. Closed: the MCP tools, the REST
 * body and the `knowledge_captures.kind` CHECK all read this list.
 */
export const CAPTURE_KINDS = ['decision', 'gotcha', 'convention', 'howto', 'glossary', 'relation', 'answer'] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/**
 * What `knowledge_captures.status` stores — the states before a merge request
 * exists or instead of one. `merged` and `closed` are not stored: they are the
 * merge request's own status, read through `captureStateFor`, so the capture
 * row and the merge request can never disagree about it.
 */
export const CAPTURE_STATUSES = ['staged', 'proposed', 'duplicate', 'rejected', 'failed'] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/** What a reader is shown: the stored status, or the merge request's outcome once it has one. */
export type CaptureState = CaptureStatus | 'merged' | 'closed';

/** What dedupe decided the capture becomes. `none` is a duplicate's: nothing is proposed. */
export const CAPTURE_OUTCOMES = ['new-page', 'amend-page', 'glossary', 'relation', 'none'] as const;
export type CaptureOutcome = (typeof CAPTURE_OUTCOMES)[number];

/**
 * The coding agent that wrote the capture, as it says. `other` rather than free
 * text, so the inbox can filter on it. `assistant` is the app's own chat pane
 * ("Save to knowledge base" on a reply), where there is no session to report.
 */
export const CAPTURE_CLIENTS = ['claude-code', 'cursor', 'codex', 'gemini', 'assistant', 'other'] as const;
export type CaptureClient = (typeof CAPTURE_CLIENTS)[number];

/** `session.files` is paths only, and at most this many. */
export const CAPTURE_SESSION_MAX_FILES = 20;

/**
 * Where a capture came from. Every field is the agent's own report: the
 * server infers none of it, and never receives a transcript.
 */
export interface CaptureSession {
  client: CaptureClient;
  clientVersion?: string;
  sessionId?: string;
  /** `owner/name` or a remote URL — whatever the kit read from `git remote`. */
  repo?: string;
  branch?: string;
  commit?: string;
  /** Repository paths the session touched; never their contents. */
  files?: string[];
  startedAt?: string;
}

/**
 * Who opened a merge request: a person (`manual`, the column default), an
 * agent's finding (`agent`), or an agent-session capture (`captured`). Closed:
 * the `merge_requests.provenance` CHECK reads this list.
 */
export const MR_PROVENANCES = ['manual', 'agent', 'captured'] as const;
export type MergeRequestProvenance = (typeof MR_PROVENANCES)[number];

/**
 * The state a capture is shown in. Derived, never stored: a `proposed` capture
 * whose merge request merged reads `merged`, one whose merge request was
 * closed reads `closed`, and everything else reads its stored status.
 *
 * A term has no merge request: approving it creates the glossary row at once,
 * so a `proposed` capture holding a `glossaryTermId` and no merge request is
 * already in the knowledge base and reads `merged` too.
 */
export function captureStateFor(
  status: CaptureStatus,
  mergeRequestStatus: string | null | undefined,
  approvedTermId?: string | null,
): CaptureState {
  if (status !== 'proposed') return status;
  if (!mergeRequestStatus && approvedTermId) return 'merged';
  if (mergeRequestStatus === 'merged') return 'merged';
  if (mergeRequestStatus === 'closed') return 'closed';
  return 'proposed';
}

// ---------------------------------------------------------------- the capture calls (phase 2)

/** The page-text kinds a `knowledge_capture_note` takes; `decision` and `answer` have their own tools. */
export const CAPTURE_NOTE_KINDS = ['gotcha', 'convention', 'howto'] as const;
export type CaptureNoteKind = (typeof CAPTURE_NOTE_KINDS)[number];

/** The kinds that become page text, and so are deduplicated against pages. */
export const CAPTURE_PAGE_KINDS: ReadonlySet<CaptureKind> = new Set(['decision', 'gotcha', 'convention', 'howto', 'answer']);

export const CAPTURE_TITLE_MAX_CHARS = 300;
/** Alternatives, related pages, `appliesTo` paths, aliases, citations: each list at most this long. */
export const CAPTURE_LIST_MAX = 20;
/** One list item, at most. */
export const CAPTURE_ITEM_MAX_CHARS = 500;

export interface DecisionCapturePayload {
  context: string;
  decision: string;
  consequences?: string;
  alternatives?: string[];
  relatedDocumentIds?: string[];
}

export interface NoteCapturePayload {
  body: string;
  /** Repository paths or entity keys the note is about. */
  appliesTo?: string[];
}

export interface GlossaryCapturePayload {
  term: string;
  definition: string;
  aliases?: string[];
  /** A page that defines the term in full. */
  documentId?: string;
}

export interface RelationCapturePayload {
  documentId: string;
  /** AUTHORABLE_RELATION_TYPES. */
  type: string;
  targetKey: string;
  rationale: string;
}

export interface AnswerCapturePayload {
  question: string;
  answer: string;
  /** At least one: an answer is written back only with the pages it stands on. */
  citedDocumentIds: string[];
}

interface CaptureRequestBase {
  workspaceId: string;
  session: CaptureSession;
}

/**
 * One capture, as the MCP tools and `POST /v1/captures` send it. The project
 * is required where nothing else names one: a relation takes its page's, an
 * answer its first cited page's unless it names one.
 */
export type CreateCaptureRequest = CaptureRequestBase &
  (
    | ({ kind: 'decision'; projectId: string; title: string } & DecisionCapturePayload)
    | ({ kind: CaptureNoteKind; projectId: string; title: string } & NoteCapturePayload)
    | ({ kind: 'glossary'; projectId: string } & GlossaryCapturePayload)
    | ({ kind: 'relation' } & RelationCapturePayload)
    | ({ kind: 'answer'; projectId?: string; title?: string } & AnswerCapturePayload)
  );

/** A page dedupe compared the capture with. `score` is raw cosine from the vector leg. */
export interface CaptureSimilar {
  documentId: string;
  title: string;
  score: number;
}

/** What a capture call answers: where the capture went, and what it was compared with. */
export interface CaptureResult {
  captureId: string;
  state: CaptureState;
  outcome: CaptureOutcome | null;
  mergeRequestId: string | null;
  targetDocumentId: string | null;
  glossaryTermId: string | null;
  /** The merge request, or the page a duplicate points at; null for a staged term. */
  webUrl: string | null;
  similar: CaptureSimilar[];
}

/** One row of the captures list. */
export interface CaptureInfo extends CaptureResult {
  workspaceId: string;
  projectId: string;
  kind: CaptureKind;
  title: string;
  session: CaptureSession;
  createdBy: string;
  apiKeyId: string | null;
  error: string | null;
  createdAt: string;
}

export interface ListCapturesResponse {
  captures: CaptureInfo[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------- the inbox (phase 3)

/** `POST /v1/captures/:id/reject`. The reason goes to the activity log; the row keeps no free text of the reviewer's. */
export interface RejectCaptureRequest {
  reason?: string;
}

/**
 * `POST /v1/assistant/messages/:id/capture`: an assistant reply written back as
 * an `answer` capture. The question is the user turn before it and the
 * citations are the reply's own sources, so the body names only what the
 * reply cannot: which project, and a title other than the question.
 */
export interface CaptureAssistantMessageRequest {
  projectId?: string;
  title?: string;
}
