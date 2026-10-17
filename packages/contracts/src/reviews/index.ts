import type { ApiErrorPayload, RevisionInfo } from '@knowledge/contracts/core';
import type { CompareResponse } from '@knowledge/contracts/documents';
import type { MergeRequestProvenance } from '@knowledge/contracts/captures';

// ---------------------------------------------------------------------------

/** Path-level structural diff (plan.md §8): JSON/YAML content, or markdown frontmatter. */
export interface StructuralChange {
  /** Dotted path, e.g. "metadata.tags[0]". Empty string is the document root. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}
export interface StructuralDiff {
  /** What was diffed: the parsed content body (JSON/YAML) or markdown frontmatter. */
  source: 'content' | 'frontmatter';
  changes: StructuralChange[];
  summary: { added: number; removed: number; changed: number };
}

/** Semantic (graph-projection) diff between two revisions (plan.md §8). */
export interface SemanticRelationChange {
  type: string;
  targetKey: string;
  extractor: string;
  confidence: number;
}
export interface SemanticDiff {
  entities: { added: string[]; removed: string[] };
  relations: { added: SemanticRelationChange[]; removed: SemanticRelationChange[] };
  /** 1 - cosine(mean chunk embedding); null when either side has no indexed chunks. */
  embeddingShift: { score: number; meaningful: boolean } | null;
}

export type MergeRequestStatus = 'open' | 'merged' | 'closed';
export type MergeStrategy = 'merge-commit' | 'squash';

export interface MergeRequestInfo {
  mergeRequestId: string;
  documentId: string;
  title: string;
  description: string | null;
  sourceBranch: string;
  targetBranch: string;
  sourceHeadRevisionId: string | null;
  targetHeadRevisionId: string | null;
  /**
   * Nearest common ancestor of the two heads. Computed only on detail reads
   * and mutation responses; always null in list responses (avoids a graph
   * BFS per row).
   */
  mergeBaseRevisionId: string | null;
  status: MergeRequestStatus;
  /** Draft merge requests cannot be merged until the flag is cleared. */
  isDraft: boolean;
  /** Zeros-UUID stub when created without a principal (AUTH_MODE=none / MCP). */
  authorId: string;
  /** Single assignee (GitLab-style; advisory like reviewers). */
  assigneeId: string | null;
  approvedBy: string[];
  /** Assigned reviewer user ids (advisory — merging is gated by approval count, not reviewers). */
  reviewers: string[];
  /** Review-thread counts (computed on every read). */
  threadStats: { total: number; unresolved: number };
  strategy: MergeStrategy | null;
  mergedRevisionId: string | null;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  /** Who opened it: a person, an agent's finding, or an agent-session capture (issue #73). */
  provenance: MergeRequestProvenance;
  /** The `knowledge_captures` row it came from, when `provenance` is `captured` and a capture opened it. */
  captureId: string | null;
}

export interface CreateMergeRequestResponse {
  mergeRequest: MergeRequestInfo;
}

// GET /v1/documents/:id/merge-requests
export interface ListMergeRequestsResponse {
  documentId: string;
  mergeRequests: MergeRequestInfo[];
}

// GET /v1/merge-requests/:id/diff
export interface MergeRequestDiffResponse {
  mergeRequest: MergeRequestInfo;
  /** merge-base comparison targetHead...sourceHead, with structural + semantic sections. */
  compare: CompareResponse;
}

export interface MergeMergeRequestResponse {
  mergeRequest: MergeRequestInfo;
  mergedRevision: RevisionInfo | null;
}

/** 409 error envelope for If-Match / merge conflicts (plan.md §7): details always carries a comparison link. */
export interface RevisionConflictResponse extends ApiErrorPayload {
  code: 'CONFLICT';
  details: {
    currentHeadRevisionId: string | null;
    comparisonUrl: string | null;
  };
}

