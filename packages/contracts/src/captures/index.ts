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

/** The coding agent that wrote the capture, as it says. `other` rather than free text, so the inbox can filter on it. */
export const CAPTURE_CLIENTS = ['claude-code', 'cursor', 'codex', 'gemini', 'other'] as const;
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
 */
export function captureStateFor(status: CaptureStatus, mergeRequestStatus: string | null | undefined): CaptureState {
  if (status !== 'proposed') return status;
  if (mergeRequestStatus === 'merged') return 'merged';
  if (mergeRequestStatus === 'closed') return 'closed';
  return 'proposed';
}