// GET /v1/merge-requests?workspaceId=…  (maps onto MCP knowledge_list_merge_requests)
export interface ListWorkspaceMergeRequestsRequest {
  workspaceId: string;
  status?: MergeRequestStatus;
  authorId?: string;
  /** Only merge requests with this user as the single assignee. */
  assigneeId?: string;
  /** Only merge requests with this user assigned as reviewer. */
  reviewerId?: string;
  documentId?: string;
  /** Case-insensitive substring match on the source branch name. */
  sourceBranch?: string;
  /** Case-insensitive substring match on the target branch name. */
  targetBranch?: string;
  /** Case-insensitive title substring match. */
  search?: string;
  /** Only merge requests opened this way, e.g. `captured` for agent-session captures. */
  provenance?: MergeRequestProvenance;
  cursor?: string;
  limit?: number;
}
export interface ListWorkspaceMergeRequestsResponse {
  workspaceId: string;
  mergeRequests: MergeRequestInfo[];
  nextCursor: string | null;
  /** Per-status totals for the same filters (status filter itself excluded) — drives the tab badges. */
  counts: { open: number; merged: number; closed: number };
}



// --- Saved merge-request filters -------------------------------------------
// A named narrowing of GET /v1/merge-requests, stored per user so it survives
// the session it was built in.

/** One chip of the filter bar, stored verbatim (mirrors ActiveFilter on the web). */
export interface SavedFilterChip {
  key: string;
  operator: string;
  values: string[];
}

/**
 * Everything that narrows the list, in one object — the status tab and the
 * typed search included, because those live outside the chip bar and a view
 * that restored only the chips could not express "my *open* reviews".
 */
export interface SavedFilterQuery {
  /** 'all' is the tab that applies no status filter; absent means the same. */
  status?: MergeRequestStatus | 'all';
  search?: string;
  chips: SavedFilterChip[];
}

/**
 * A saved view. The id is a small integer rather than the uuid every other
 * table uses, and deliberately so: it is shown to the user (`#7`) and carried
 * in the URL (`/merge-requests?view=7`), which a uuid cannot be.
 *
 * Views are private to their owner. The workspace is still recorded — the
 * chips hold member ids and branch names that only mean anything inside it,
 * and losing membership must take the view with it.
 */
export interface SavedFilter {
  id: number;
  workspaceId: string;
  ownerId: string;
  name: string;
  query: SavedFilterQuery;
  createdAt: string;
  updatedAt: string;
}

// GET /v1/merge-requests/filters?workspaceId=…
export interface ListSavedFiltersResponse {
  workspaceId: string;
  filters: SavedFilter[];
}



/**
 * 409 `details` vocabulary for merge gating (see RevisionConflictResponse for
 * the diverged case): `draft` — MR is flagged draft; `approvals` — fewer
 * non-author approvals than MR_REQUIRED_APPROVALS; `diverged` — target branch
 * advanced past the merge base (fast-forward precondition); `breaking-api` —
 * a spec document's source head breaks its API under a `block` policy and no
 * admin has acknowledged that head (#78).
 */
export interface MergeGateConflictDetails {
  reason: 'draft' | 'approvals' | 'diverged' | 'breaking-api';
  breakingCount?: number;
  requiredApprovals?: number;
  approvals?: number;
  currentHeadRevisionId?: string | null;
  comparisonUrl?: string | null;
}

// ---------------------------------------------------------------------------
// Merge request checks (#74)
// ---------------------------------------------------------------------------

/** What a merge request is checked for. Only the style lint, today. */
export const MR_CHECK_KINDS = ['lint'] as const;
export type MergeRequestCheckKind = (typeof MR_CHECK_KINDS)[number];

/**
 * A check's state. `running` is never stored: it is a pending check whose
 * agent run the worker has claimed, derived on read. `failed` means the head
 * has violations; `error` that the check could not run, which never blocks
 * (fail-open).
 */
export const MR_CHECK_STATUSES = ['pending', 'running', 'passed', 'failed', 'error', 'skipped'] as const;
export type MergeRequestCheckStatus = (typeof MR_CHECK_STATUSES)[number];

/** Why a check was skipped or errored — only what the code emits. */
export const MR_CHECK_REASONS = [
  /** A newer push replaced the head before the check ran. */
  'superseded',
  /** No styleguide applies, or none of its rules is enabled. */
  'no-styleguide',
  /**
   * The page is not open to every member. A run's findings are listed to the
   * whole workspace, so a page some members cannot read is not linted.
   */
  'restricted',
  /** The merge request's author cannot act any more (disabled, or not a member). */
  'author-unavailable',
  /** The author's or the workspace's AI budget is spent. */
  'budget',
  /** The agent run failed — the provider, the model or the prompt. */
  'run-failed',
  /** The run finished more than a day ago, e.g. across an outage: not published. */
  'stale',
] as const;
export type MergeRequestCheckReason = (typeof MR_CHECK_REASONS)[number];

/**
 * What a merge request's style lint does (#74): `off` checks nothing and calls
 * no model, `warn` posts the violations as threads and merges anyway, `block`
 * (phase 3) refuses the merge while an error-severity violation is unresolved.
 * The vocabulary of {@link API_BREAKING_CHANGE_POLICIES}.
 */
export const LINT_POLICIES = ['off', 'warn', 'block'] as const;
export type LintPolicy = (typeof LINT_POLICIES)[number];

/**
 * The lint policy of one scope, as asked for beside as applied. `requested` is
 * this scope's own row (null inherits), `inherited` what it would inherit, and
 * `effective` the narrower of the two with the deployment's ceiling
 * (STYLE_LINT_POLICY) — or `off` while the `linter` agent is disabled.
 * `source` names what decided it, so the settings page never shows a clamp as
 * the setting.
 */
export interface LintPolicySettings {
  workspaceId: string;
  projectId: string | null;
  requested: LintPolicy | null;
  inherited: LintPolicy;
  ceiling: LintPolicy;
  effective: LintPolicy;
  source: 'scope' | 'inherited' | 'ceiling' | 'agent-disabled';
  linterEnabled: boolean;
}

// PUT /v1/lint-policy
export interface UpdateLintPolicyRequest {
  workspaceId: string;
  /** Absent or null: the workspace's own policy. */
  projectId?: string | null;
  /** null goes back to inheriting. */
  policy: LintPolicy | null;
}

export interface MergeRequestCheckCounts {
  error: number;
  warning: number;
  suggestion: number;
}

export interface MergeRequestCheckInfo {
  checkId: string;
  mergeRequestId: string;
  kind: MergeRequestCheckKind;
  headRevisionId: string;
  /** Whether this is the check of the source branch's current head. */
  current: boolean;
  status: MergeRequestCheckStatus;
  reason: MergeRequestCheckReason | null;
  styleguideId: string | null;
  agentRunId: string | null;
  /** Violations by severity, once published. */
  counts: MergeRequestCheckCounts | null;
  /** Lint threads of this check nobody has resolved yet. */
  unresolved: number;
  createdAt: string;
  publishedAt: string | null;
}

// GET /v1/merge-requests/:id/checks — newest first.
export interface ListMergeRequestChecksResponse {
  mergeRequestId: string;
  /** The policy that applies to this merge request's page. */
  policy: LintPolicySettings;
  checks: MergeRequestCheckInfo[];
}

/**
 * Review threads (plan.md §8): anchors are optional and best-effort — a line
 * anchor pins the source-head revision at comment time and is shown as
 * "outdated" (not re-anchored) once that branch advances.
 */
export type MergeRequestThreadAnchor =
  | { type: 'line'; revisionId: string; line: number; excerpt?: string }
  /**
   * Feature 13 review mode: a comment left on the *rendered* page rather than
   * on a diff line. Positions are quote-based (W3C TextQuoteSelector shape) —
   * line numbers do not survive rendering, and a quote plus its surrounding
   * context re-finds itself after edits that shift every line number.
   */
  | { type: 'text'; revisionId: string; quote: string; prefix?: string; suffix?: string }
  | { type: 'section'; heading: string }
  | { type: 'entity'; entityKey: string };

/**
 * Anchors are not a merge-request idea — the same quote-based selector pins a
 * comment to a passage of a *published* page (feature 15). The MR-prefixed name
 * is kept because it is the one already on the wire.
 */
export type ReviewThreadAnchor = MergeRequestThreadAnchor;

export interface ReviewComment {
  commentId: string;
  threadId: string;
  authorId: string;
  body: string;
  /**
   * The comment this one answers, when it answers one in particular rather
   * than the thread as a whole. Null on the opening comment, and on a reply
   * written to the discussion at large.
   *
   * The comment list stays flat and createdAt-ordered — this is attribution,
   * not nesting. A reader needs to know *which* remark a reply picks up; they
   * do not need the tree that indenting a conversation would produce, and a
   * thread that anchors to one passage is short enough not to want one.
   */
  replyToId: string | null;
  createdAt: string;
  /**
   * When the author last rewrote the body, or null while it stands as first
   * posted. A discussion is a record of what people said, so an edit is shown
   * as an edit rather than silently replacing the text.
   */
  updatedAt: string | null;
  /**
   * The agent that wrote this, or null when a person did.
   *
   * `ReviewThreadSource` answers the same question for a thread, but only about
   * its opening comment. An agent brought in by an @mention replies inside
   * somebody else's thread, and `authorId` is the person who mentioned it — so
   * without this the reply would render under their name and their face, which
   * is the one thing a reader must not be misled about.
   */
  agentKey: string | null;
  /**
   * The agent has been asked and has not answered yet. A model turn outlives
   * the request that triggers it, so the comment is posted empty and filled in
   * when the answer arrives; until then the body is a placeholder, not a reply.
   */
  pending: boolean;
}

/**
 * The attribute an agent mention is written as, shared so the editor node that
 * creates it, the markdown serializer that stores it and the API parser that
 * reads it cannot drift apart (the CONNECTOR_KIND_INFO precedent).
 *
 * A person's mention is `data-kn-user` with a UUID; an agent has a slug key and
 * no users row, so it cannot reuse that attribute even though it renders
 * alongside one in the same @ menu.
 */
export const AGENT_MENTION_ATTR = 'data-kn-agent';

/**
 * The attribute a person's mention is written as — the same contract as
 * `AGENT_MENTION_ATTR`, for the same reason: the editor node that creates it,
 * the turndown rule that stores it and the API scanner that reads it out of a
 * comment body must not be able to drift apart.
 *
 * The value is a `users.id`, so a mention resolves against `workspace_members`
 * and a hand-typed uuid from another tenant notifies nobody.
 */
export const USER_MENTION_ATTR = 'data-kn-user';


/**
 * DELETE .../threads/:threadId/comments/:commentId — the comment's own author
 * only, like editing.
 *
 * `thread` comes back null when the deleted comment was the last one in it: a
 * discussion with nothing said in it is not a discussion, so it goes too, and
 * the client drops the card rather than rendering an empty one. Replies that
 * pointed at the deleted comment keep their place and lose their attribution
 * (`replyToId` becomes null) rather than being deleted along with it.
 */
export interface DeleteReviewCommentResponse {
  threadId: string;
  thread: ReviewThread | null;
}

/**
 * What every discussion has regardless of what it hangs off: a resolvable
 * thread holding a flat, createdAt-ordered comment list. The subject id is
 * added by the extending interface, which is what lets one ThreadCard render
 * both a review thread and a page comment.
 */
/**
 * Who opened a discussion. The assistant posts under the identity of whoever
 * ran it, so the author id cannot answer this — and a reader deciding how much
 * weight to give a remark needs to know whether a person or a model wrote it.
 */
export type ReviewThreadSource = 'human' | 'ai';

export interface ReviewThread {
  threadId: string;
  source: ReviewThreadSource;
  /**
   * GitLab's two shapes of remark: `false` is a plain comment (says
   * something), `true` a thread (asks for something, and is not done until
   * someone resolves it). Only a resolvable thread shows Resolve, and only an
   * unresolved resolvable thread counts against a merge.
   */
  resolvable: boolean;
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
  anchor: ReviewThreadAnchor | null;
  comments: ReviewComment[];
  createdAt: string;
}

export type MergeRequestComment = ReviewComment;

export interface MergeRequestThread extends ReviewThread {
  mergeRequestId: string;
  /** The lint check that opened it (#74); null on every other thread. */
  checkId: string | null;
  /** The styleguide rule a lint thread cites. */
  ruleId: string | null;
}

// GET /v1/merge-requests/:id/threads
export interface ListMergeRequestThreadsResponse {
  mergeRequestId: string;
  threads: MergeRequestThread[];
}




// DELETE /v1/merge-requests/:id/threads/:threadId/comments/:commentId
export interface DeleteMergeRequestCommentResponse extends DeleteReviewCommentResponse {
  thread: MergeRequestThread | null;
}


// ---------------------------------------------------------------------------
// Feature 15 — comments on the page
