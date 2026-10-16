import type {
  AnswerCitation,
  AnswerConfidence,
  ApiErrorPayload,
  AssistantSource,
  AssistantToolCall,
  AssistantWebSource,
  SourceVerificationState,
} from '@knowledge/contracts/core';
import type { RelationInput } from '@knowledge/contracts/documents';
import type { AiActionId } from '@knowledge/contracts/content';

// (docs/features/09 follow-up). The chat is an append-only intent log; the
// sidebar materializes from each assistant message's toolCalls trace rather
// than parsed chat text. AI-authored writes never touch a document directly:
// create_document makes a brand-new page (nothing existing to protect,
// mirrors the plain POST /v1/documents flow); propose_update always drafts a
// revision on a fresh branch and opens a merge request for a human to merge.
// ---------------------------------------------------------------------------

export type AssistantMessageRole = 'user' | 'assistant';

export interface AssistantThreadSummary {
  id: string;
  workspaceId: string;
  documentId: string | null;
  title: string | null;
  /** Provider profile pinned to this thread, when the member picked one. */
  providerId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Truncated content of the most recent message — history-list preview. */
  lastMessagePreview?: string;
}

/** 'ask' = read-only tools only (default, safe); 'agent' = also allows create_document/propose_update. */
export type AssistantChatMode = 'ask' | 'agent';

/** Ad hoc file content attached to one turn (e.g. from the composer's upload/drop widget) — used as extra
 * context for that turn only, never persisted verbatim into thread history. */
export interface AssistantChatAttachment {
  filename: string;
  content: string;
}

/** Generative UI: instead of only prose, the assistant can ask the chat pane to render one of a small,
 * fixed whitelist of EXISTING product components inline — the same GraphView/ActivityFeed/SearchWidget
 * already used on document pages, not bespoke chat-only widgets. `props` is forwarded verbatim to that
 * Vue component; the backend tool that produces a block validates/resolves everything in it (workspace
 * ownership of any documentId) before it ever reaches the client, so the client can render blindly. */
export type AssistantUiComponent = 'graph' | 'activity' | 'search';
export interface AssistantUiBlock {
  component: AssistantUiComponent;
  props: Record<string, unknown>;
}

/**
 * The assistant asking the user something, instead of guessing.
 *
 * Distinct from {@link AssistantUiBlock}, which renders a view: a prompt is
 * answerable, and its answer becomes the next turn. The assistant raises one
 * by calling a tool, so the pane never has to infer "it wants me to pick
 * something" by reading the prose — the same rule that keeps the documents
 * sidebar off the chat text.
 *
 * Only the newest message's prompt is live. Once it has been answered the
 * answer is in the transcript above it, so an older prompt renders as the
 * record of a question already settled.
 */
export interface AssistantPromptOption {
  value: string;
  label: string;
  /** One line of help under the option. */
  description?: string;
}

export type AssistantPromptField =
  /** Exactly one of the options — radios. */
  | { type: 'choice'; name: string; label: string; options: AssistantPromptOption[]; required?: boolean }
  /** Any number of the options — checkboxes. */
  | { type: 'checklist'; name: string; label: string; options: AssistantPromptOption[]; required?: boolean }
  /** Free text, for what the options cannot cover. */
  | { type: 'text'; name: string; label: string; placeholder?: string; multiline?: boolean; required?: boolean };

export interface AssistantFormPrompt {
  kind: 'form';
  /** What is being asked, in the assistant's own words. */
  question: string;
  fields: AssistantPromptField[];
  submitLabel?: string;
  /** Adds a free-text box so the user can answer outside the offered options. */
  allowOther?: boolean;
}

/**
 * The assistant wanted to write something while the chat was in Ask mode.
 * Rather than telling the user to go and flip a toggle, it hands them the
 * toggle: switching re-sends `intent` as an Agent turn.
 */
export interface AssistantModeSwitchPrompt {
  kind: 'mode-switch';
  /** What it will do once it can write — shown before the user agrees to it. */
  intent: string;
}

export type AssistantPrompt = AssistantFormPrompt | AssistantModeSwitchPrompt;

// ---------------------------------------------------------------------------
// Answer feedback (docs/features/38, issue #67 phase 2)
// ---------------------------------------------------------------------------

/**
 * Where an answer was given, and therefore where a vote on it came from. A
 * closed list because the admin tab (phase 5) filters by it in SQL and the
 * surveyor (phase 4) reports the mix per cluster.
 *
 * `editor-assistant` is the same `ChatPane` as `assistant`, mounted beside a
 * draft (docs/features/34): the API cannot tell the two apart from a message
 * row, so the client says which pane it is voting from and the API only
 * checks the value is one of these.
 *
 * `chat` is a chat-platform bot (issue #71): a Telegram DM or channel turn,
 * persisted as an assistant thread like the pane's, but answered somewhere
 * the web app cannot vote from.
 */
export const ANSWER_SURFACES = ['assistant', 'editor-assistant', 'ask', 'mcp', 'chat'] as const;
export type AnswerSurface = (typeof ANSWER_SURFACES)[number];

export const ANSWER_RATINGS = ['up', 'down'] as const;
export type AnswerRating = (typeof ANSWER_RATINGS)[number];

/**
 * Why an answer was voted down. Required on `down`, optional on `up`: a thumbs
 * up needs no explanation, and a thumbs down with none is a number nobody can
 * act on. `wrong` and `outdated` are the two that name a page (phase 3 lets
 * such a vote file a report against the cited pages).
 */
export const ANSWER_FEEDBACK_REASONS = [
  'wrong',
  'outdated',
  'incomplete',
  'irrelevant-sources',
  'no-answer',
  'unclear',
  'other',
] as const;
export type AnswerFeedbackReason = (typeof ANSWER_FEEDBACK_REASONS)[number];

/**
 * What one `answer_feedback` row records: an explicit vote, or a miss the
 * harness noticed on its own. Misses only — a good answer nobody rated writes
 * nothing, which keeps the table bounded and keeps measurement in the JSONL
 * stream where it belongs.
 */
export const ANSWER_SIGNAL_KINDS = ['vote', 'low-confidence', 'no-answer'] as const;
export type AnswerSignalKind = (typeof ANSWER_SIGNAL_KINDS)[number];

export const ANSWER_FEEDBACK_COMMENT_MAX_CHARS = 2_000;

/** The caller's own vote on one answer — what the thumbs under a message show. */
export interface AnswerVote {
  rating: AnswerRating;
  reason: AnswerFeedbackReason | null;
  comment: string | null;
  createdAt: string;
}

/** One stored feedback row, as the vote routes and the admin tab (phase 5) return it. */
export interface AnswerFeedbackInfo {
  id: string;
  workspaceId: string;
  kind: AnswerSignalKind;
  surface: AnswerSurface;
  rating: AnswerRating | null;
  reason: AnswerFeedbackReason | null;
  comment: string | null;
  /** The question the answer was for. */
  query: string;
  /** Null for a one-shot `/ask` answer or an MCP vote: nothing persisted to point at. */
  messageId: string | null;
  threadId: string | null;
  /** MCP only: the `knowledge_search` call the agent built its answer from. */
  traceId: string | null;
  citedDocumentIds: string[];
  /** The answer's confidence when it was given, so a vote can be read against it later. */
  confidence: AnswerConfidence | null;
  createdBy: string;
  createdAt: string;
}

// PUT /v1/assistant/messages/:id/feedback, POST /v1/assistant/ask/feedback
/**
 * One row of the admin Feedback tab (phase 5): a vote or an implicit signal,
 * with the first part of the answer and the cited pages resolved to titles.
 */
export interface AnswerFeedbackListEntry extends AnswerFeedbackInfo {
  answerExcerpt: string | null;
  citedDocuments: Array<{ id: string; title: string | null }>;
}

export interface ListAnswerFeedbackResponse {
  workspaceId: string;
  entries: AnswerFeedbackListEntry[];
  nextCursor: string | null;
}

/** Counts over `answer_feedback` and `knowledge_issues` in a window — no aggregate table behind it. */
export interface AnswerFeedbackSummary {
  workspaceId: string;
  from: string;
  to: string;
  votes: { up: number; down: number };
  signals: { 'low-confidence': number; 'no-answer': number };
  byReason: Array<{ reason: AnswerFeedbackReason; count: number }>;
  bySurface: Array<{ surface: AnswerSurface; count: number }>;
  issues: Array<{ status: KnowledgeIssueStatus; count: number }>;
  /** Votes the export turns into a `FeedbackBacktestCase`: cited at least one page, and either an up-vote or a down-vote that blames the pages. */
  datasetVotes: number;
}

export interface SetAnswerFeedbackResponse {
  feedback: AnswerFeedbackInfo;
}

// DELETE /v1/assistant/messages/:id/feedback
export interface DeleteAnswerFeedbackResponse {
  ok: true;
  /** False when there was no vote to retract — still a 200, the end state is the same. */
  removed: boolean;
}

// ---------------------------------------------------------------------------
// Knowledge issues (docs/features/38, issue #67 phase 3): a reported problem
// with a page — from an agent over MCP, from a person on the page, or from a
// down-vote that named the pages it cited.
// ---------------------------------------------------------------------------

/** What is wrong with the page, in the reporter's words. Closed: the sentinel judges `stale`/`wrong`, the rest wait for a person. */
export const KNOWLEDGE_ISSUE_KINDS = ['stale', 'wrong', 'missing', 'duplicate', 'other'] as const;
export type KnowledgeIssueKind = (typeof KNOWLEDGE_ISSUE_KINDS)[number];

/**
 * Where a report is on its way to a fix.
 *
 * `open` waits for a person; `checking` has a sentinel run queued or running;
 * `proposed` has a merge request to review; `resolved` and `dismissed` are
 * closed. The first three count as *open* for the page's `flagged` state and
 * for dedupe — `isOpenIssueStatus` is that predicate, and the guard, the
 * provenance count and the rail all read it rather than a copy.
 */
export const KNOWLEDGE_ISSUE_STATUSES = ['open', 'checking', 'proposed', 'resolved', 'dismissed'] as const;
export type KnowledgeIssueStatus = (typeof KNOWLEDGE_ISSUE_STATUSES)[number];
export const OPEN_KNOWLEDGE_ISSUE_STATUSES: readonly KnowledgeIssueStatus[] = ['open', 'checking', 'proposed'];
export function isOpenIssueStatus(status: string): boolean {
  return (OPEN_KNOWLEDGE_ISSUE_STATUSES as readonly string[]).includes(status);
}

/** The two terminal states a person may set by hand. */
export const KNOWLEDGE_ISSUE_CLOSE_STATUSES = ['resolved', 'dismissed'] as const;

/** Where a report came from: an answer surface, or the page itself. */
export const KNOWLEDGE_ISSUE_SURFACES = [...ANSWER_SURFACES, 'web'] as const;
export type KnowledgeIssueSurface = (typeof KNOWLEDGE_ISSUE_SURFACES)[number];

export const KNOWLEDGE_ISSUE_DETAIL_MAX_CHARS = 4_000;
export const KNOWLEDGE_ISSUE_EVIDENCE_MAX = 10;
export const KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS = 2_000;
export const KNOWLEDGE_ISSUE_SUGGESTION_MAX_CHARS = 200_000;

/** One piece of evidence behind a report. Untrusted text, every field. */
export interface KnowledgeIssueEvidence {
  /** A passage of the page the reporter disputes. */
  quote?: string;
  /** Where the correct information is. */
  url?: string;
  /** Anything else — a verdict the sentinel attached is a note too. */
  note?: string;
}

export interface KnowledgeIssueInfo {
  id: string;
  workspaceId: string;
  documentId: string;
  documentTitle: string | null;
  /** The revision the reporter read, when they said. */
  revisionId: string | null;
  kind: KnowledgeIssueKind;
  status: KnowledgeIssueStatus;
  detail: string;
  evidence: KnowledgeIssueEvidence[];
  /** Whether a corrected body came with the report; the body itself is not returned on a list. */
  hasSuggestion: boolean;
  surface: KnowledgeIssueSurface;
  /** Reports folded into this one: a second report of the same (page, kind) while it is open. */
  reportCount: number;
  /** The sentinel run checking it, once one was queued. */
  agentRunId: string | null;
  /** The merge request that proposes the fix, once one exists. */
  mergeRequestId: string | null;
  createdBy: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// POST /v1/knowledge-issues, knowledge_report_issue
export interface ReportKnowledgeIssueResponse {
  issue: KnowledgeIssueInfo;
  /** True when the report folded into an issue that was already open for the page and kind. */
  deduplicated: boolean;
}

// GET /v1/knowledge-issues?workspaceId=&documentId=&status=
export interface ListKnowledgeIssuesResponse {
  workspaceId: string;
  issues: KnowledgeIssueInfo[];
}

// PATCH /v1/knowledge-issues/:id
export interface UpdateKnowledgeIssueResponse {
  issue: KnowledgeIssueInfo;
}

export interface AssistantMessageInfo {
  id: string;
  threadId: string;
  role: AssistantMessageRole;
  content: string;
  toolCalls: AssistantToolCall[];
  sources: AssistantSource[];
  uiBlocks: AssistantUiBlock[];
  /** Set when the turn ended by asking the user something. At most one per turn. */
  prompt: AssistantPrompt | null;
  /**
   * Sentence-level citations into `content` (docs/features/38). Empty for user
   * turns and for assistant rows persisted before the feature.
   */
  citations: AnswerCitation[];
  /** Null for user turns and pre-feature rows; the badge is simply not drawn. */
  confidence: AnswerConfidence | null;
  /**
   * The caller's own vote on this answer (docs/features/38, phase 2). Present
   * only when a thread is read back — a `done` frame carries none, because a
   * reply nobody has seen yet cannot have been rated.
   */
  feedback?: AnswerVote | null;
  createdAt: string;
}

export interface CreateAssistantThreadResponse {
  thread: AssistantThreadSummary;
}

export interface ListAssistantThreadsResponse {
  threads: AssistantThreadSummary[];
  /** Null when this page is the last one. */
  nextCursor: string | null;
}

// GET /v1/assistant/threads/:id
export interface GetAssistantThreadResponse {
  thread: AssistantThreadSummary;
  messages: AssistantMessageInfo[];
}

export interface UpdateAssistantThreadResponse {
  thread: AssistantThreadSummary;
}

// DELETE /v1/assistant/threads/:id — the thread and its whole message history.
export interface DeleteAssistantThreadResponse {
  ok: boolean;
}

// DELETE /v1/assistant/threads/:id/messages/:messageId
// Rewinds the thread: drops that message and every message after it. What the
// per-message reset and edit controls cut with — both cut inclusively, which
// is why there is no mode flag.
export interface TruncateAssistantThreadResponse {
  /** How many messages were dropped. */
  removed: number;
  thread: AssistantThreadSummary;
  /** The surviving history, oldest first — the client replaces its state with this. */
  messages: AssistantMessageInfo[];
}

// POST /v1/assistant/threads/:id/messages
export interface PostAssistantMessageRequest {
  content: string;
  /** Overrides the thread's default grounding document for this turn. */
  documentId?: string;
  /** Defaults to 'ask' server-side when omitted. */
  mode?: AssistantChatMode;
  attachments?: AssistantChatAttachment[];
  /** Existing workspace documents manually picked ("Apply documents" widget) to ground this turn in,
   * in addition to (or instead of) the thread's default grounding document. Full content is fetched
   * server-side from the documentId — the model never receives raw pasted text for these. */
  documentRefs?: string[];
  /**
   * The page as it stands in the author's editor right now, unstaged edits and
   * all (docs/features/34). Grounds the turn in what is on screen rather than
   * the published head, and is what offers the model `edit_draft` — an edit to
   * a draft nobody sent would have nowhere to land.
   */
  draft?: AssistantDraft;
}

/** Longest draft the editor may send — a long page, not a book. The prompt still slices it. */
export const ASSISTANT_DRAFT_MAX_CHARS = 100_000;

export interface AssistantDraft {
  title: string;
  markdown: string;
  /**
   * The template this new page was started from (issue #69). Tells the turn
   * the draft is a skeleton to fill in, section by section; the template's
   * own notes ride along wrapped as untrusted. A ref the workspace cannot
   * resolve is ignored rather than refused — the draft is still a draft.
   */
  template?: AssistantDraftTemplate;
}

export interface AssistantDraftTemplate {
  /** A template id or `builtin:<key>` (`TemplateRef`). */
  ref: string;
  version: number;
}

/**
 * Where an `edit_draft` lands. Block-level on purpose: the model quotes text to
 * find the block(s) it means, and the edit replaces or sits beside those whole
 * blocks — the unit an author accepts or discards, and the one a markdown quote
 * can find again in a rich document.
 */
export const DRAFT_EDIT_OPS = ['replace', 'insert_after', 'insert_before', 'append', 'rewrite'] as const;
export type DraftEditOp = (typeof DRAFT_EDIT_OPS)[number];

/** Ops that need an `anchor` quote; `append` and `rewrite` address the whole page. */
export function draftEditNeedsAnchor(op: DraftEditOp): boolean {
  return op !== 'append' && op !== 'rewrite';
}

/**
 * One suggested change to the author's draft, as it streams.
 *
 * The same `id` arrives many times: `streaming` while the model is still
 * writing the tool call's arguments (`markdown` grows, never shrinks), then
 * exactly one terminal state. Nothing is written anywhere by this — the editor
 * shows it as a suggestion the author accepts or discards.
 */
export interface AssistantDraftEdit {
  id: string;
  op: DraftEditOp;
  /** A quote from the draft's markdown naming the block(s) to act on; null for append/rewrite. */
  anchor: string | null;
  markdown: string;
  /**
   * `ready`: the arguments are complete and the anchor was found.
   * `rejected`: refused server-side (anchor not in the draft, bad op) — the
   * editor drops whatever it previewed, and the model is told to try again.
   */
  state: 'streaming' | 'ready' | 'rejected';
}
export interface PostAssistantMessageResponse {
  /** False when ASSISTANT_PROVIDER=none — UI degrades instead of erroring. */
  enabled: boolean;
  userMessage: AssistantMessageInfo;
  assistantMessage: AssistantMessageInfo;
}



// ---------------------------------------------------------------------------
// Streamed turn: POST /v1/assistant/threads/:id/messages/stream
// ---------------------------------------------------------------------------
// Same turn as POST .../messages, delivered as it happens instead of in one
// response. It is a POST, so EventSource cannot read it — the client posts
// with fetch and parses the `text/event-stream` body itself (which also means
// the Authorization header works normally, no ?token= escape hatch).
//
// The harness runs in rounds: the model may narrate, call tools, then narrate
// again. Every round's prose streams as `delta` frames; a `tool-call` frame
// with phase 'started' closes the current round, so the client folds whatever
// it has buffered into the visible reasoning trail and starts a fresh buffer.
// Only the final round survives as the persisted message, which arrives whole
// in `done` — so a client that ignores every delta still ends up correct.


export type AssistantStreamFrame =
  /** The user's turn, persisted, with its real id — replaces the client's optimistic copy. */
  | { type: 'user-message'; message: AssistantMessageInfo }
  /** Coarse phase for the status line, ahead of any token. */
  | { type: 'status'; phase: 'thinking' | 'responding' }
  /** A chunk of the current round's prose. Append verbatim; never re-order. */
  | { type: 'delta'; text: string }
  /** Tool lifecycle. 'started' also means "close the current round". */
  | { type: 'tool-call'; phase: 'started'; tool: string; arguments?: string }
  | { type: 'tool-call'; phase: 'finished'; tool: string; ok: boolean }
  /** A generative-UI block resolved server-side, safe to render as it lands. */
  | { type: 'ui-block'; block: AssistantUiBlock }
  /** The turn is ending in a question for the user; `done` carries it too. */
  | { type: 'prompt'; prompt: AssistantPrompt }
  /** Grounding documents accumulated so far — the sidebar can fill in mid-turn. */
  | { type: 'sources'; sources: AssistantSource[] }
  /** A suggested edit to the draft the turn was sent with, streaming into the editor (docs/features/34). */
  | { type: 'draft-edit'; edit: AssistantDraftEdit }
  /** Terminal success: the persisted assistant message, authoritative over every delta. */
  | { type: 'done'; message: AssistantMessageInfo }
  /** Terminal failure. The user message is already persisted; the turn is not. */
  | { type: 'error'; error: ApiErrorPayload };

// ---------------------------------------------------------------------------
// Auth flow — login / signup / password restoration (session tokens on top of
// workspace: provider config, skills, MCP plugins, token accounting, call log.
// ---------------------------------------------------------------------------

/**
 * Which layer an effective config field came from.
 *
 * `clamped` (docs/features/25) is neither: the workspace asked for one thing
 * and the deployment ceiling gave it another. It exists because a silent clamp
 * is a lie about what the workspace is configured to do — the badge has to be
 * able to say "you asked for open; this deployment allows allowlist".
 */
export type AiSettingsSource = 'db' | 'env' | 'clamped';
export interface AiSettingsSourceMap {
  provider: AiSettingsSource;
  baseUrl: AiSettingsSource;
  model: AiSettingsSource;
  apiKey: AiSettingsSource;
  temperature: AiSettingsSource;
  maxToolCalls: AiSettingsSource;
  timeoutMs: AiSettingsSource;
  extractionMinConfidence: AiSettingsSource;
  extractionMaxChunks: AiSettingsSource;
  /** docs/features/25 — 'clamped' when the ceiling overrode the workspace. */
  webAccessMode: AiSettingsSource;
  /** Issue #68 — 'clamped' when AI_EXTERNAL_ACTIONS_ENABLED=false overrode the workspace. */
  externalAiActions: AiSettingsSource;
}

/**
 * Whether a page's AI actions menu may offer "Open in ChatGPT / Claude /
 * Cursor", which send the page to a vendor inside a URL (issue #68).
 *
 * The env flag is a ceiling, not a default: `effective` is the narrower of the
 * two, and `requested` survives beside it so the admin page can say that the
 * deployment overrode the workspace rather than silently showing "off".
 */
export interface ExternalAiActionsSettings {
  /** What the workspace asked for. Null = inherit the ceiling. */
  requested: boolean | null;
  /** The deployment ceiling (AI_EXTERNAL_ACTIONS_ENABLED). */
  ceiling: boolean;
  /** What applies: `requested ?? ceiling`, never above `ceiling`. */
  effective: boolean;
  /** 'clamped' when the workspace asked for true and the ceiling said false. */
  source: AiSettingsSource;
}

/**
 * A workspace setting the deployment caps: `requested` beside `ceiling` and
 * what applies, so the settings page can say the deployment overrode the
 * workspace instead of silently showing the lower value. The shape of
 * ExternalAiActionsSettings, for any value type.
 */
export interface CeilingSetting<T> {
  /** What the workspace asked for. Null = inherit the ceiling. */
  requested: T | null;
  /** The deployment ceiling (the env var). */
  ceiling: T;
  /** What applies: `requested ?? ceiling`, never above `ceiling`. */
  effective: T;
  /** 'clamped' when the workspace asked for more than the ceiling. */
  source: AiSettingsSource;
}

/** A workspace override of an env default that is not a ceiling — raising it widens nothing. */
export interface OverrideSetting<T> {
  /** What the workspace set. Null = inherit the env default. */
  requested: T | null;
  /** What applies. */
  effective: T;
  source: 'db' | 'env';
}

/**
 * Agent-session memory settings (issue #73). The switch and the two rate
 * limits are capped by CAPTURE_*; the thresholds are tuning — an embedding
 * model's cosine scale differs, and moving them widens nothing.
 */
export interface CaptureSettings {
  enabled: CeilingSetting<boolean>;
  /** Captures one API key may stage per rolling hour. */
  perKeyPerHour: CeilingSetting<number>;
  /** Captures the workspace accepts per rolling day, all keys together. */
  perWorkspacePerDay: CeilingSetting<number>;
  /** Cosine to the nearest page at or above which a capture is a duplicate candidate. */
  dedupeThreshold: OverrideSetting<number>;
  /** Cosine at or above which a capture amends that page instead of starting a new one. Never above `dedupeThreshold`. */
  amendThreshold: OverrideSetting<number>;
  /** The page new captured pages nest under; null for the project root. */
  parentDocumentId: string | null;
}

// ---- Web research: access mode and source policies (docs/features/25) ------

/**
 * How much of the open web this workspace may reach.
 *
 * - `off` — the two web tools are not offered to the model at all. The default,
 *   and what every deployment that never sets WEB_ACCESS_MODE keeps.
 * - `allowlist` — an unlisted domain is refused; policy rows say what may be
 *   fetched.
 * - `open` — an unlisted domain is fetched; policy rows say what may not be.
 *
 * The same value is both the env ceiling and the workspace setting, and the
 * effective one is the *narrower* of the two: a settings row must never widen
 * what the model reaches (the rule feature 20 committed to for tool
 * allowlists).
 */
export type WebAccessMode = 'off' | 'allowlist' | 'open';

/** Narrowness order — index 0 is the narrowest. Exported so the clamp is one comparison. */
export const WEB_ACCESS_MODES: readonly WebAccessMode[] = ['off', 'allowlist', 'open'];

/** The effective web-access configuration, with the ceiling shown beside it. */
export interface WebAccessSettings {
  /** What the workspace asked for. Null = inherit the ceiling. */
  requested: WebAccessMode | null;
  /** The deployment ceiling (WEB_ACCESS_MODE). */
  ceiling: WebAccessMode;
  /** What actually applies: the narrower of `requested` and `ceiling`. */
  effective: WebAccessMode;
  /** 'clamped' when `requested` was wider than `ceiling` — the page must say so. */
  source: AiSettingsSource;
  /** False when WEB_SEARCH_URL is unset: fetching works, searching cannot. */
  searchConfigured: boolean;
}

/**
 * One exception to whatever the mode's default reading is.
 *
 * `allow` is the only enforceable field, so it is the only field there is — a
 * tier ladder (trusted/untrusted) reduces to instructions in a prompt, and a
 * prompt rule is advisory. Under `allowlist`, rows with `allow: true` are what
 * may be fetched; under `open`, rows with `allow: false` are what may not be.
 * The boolean exists for the exception inside either reading: `open` with
 * `example.com` denied and `docs.example.com` allowed.
 */
export interface SourcePolicy {
  id: string;
  workspaceId: string;
  /** Host pattern: `example.com` (matches subdomains) or `docs.example.com`. */
  pattern: string;
  allow: boolean;
  /** Why this row exists, for whoever inherits the list. */
  note: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface ListSourcePoliciesResponse {
  policies: SourcePolicy[];
  /** The access configuration these rows are read under — the list means nothing without it. */
  webAccess: WebAccessSettings;
}

export interface CreateSourcePolicyRequest {
  workspaceId: string;
  pattern: string;
  allow: boolean;
  note?: string | null;
}

export interface UpdateSourcePolicyRequest {
  pattern?: string;
  allow?: boolean;
  note?: string | null;
}

/** Why a URL was refused — the reason a refusal message names. */
export type WebAccessDenial = 'mode-off' | 'not-allowlisted' | 'blocked' | 'unsafe';


export interface CheckSourcePolicyResponse {
  allowed: boolean;
  /** Absent when allowed. */
  reason?: WebAccessDenial;
  /** The host the decision was made about. */
  host: string;
  /** The row that decided it, when a row did. Null means the mode's own default. */
  matchedPattern: string | null;
  effective: WebAccessMode;
}

export type AiProvider = 'none' | 'openai-compatible' | 'deepseek' | 'gen-api';

// GET /v1/ai/settings?workspaceId= — the credential itself is never returned.
export interface AiSettingsResponse {
  workspaceId: string;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  /** A key is configured (from the DB or from env). */
  hasApiKey: boolean;
  /** Last-4 hint of the stored key, when one is stored in the DB. */
  apiKeyHint: string | null;
  temperature: number;
  maxToolCalls: number;
  timeoutMs: number;
  /** Relation-extraction tuning, resolved from the DB override or EXTRACTOR_*. */
  extractionMinConfidence: number;
  extractionMaxChunks: number;
  agentModeEnabled: boolean;
  pricePromptPerMTok: number | null;
  priceCompletionPerMTok: number | null;
  /** Quotas. null = unlimited; only enforced while enforceBudget is true. */
  workspaceMonthlyTokenBudget: number | null;
  defaultUserMonthlyTokenBudget: number | null;
  enforceBudget: boolean;
  sources: AiSettingsSourceMap;
  /** How much of the open web the assistant may reach (docs/features/25). */
  webAccess: WebAccessSettings;
  /** Whether the page AI actions menu may open external AI vendors (issue #68). */
  externalAiActions: ExternalAiActionsSettings;
  /** Agent-session memory: whether coding agents may propose captures, and how many (issue #73). */
  capture: CaptureSettings;
  /** Per-purpose routing into the workspace's provider profiles. */
  routing: AiRouting;
  /** False when SETTINGS_ENCRYPTION_KEY is unset — the UI must disable key entry. */
  canStoreSecrets: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * GET /v1/ai/page-actions?workspaceId= — what a page's AI actions menu may
 * offer (issue #68). Viewer-readable, unlike the admin-only settings: every
 * reader sees the menu, and the menu must not offer what the workspace has
 * switched off.
 */
export interface AiPageActionsResponse {
  /** The effective external-actions switch, already clamped by the env ceiling. */
  externalAiActions: boolean;
  /** Menu entries, in menu order; the external ones are absent when switched off. */
  actions: AiActionId[];
  /** Inline-prompt size before "Open in…" falls back to the clipboard (AI_ACTION_INLINE_MAX_CHARS). */
  inlineMaxChars: number;
}

// ---- Provider profiles & routing -------------------------------------------

export type AiProviderKind = 'openai-compatible' | 'deepseek' | 'gen-api';
export type AiProviderStatus = 'unknown' | 'ok' | 'error';

/**
 * A named provider profile. Several can exist per workspace; each purpose is
 * routed at one of them, and a chat thread may pin its own.
 */
export interface AiProviderSummary {
  id: string;
  workspaceId: string;
  name: string;
  provider: AiProviderKind;
  baseUrl: string | null;
  model: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  temperature: number | null;
  maxToolCalls: number | null;
  timeoutMs: number | null;
  pricePromptPerMTok: number | null;
  priceCompletionPerMTok: number | null;
  enabled: boolean;
  status: AiProviderStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Admin-declared capabilities, overriding the model table. Null = use the table. */
  capabilities: AgentCapability[] | null;
}
// GET /v1/ai/providers?workspaceId=
export interface ListAiProvidersResponse {
  providers: AiProviderSummary[];
}

/**
 * What a provider is being used for. Chat and agent turns, background draft
 * review/suggestion, and the worker's relation extraction are the three jobs
 * a workspace may want on different models.
 */
export type AiPurpose = 'chat' | 'review' | 'extraction';

/** Which profile serves each purpose. null = fall back to the inline config, then env. */
export interface AiRouting {
  chat: string | null;
  review: string | null;
  extraction: string | null;
}

/**
 * The provider choices a member may make for a thread — name and model only,
 * never endpoints or credentials, since this is readable by any viewer.
 */
export interface AiProviderChoice {
  id: string;
  name: string;
  model: string;
}
// GET /v1/ai/providers/choices?workspaceId=
export interface ListAiProviderChoicesResponse {
  /** Empty when the workspace defines no profiles — the picker stays hidden. */
  providers: AiProviderChoice[];
  /** The profile the workspace routes chat at, when there is one. */
  defaultProviderId: string | null;
}

// POST /v1/ai/settings/test
export interface AiConnectionTestResponse {
  ok: boolean;
  model: string;
  latencyMs: number;
  error?: string;
}

// ---- Skills ----------------------------------------------------------------

/**
 * Where a skill's text came from (#70). `manual`: an admin wrote it. `repo`: a
 * guidance file in a connected repository (`AGENTS.md`, `CLAUDE.md`, …),
 * imported disabled — fetched bytes are untrusted until an admin enables them.
 */
export const AI_SKILL_SOURCES = ['manual', 'repo'] as const;
export type AiSkillSource = (typeof AI_SKILL_SOURCES)[number];

/** A skill's instruction budget — the DTO's cap and one turn's whole skill budget. */
export const AI_SKILL_INSTRUCTIONS_MAX = 8_000;

export interface AiSkillSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  instructions: string;
  triggers: string[];
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  source: AiSkillSource;
  /** The repository connector a `repo` skill was imported from; null for `manual`. */
  sourceConnectorId: string | null;
  /** That connector's current name, resolved on read; null once the connector is gone. */
  sourceConnectorName: string | null;
  /** Repo-relative path of the guidance file. */
  sourcePath: string | null;
  /** SHA-256 of the file's content as last seen upstream. */
  sourceSha: string | null;
  /**
   * Upstream text that differs from `instructions` and waits for an admin's
   * Accept. An enabled skill's live text never changes on a sync.
   */
  pendingInstructions: string | null;
  /** When the file disappeared upstream; the skill was disabled then. */
  sourceRemovedAt: string | null;
}
// GET /v1/ai/skills?workspaceId=
export interface ListAiSkillsResponse {
  skills: AiSkillSummary[];
}

// ---- Repo guidance import (#70) ---------------------------------------------

/**
 * The guidance files read from a connected repository, at the repository root
 * and at the connector's `subdir` root. Exact paths, plus one directory of
 * Cursor rule files. One list read by the importer and shown by the UI.
 */
export const GUIDANCE_FILE_PATTERNS = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
  '.cursor/rules/*.mdc',
] as const;

/** A guidance file above this is skipped, not truncated: it is not a rules file. */
export const GUIDANCE_FILE_MAX_BYTES = 65_536;
/** Files one import takes at most — `.cursor/rules/` can hold dozens. */
export const GUIDANCE_MAX_FILES = 20;

const GUIDANCE_EXACT: ReadonlySet<string> = new Set(['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md']);

/**
 * The guidance paths among a repository's files, sorted, at the root and at
 * `subdir`'s root. `.cursor/rules/` is read one level deep only.
 */
export function guidancePaths(paths: Iterable<string>, subdir: string): string[] {
  const roots = [''];
  const sub = subdir.replace(/^\/+|\/+$/g, '');
  if (sub) roots.push(`${sub}/`);
  const found = new Set<string>();
  for (const path of paths) {
    for (const root of roots) {
      if (!path.startsWith(root)) continue;
      const rest = path.slice(root.length);
      const rule = rest.startsWith('.cursor/rules/') ? rest.slice('.cursor/rules/'.length) : null;
      if (GUIDANCE_EXACT.has(rest) || (rule !== null && rule.endsWith('.mdc') && !rule.includes('/'))) found.add(path);
    }
  }
  return [...found].sort();
}

// POST /v1/connectors/:id/guidance/import
export interface RepoGuidanceImportResponse {
  connectorId: string;
  /** Guidance files found, before the size and count caps. */
  found: number;
  created: number;
  /** Disabled skills whose text was replaced with the new upstream text. */
  updated: number;
  /** Enabled skills whose new upstream text now waits in `pendingInstructions`. */
  pending: number;
  /** Skills disabled because their file is gone upstream. */
  removed: number;
  unchanged: number;
  /** Files read but cut to `AI_SKILL_INSTRUCTIONS_MAX` characters. */
  truncated: string[];
  skipped: Array<{ path: string; reason: 'oversize' | 'empty' | 'limit' }>;
}

// ---- Plugins (MCP servers) -------------------------------------------------

export type AiPluginTransport = 'streamable-http' | 'sse';
export type AiPluginStatus = 'unknown' | 'connected' | 'error';

/** One tool discovered from an MCP server's listTools(). */
export interface AiPluginTool {
  name: string;
  description: string;
  /** The server's own JSON Schema for the tool's arguments, passed to the model verbatim. */
  inputSchema?: Record<string, unknown>;
}

export interface AiPluginSummary {
  id: string;
  workspaceId: string;
  name: string;
  transport: AiPluginTransport;
  url: string;
  authHeader: string | null;
  /** A credential is stored for this plugin (the value itself is never returned). */
  hasAuthValue: boolean;
  enabled: boolean;
  /** Tools offered to the model. Empty = every discovered tool. */
  enabledTools: string[];
  discoveredTools: AiPluginTool[];
  status: AiPluginStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
// GET /v1/ai/plugins?workspaceId=
export interface ListAiPluginsResponse {
  plugins: AiPluginSummary[];
}
// POST /v1/ai/plugins/:id/test
export interface AiPluginTestResponse {
  ok: boolean;
  tools: AiPluginTool[];
  error?: string;
}

// ---- Usage & budgets -------------------------------------------------------

export type AiUsageOperation =
  | 'ask'
  | 'chat'
  | 'chat-stream'
  | 'review'
  | 'suggest'
  | 'glossary'
  | 'import'
  | 'workflow'
  /** The router's classifier call (docs/features/20). */
  | 'route'
  /** A background agent run (docs/features/20). */
  | 'agent'
  /** Cleaning up or merging a staged connector item (docs/features/26). */
  | 'connector'
  /**
   * Deriving a documentation page from source code (docs/features/27). One row
   * per unit, so a repository's first sync is visible as the spend it is — and
   * a re-sync of an unchanged module is visible as the absence of one.
   */
  | 'codebase'
  /**
   * The repo wiki's own model calls (docs/features/46): a flow's sequence
   * diagram, drafted as JSON, and a section read with the code tools at effort
   * `high`. Separate from `codebase` so the extra spend the wiki adds over the
   * one narration per page is visible as its own line.
   */
  | 'wiki'
  /** A release page's summary and its "possibly breaking" suspicions (docs/features/46). */
  | 'changelog'
  /** Drafting a page from a chat conversation somebody saved (issue #71). */
  | 'chat-capture'
  /**
   * Inferring graph relations from a chunk during ingestion. One row per chunk
   * call, so a reindex of a large corpus is visible as the spend it is.
   */
  | 'extraction'
  /**
   * A question to a published site's Ask (issue #77 phase 3). No person asked
   * it as a member: the row's `userId` is the site's id, and usage labels it
   * by the site's slug.
   */
  | 'public_ask';

/** One row of the per-user (or per-model) usage breakdown. */
export interface AiUsageBucket {
  /** userId, model name, or ISO date — depending on `groupBy`. */
  key: string;
  /** Display label resolved server-side (an email for a user bucket). */
  label: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsdMicros: number | null;
  errors: number;
}

/** A day on the usage sparkline. */
export interface AiUsageSeriesPoint {
  date: string;
  totalTokens: number;
  calls: number;
  costUsdMicros: number | null;
}

// GET /v1/ai/usage?workspaceId=&from=&to=&groupBy=user|model|day
export interface AiUsageResponse {
  from: string;
  to: string;
  groupBy: 'user' | 'model' | 'day';
  totals: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsdMicros: number | null;
    /** Calls with no known price — the cost total excludes them, so the UI can say so. */
    unpricedCalls: number;
    errors: number;
  };
  buckets: AiUsageBucket[];
  series: AiUsageSeriesPoint[];
}

/** One upstream LLM call, as shown in the Logs tab. */
export interface AiUsageLogEntry {
  id: string;
  userId: string;
  userLabel: string;
  operation: AiUsageOperation;
  provider: string;
  model: string;
  /** The named profile that served the call, when one did. */
  providerId: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
  costUsdMicros: number | null;
  durationMs: number;
  ok: boolean;
  errorCode: string | null;
  error: string | null;
  threadId: string | null;
  toolCallCount: number;
  createdAt: string;
}
// GET /v1/ai/usage/logs?workspaceId=&cursor=&userId=&operation=&ok=
export interface ListAiUsageLogsResponse {
  entries: AiUsageLogEntry[];
  nextCursor: string | null;
}

/** Budget state for one principal — drives both the admin table and the chat chip. */
export interface AiBudgetInfo {
  userId: string;
  /** null = unlimited. */
  monthlyTokenBudget: number | null;
  /** True when this user has an explicit ai_user_budgets row. */
  overridden: boolean;
  usedTokens: number;
  remainingTokens: number | null;
  enforced: boolean;
  /** Start of the current accounting month (UTC), ISO. */
  periodStart: string;
}
// GET /v1/ai/usage/me?workspaceId=
export interface AiMyUsageResponse {
  budget: AiBudgetInfo;
  calls: number;
  totalTokens: number;
  costUsdMicros: number | null;
}
// GET /v1/ai/budgets?workspaceId=
export interface ListAiBudgetsResponse {
  workspace: {
    monthlyTokenBudget: number | null;
    usedTokens: number;
    remainingTokens: number | null;
    enforced: boolean;
    periodStart: string;
  };
  users: AiBudgetInfo[];
}


// ---------------------------------------------------------------------------
// Agents (docs/features/20): named, configurable actors. An agent is the tuple
// this codebase already wrote three times anonymously — instructions + tool
// allowlist + model + output contract — given a name, so it can be reused,
// edited by an admin, and pointed at a provider profile of its own.
// ---------------------------------------------------------------------------

/**
 * Built-in agent keys. Closed set: each maps to a code default in the API's
 * built-in registry, and an `ai_agents` row is a *sparse override* of one —
 * null columns inherit the code default. That is what makes "reset to default"
 * meaningful, and what lets a release improve a shipped prompt for every
 * workspace that never touched it.
 */
export const BUILT_IN_AGENT_KEYS = [
  'router',
  'researcher',
  'author',
  'reviewer',
  'drafter',
  'planner',
  'extractor',
  'glossarist',
  'transcriber',
  'curator',
  /** Designs a workflow definition from a description (docs/features/17). */
  'architect',
  /** Proposes the relations a page should declare (docs/features/28). */
  'cartographer',
  /** Reverse-documents a connected repository's undeclared business logic (docs/features/31). */
  'archaeologist',
  /** Checks the pages a pull or merge request may have made wrong (docs/features/35). */
  'sentinel',
  /** Clusters the questions answers failed on into coverage gaps (docs/features/38, phase 4). */
  'surveyor',
  /** Summarises what changed in the workspace since its last digest (#70). */
  'digest',
] as const;
export type BuiltInAgentKey = (typeof BUILT_IN_AGENT_KEYS)[number];

/**
 * Agents whose run is scoped to one repository connector (docs/features/31).
 *
 * One predicate for the API, which refuses to start such a run without a
 * connector it can resolve, and for the web, which asks for one before
 * pressing Run. A declaration is not a fact: if the two read different lists,
 * the Run button and the 400 it gets back disagree about what is runnable.
 */
export const CONNECTOR_SCOPED_AGENT_KEYS = ['archaeologist'] as const;
export function isConnectorScopedAgent(key: string): boolean {
  return (CONNECTOR_SCOPED_AGENT_KEYS as readonly string[]).includes(key);
}

/**
 * What a run was asked to do — `agent_runs.input`. `note` seeds an extra
 * instruction; `connectorId` scopes a connector-scoped agent to one repository;
 * `pullRequest` names the change a sentinel run checks (docs/features/35);
 * `issueId` the report it judges (docs/features/38).
 */
export interface AgentRunInput {
  note?: string;
  connectorId?: string;
  /**
   * Restrict a page-reading run (curator, reviewer, glossarist) to these pages
   * instead of the workspace's most recent ones (#70). Still read under the
   * run's scope: a page the owner cannot open is dropped, never read. At most
   * {@link AGENT_RUN_MAX_DOCUMENTS}.
   */
  documentIds?: string[];
  pullRequest?: AgentRunPullRequest;
  /**
   * The knowledge issue a sentinel run judges (docs/features/38, phase 3). A
   * run carries either this or `pullRequest`, never both: one is a report to
   * check against the page, the other a change to check the page against.
   */
  issueId?: string;
  /**
   * How far back a surveyor run reads answer feedback (docs/features/38,
   * phase 4). Absent, the worker uses `COVERAGE_WINDOW_DAYS`.
   */
  coverage?: { windowDays: number };
  /**
   * Set once the API has acted on a finished sentinel run — proposals opened,
   * the pull request commented on. The claim that stops two sweeps doing it
   * twice; never set by anything else.
   */
  publishedAt?: string;
  /**
   * When the pull request a sentinel run checked was merged (docs/features/35,
   * issue #66 phase 4). Stamped by `DriftTriggerService` on a merged delivery,
   * which starts no check: it is what turns the pages the run flagged
   * `requested` into `outdated`.
   */
  mergedAt?: string;
  /** The sweeper's claim that it acted on `mergedAt`, once. Never set by anything else. */
  outdatedAt?: string;
  /**
   * What started an `'event'` run (#70): the trigger event, the bus type it was
   * heard on, and that event's subject. `revisionId` is set for `page.indexed`
   * and is what keeps a re-index of one revision from firing twice.
   */
  event?: AgentRunEvent;
  /**
   * The body of the webhook delivery that started the run (#70), cut to
   * {@link AGENT_WEBHOOK_PAYLOAD_MAX_CHARS}. Written by whoever holds the
   * trigger's secret and relaying text anyone may have typed, so an executor
   * only ever shows it to a model inside `wrapUntrusted`.
   */
  payload?: string;
}

export interface AgentRunEvent {
  type: AgentTriggerEvent;
  source: string;
  subjectId?: string;
  documentId?: string;
  revisionId?: string;
  /**
   * `X-Knowledge-Delivery` of a `webhook` run: one delivery starts one run
   * however often the sender retries it.
   */
  deliveryId?: string;
  /** The discussion a `comment.mention` run answers into. */
  threadId?: string;
}

/** How much of a webhook body a run keeps — and a prompt therefore sees. */
export const AGENT_WEBHOOK_PAYLOAD_MAX_CHARS = 8_000;

/**
 * The headers a signed delivery to an agent trigger carries (#70).
 *
 * `signature` is `sha256=` + hex HMAC-SHA256, under the trigger's secret, of
 * `<timestamp>.<raw body>` — the timestamp is signed so a captured delivery
 * cannot be replayed under a fresh header. `timestamp` is Unix seconds and must
 * be within `AGENT_WEBHOOK_TOLERANCE_SECONDS` of the server's clock. `delivery`
 * is the sender's id for this delivery: a retry with the same id starts nothing.
 */
export const AGENT_WEBHOOK_HEADERS = {
  signature: 'x-knowledge-signature',
  timestamp: 'x-knowledge-timestamp',
  delivery: 'x-knowledge-delivery',
} as const;

/**
 * The most pages one page-scoped run may name. Each executor still reads no
 * more than its own per-run cap, so this bounds the input, not the cost.
 */
export const AGENT_RUN_MAX_DOCUMENTS = 20;

/** The agents whose executors honour {@link AgentRunInput.documentIds}. */
export const PAGE_SCOPED_AGENT_KEYS = ['curator', 'reviewer', 'glossarist'] as const;

export function isPageScopedAgent(key: string): boolean {
  return (PAGE_SCOPED_AGENT_KEYS as readonly string[]).includes(key);
}

/**
 * The pull request (GitHub) or merge request (GitLab) a sentinel run checks.
 *
 * `number` is the host's per-repository number — GitHub's `number`, GitLab's
 * `iid` — because that is what every API call and every URL is keyed on.
 * `headSha` is what makes a run specific: a push to the branch is a new head
 * and a new check, a redelivery of the same head is the same one.
 */
export interface AgentRunPullRequest {
  number: number;
  title: string;
  url: string;
  headSha: string;
  headRef: string | null;
  baseRef: string | null;
  author: string | null;
}

/**
 * Where an agent may run. The surface caps its tools: `background` has nobody
 * to answer an `ask_user` form, and per feature 17 may not write to the page
 * tree — the worker generates, the API publishes.
 */
export const AGENT_SURFACES = ['interactive', 'background', 'workflow'] as const;
export type AgentSurface = (typeof AGENT_SURFACES)[number];

/**
 * What a model must support for an agent to run on it. The router filters
 * provider profiles by these before anything else, so a vision agent can never
 * be routed at a blind model — a confident transcription of an image the model
 * cannot see is worse than a refusal.
 */
export const AGENT_CAPABILITIES = ['tools', 'vision', 'json'] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/**
 * Longest message a person may send the assistant in one turn.
 *
 * Lives here for the reason ASSISTANT_WRITE_TOOL_NAMES does: the server
 * validates against it and the composer counts against it, and when those were
 * two numbers the cap was only discoverable by pressing send and being refused.
 *
 * 4_000 was the old server-side value, which is under two pages — too small for
 * the thing people actually do, which is paste a spec and ask about it. At
 * 32_000 the worst-case prompt is roughly this plus the grounding page (30k)
 * plus three attachments (20k each), which still sits comfortably inside a
 * 128k-token context; anything larger belongs on the attachment path.
 */
export const ASSISTANT_MESSAGE_MAX_CHARS = 32_000;



/**
 * The built-in tool vocabulary an agent's allowlist is validated against.
 * Lives here rather than being derived from AssistantToolsService so the API
 * can validate a write and the settings form can render the picker from the
 * same list — an agent may additionally be given `mcp__<slug>__<tool>` names
 * from the workspace's enabled plugins, which are discovered at runtime.
 */
export const ASSISTANT_TOOL_NAMES = [
  'search_knowledge',
  'read_document',
  'explore_document_graph',
  /** What a page declares in frontmatter, beside what the graph holds (docs/features/28). */
  'list_relations',
  /** Browse the page tree, so placement is a decision (docs/features/08). */
  'list_document_tree',
  /** The page templates on offer, and one template's skeleton (issue #69). */
  'list_templates',
  'get_template',
  'ask_user',
  'request_agent_mode',
  'render_component',
  'create_document',
  'propose_update',
  /** Edits the page's frontmatter relations, as a merge request (docs/features/28). */
  'edit_relations',
  /**
   * Suggests an edit to the draft open in the author's editor (docs/features/34).
   * Offered only on a turn that carries a draft, and not a write: nothing is
   * stored until the author accepts it and publishes, which is why it is
   * available in Ask mode too.
   */
  'edit_draft',
  /** Read a connected repository (docs/features/31). Opt-in, like the web pair. */
  'code_tree',
  'code_read',
  'code_search',
  'code_outline',
  /** Issues and pull requests on a connected repository (docs/features/32). */
  'task_list',
  'task_read',
  'task_create',
  'task_comment',
] as const;

/**
 * The tools that read a connected repository (docs/features/31).
 *
 * One list for the same reason the write set is one list: the harness filters
 * on it, the built-in agents compose their allowlists from it, and the settings
 * picker renders it. Reads only — nothing here can change a repository or a
 * page, which is what lets the harness run them in parallel.
 */
export const ASSISTANT_CODE_TOOL_NAMES = [
  'code_tree',
  'code_read',
  'code_search',
  'code_outline',
] as const;

/**
 * The tools that reach the work on a connected repository (docs/features/32).
 *
 * One list for the reason the code set is one list: the harness filters on it,
 * the built-in agents compose their allowlists from it, and the settings picker
 * renders it.
 *
 * Unlike the code set this one is **not** reads-only, which is why it is not in
 * `PARALLEL_SAFE_TOOLS`. `task_create` and `task_comment` are also in
 * `ASSISTANT_WRITE_TOOL_NAMES`, and they are the only writes in this product
 * whose effect lands **outside** the workspace: a page can be reverted, a
 * comment on somebody's issue cannot. So they are offered in Agent mode only,
 * and the `editor` check runs on execution rather than on offer.
 */
export const ASSISTANT_TASK_TOOL_NAMES = ['task_list', 'task_read', 'task_create', 'task_comment'] as const;

/** The half of the task tools that only reads. Parallel-safe; offered in Ask mode. */
export const ASSISTANT_TASK_READ_TOOL_NAMES = ['task_list', 'task_read'] as const;

/**
 * The tools that change the workspace.
 *
 * One list, because there were three: `assistant.tools.ts` filters and
 * role-checks on it, `built-in-agents.ts` composes the author's allowlist from
 * it, and `assistant.service.ts` decides from it whether an agent may hold a
 * turn in Ask mode. Allowlists intersect rather than union, so a name missing
 * from one copy did not raise an error — it silently removed the tool. Three
 * hand-maintained copies of one set is a drift waiting to happen.
 */
export const ASSISTANT_WRITE_TOOL_NAMES = [
  'create_document',
  'propose_update',
  'edit_relations',
  /**
   * These two leave the workspace (docs/features/32). Grouped with the page
   * writes because the gate is the same — `editor`, checked on execution, and
   * absent from Ask mode — but they are the stronger case for that gate, not
   * the weaker one: an issue opened on somebody's repository is not ours to
   * undo.
   */
  'task_create',
  'task_comment',
] as const;

/** Effective configuration of one agent: the code default ⊕ this workspace's override row. */
export interface AiAgentSummary {
  /** Null until the workspace has actually overridden something. */
  id: string | null;
  key: string;
  builtIn: boolean;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  skillIds: string[];
  /** Provider profile pinned to this agent; null falls through to the purpose route. */
  providerId: string | null;
  providerName: string | null;
  temperature: number;
  maxToolCalls: number;
  timeoutMs: number;
  surfaces: AgentSurface[];
  /**
   * A `background` surface says an agent *may* run unattended; this says one
   * actually can — a background executor exists for it. The two differ while
   * the executor catalogue is smaller than the surface declaration, and the UI
   * must follow this one, or it offers a Run button the API refuses.
   */
  runnable: boolean;
  requires: AgentCapability[];
  /**
   * Required capabilities the routed model does not offer. Non-empty means this
   * agent will refuse to run — surfaced so an admin sees the misconfiguration
   * in the roster rather than in a failed job.
   */
  missing: AgentCapability[];
  purpose: AiPurpose;
  enabled: boolean;
  /** Field names this workspace has overridden — drives the "from default" badges. */
  overridden: string[];
  /** Background schedule. Off unless an admin turned it on and named an owner. */
  scheduleEnabled: boolean;
  /** Never null on the wire: a row with no kind stored is an interval schedule. */
  scheduleKind: AgentScheduleKind;
  scheduleMinutes: number | null;
  /** `HH:MM`, 24-hour, in `scheduleTimezone`. Daily and weekly schedules only. */
  scheduleTime: string | null;
  /** 0 = Sunday … 6 = Saturday. Weekly schedules only. */
  scheduleWeekdays: number[] | null;
  /** IANA zone; null reads as UTC. */
  scheduleTimezone: string | null;
  scheduleNote: string | null;
  scheduleOwner: string | null;
  lastRunAt: string | null;
  /**
   * When the sweeper will next start this agent, from {@link nextScheduledRun}.
   * Null while the schedule is off or incomplete. A time at or before now
   * means "on the next tick", which is up to five minutes away.
   */
  nextRunAt: string | null;
  updatedAt: string | null;
}

/**
 * How an agent's background schedule is expressed (#70).
 *
 * `interval` is the original shape — every N minutes since the last run.
 * `daily` and `weekly` fire at a wall-clock time in a timezone; `weekly` on the
 * named weekdays only, which is also how "weekdays at 09:00" is spelled.
 *
 * There are no cron expressions on purpose: the sweeper is a due check inside
 * a fixed five-minute tick (CLAUDE.md: no cron in this repo), so a schedule
 * cannot be more precise than that tick, and a syntax that promises minute
 * precision would lie about it.
 */
export const AGENT_SCHEDULE_KINDS = ['interval', 'daily', 'weekly'] as const;
export type AgentScheduleKind = (typeof AGENT_SCHEDULE_KINDS)[number];

/** `HH:MM`, 00:00–23:59. The DTO, the database CHECK and the predicate agree on it. */
export const AGENT_SCHEDULE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The sweeper's tick. A schedule fires on the first tick at or after its slot. */
export const AGENT_SCHEDULE_TICK_MINUTES = 5;

/** What {@link nextScheduledRun} needs to know about a schedule. */
export interface AgentScheduleSpec {
  /** Null reads as `interval`, which is what every row written before #70 is. */
  kind: AgentScheduleKind | null;
  minutes: number | null;
  time: string | null;
  weekdays: readonly number[] | null;
  timezone: string | null;
}

/** What has happened to a schedule: its last run, and its last edit. */
export interface AgentScheduleState {
  lastRunAt: Date | null;
  /**
   * When the schedule's shape last changed. A daily or weekly schedule counts
   * slots from the later of this and `lastRunAt`, so moving 09:00 to 08:00 at
   * ten o'clock does not fire "the missed 08:00 slot" the moment it is saved.
   * An interval schedule ignores it, which keeps the pre-#70 rows exact.
   */
  changedAt: Date | null;
}

/**
 * When a schedule next fires — the one predicate the sweeper, the summary's
 * `nextRunAt` and the editor's preview all read (CLAUDE.md: a guard, a sweeper
 * and the UI must not disagree about what is runnable).
 *
 * A daily or weekly schedule returns the first slot after it last ran (or was
 * changed). A worker that was down across several slots therefore sees one
 * slot in the past, fires once, and moves past all of them: a missed slot
 * fires once, never once per slot missed.
 *
 * Null when the schedule cannot fire: an interval with no minutes, a time-of-day
 * schedule with no time, or a weekly one with no weekdays.
 */
export function nextScheduledRun(spec: AgentScheduleSpec, state: AgentScheduleState, now: Date): Date | null {
  const kind = spec.kind ?? 'interval';
  if (kind === 'interval') {
    if (!spec.minutes || spec.minutes <= 0) return null;
    // Exactly the pre-#70 rule: never run means due now.
    return state.lastRunAt ? new Date(state.lastRunAt.getTime() + spec.minutes * 60_000) : now;
  }

  const time = spec.time ? AGENT_SCHEDULE_TIME_PATTERN.exec(spec.time) : null;
  if (!time) return null;
  const [hour, minute] = spec.time!.split(':').map(Number);
  const days = kind === 'weekly' ? new Set(spec.weekdays ?? []) : null;
  if (days && days.size === 0) return null;
  const zone = scheduleZone(spec.timezone);

  const anchor = latest(state.lastRunAt, state.changedAt);
  if (!anchor) {
    // Never run and never stamped (a row written by hand): the most recent
    // slot is owed, else the next one.
    return slotNear(now, zone, hour, minute, days, 'at-or-before') ?? slotNear(now, zone, hour, minute, days, 'after');
  }
  return slotNear(anchor, zone, hour, minute, days, 'after');
}

/** `nextScheduledRun(...) <= now` — the sweeper's question. */
export function isScheduleDue(spec: AgentScheduleSpec, state: AgentScheduleState, now: Date): boolean {
  const next = nextScheduledRun(spec, state, now);
  return next !== null && next.getTime() <= now.getTime();
}

/** True when `zone` is an IANA name this runtime knows. */
export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * An unknown zone reads as UTC rather than throwing: the DTO refuses one on
 * write, and a runtime whose zone database lost a name must not stop every
 * other schedule in the sweep.
 */
function scheduleZone(zone: string | null): string {
  return zone && isValidTimezone(zone) ? zone : 'UTC';
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock fields of `at` in `zone`. */
function wallClock(at: Date, zone: string) {
  let format = zoneFormatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    zoneFormatters.set(zone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** `zone`'s offset from UTC at `at`, in milliseconds. */
function zoneOffset(at: number, zone: string): number {
  const w = wallClock(new Date(at), zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(at / 1000) * 1000;
}

/**
 * The instant that reads `hour:minute` on the calendar day (y, m, d) in `zone`.
 * Two passes settle a DST boundary. A wall time the spring-forward gap skips
 * has no instant, and lands on the later candidate (02:30 → 03:30), so that
 * day's slot still fires once; a repeated fall-back hour takes its first
 * occurrence.
 */
function zonedInstant(y: number, m: number, d: number, hour: number, minute: number, zone: string): Date {
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const first = guess - zoneOffset(guess, zone);
  const second = guess - zoneOffset(first, zone);
  const reads = (at: number) => {
    const w = wallClock(new Date(at), zone);
    return w.hour === hour && w.minute === minute;
  };
  if (reads(second)) return new Date(second);
  if (reads(first)) return new Date(first);
  return new Date(Math.max(first, second));
}

/**
 * The nearest slot to `ref`: the first one strictly after it, or the last one
 * at or before it. Scans nine calendar days, which covers a weekly schedule
 * with a single weekday on either side of a DST change.
 */
function slotNear(
  ref: Date,
  zone: string,
  hour: number,
  minute: number,
  days: Set<number> | null,
  direction: 'after' | 'at-or-before',
): Date | null {
  const local = wallClock(ref, zone);
  // Forward from the day before (an offset can put `ref`'s local day one off
  // the slot's), or backward from the day after.
  const step = direction === 'after' ? 1 : -1;
  for (let offset = -step; Math.abs(offset) <= 9; offset += step) {
    // Day arithmetic on a UTC date carries month and year boundaries for free.
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
    if (days && !days.has(day.getUTCDay())) continue;
    const slot = zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, zone);
    if (direction === 'after' ? slot.getTime() > ref.getTime() : slot.getTime() <= ref.getTime()) return slot;
  }
  return null;
}

// GET /v1/ai/agents?workspaceId=
export interface ListAiAgentsResponse {
  agents: AiAgentSummary[];
}

/** Background agent runs (docs/features/20). */
export const AGENT_RUN_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/**
 * How a run was started. Deliberately only what the code emits — a closed
 * vocabulary that promises a value nothing produces is the defect this feature
 * was written against (`WorkflowStep.tools`, declared and ignored).
 *
 * `'event'` is emitted by exactly one service, `AgentTriggerService` (#70),
 * which carries WorkflowTriggerService's guards: it came back together with
 * them, as docs/features/20-agents-todo.md said it must.
 *
 * `'webhook'` is not that `'event'`: it is emitted by exactly one service,
 * `DriftTriggerService`, for exactly one agent, and never from the event bus —
 * so none of the re-trigger guards a bus-driven run would need apply to it.
 */
export const AGENT_RUN_TRIGGERS = [
  'manual',
  'schedule',
  /** A bus event matched one of the agent's triggers (#70). */
  'event',
  /** A pull or merge request webhook started a sentinel run (docs/features/35). */
  'webhook',
  /**
   * A knowledge issue started a sentinel run (docs/features/38, phase 3).
   * Emitted by exactly one service, `KnowledgeIssuesService`, the way
   * `'webhook'` is by `DriftTriggerService`.
   */
  'report',
] as const;
export type AgentRunTrigger = (typeof AGENT_RUN_TRIGGERS)[number];

/**
 * What an agent trigger listens for (#70) — the product's names, not the bus's.
 *
 * `webhook` and `comment.mention` are not heard on the bus at all: a signed
 * delivery fires its trigger inline in `AgentWebhookController`, and a mention
 * in `MentionRepliesService` while the comment is being posted — each knows
 * exactly which trigger it is for, and the mention needs the commenter, whom
 * no bus event carries.
 */
export const AGENT_TRIGGER_EVENTS = [
  'page.merged',
  'page.indexed',
  'merge-request.opened',
  'connector.synced',
  'webhook',
  'comment.mention',
] as const;
export type AgentTriggerEvent = (typeof AGENT_TRIGGER_EVENTS)[number];

/**
 * The bus types each trigger event is heard on. One constant read by the DTO,
 * the listener and the editor's picker, so the three cannot disagree about
 * what "a merge request was opened" means.
 *
 * `page.indexed` rather than `document.updated`: the latter fires on every
 * autosave of a draft, the former once per revision that reached the index.
 */
export const AGENT_TRIGGER_EVENT_SOURCES: Record<AgentTriggerEvent, readonly string[]> = {
  'page.merged': ['merge-request.merged'],
  'page.indexed': ['revision.indexed'],
  'merge-request.opened': ['merge-request.created', 'repo.pull-request.opened'],
  'connector.synced': ['connector.run.succeeded'],
  // Fired inline, never from the bus — see AGENT_TRIGGER_EVENTS.
  webhook: [],
  'comment.mention': [],
};

/** The trigger event a bus type is heard as, or null for one no trigger listens to. */
export function agentTriggerEventFor(busType: string): AgentTriggerEvent | null {
  for (const event of AGENT_TRIGGER_EVENTS) {
    if (AGENT_TRIGGER_EVENT_SOURCES[event].includes(busType)) return event;
  }
  return null;
}

/**
 * Narrows which events of a kind start a run. Every field is optional and an
 * absent one matches everything — the sparse-override rule.
 *
 * `branch` applies to page events: the merge request's target branch for
 * `page.merged` and `merge-request.opened`, the indexed revision's branch for
 * `page.indexed`. Absent, `page.indexed` hears only a page's default branch —
 * a draft branch being edited is not "the page changed".
 */
export interface AgentTriggerFilter {
  categories?: string[];
  connectorIds?: string[];
  branch?: string;
}

/**
 * Which filter fields mean something for which event — read by the editor
 * (which fields to show) and the API (which to keep). A field the event has no
 * dimension for would never match, so it is dropped rather than stored as a
 * trigger that silently never fires.
 */
export const AGENT_TRIGGER_FILTER_FIELDS: Record<AgentTriggerEvent, readonly (keyof AgentTriggerFilter)[]> = {
  'page.merged': ['categories', 'branch'],
  'page.indexed': ['categories', 'branch'],
  'merge-request.opened': ['categories', 'connectorIds', 'branch'],
  'connector.synced': ['connectorIds'],
  webhook: [],
  'comment.mention': ['categories'],
};

/**
 * The events an agent can be triggered by. A connector-scoped agent reads one
 * repository, so only an event that can name one — a pull request, a sync — is
 * offered to it; any other would skip on every delivery. A mention starts a
 * run about the page under discussion, so only an agent that can be scoped to
 * one page answers it.
 */
export function agentTriggerEventsFor(agentKey: string): readonly AgentTriggerEvent[] {
  if (isConnectorScopedAgent(agentKey)) return ['merge-request.opened', 'connector.synced'];
  return isPageScopedAgent(agentKey) ? AGENT_TRIGGER_EVENTS : AGENT_TRIGGER_EVENTS.filter((e) => e !== 'comment.mention');
}

/** Bounds of `agent_triggers.cooldown_minutes`; 0 turns the cooldown off. */
export const AGENT_TRIGGER_COOLDOWN_MAX_MINUTES = 10_080;

export interface AgentTriggerSummary {
  id: string;
  workspaceId: string;
  /** Null hears every project in the workspace. */
  projectId: string | null;
  agentKey: string;
  event: AgentTriggerEvent;
  filter: AgentTriggerFilter;
  /** Off on creation: nothing fires until an admin turns it on. */
  enabled: boolean;
  /**
   * Who the runs execute and bill as — the admin who last enabled it. A
   * trigger without one starts nothing.
   */
  ownerId: string | null;
  /** Minutes before the same subject may start this trigger again. */
  cooldownMinutes: number;
  /** Seeded into each run's `input.note`. */
  note: string | null;
  /**
   * Where a `webhook` trigger is delivered to, and whether it has a secret yet
   * — it refuses every delivery until one is set. Null for any other event.
   * The secret itself is never read back; rotating is the only way to see one.
   */
  webhook: { url: string; secretSet: boolean } | null;
  lastFiredAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// POST /v1/ai/agents/triggers/:id/rotate-secret
export interface RotateAgentTriggerSecretResponse {
  /** Shown once. The previous secret stops verifying at once. */
  secret: string;
  url: string;
}

// GET /v1/ai/agents/triggers?workspaceId=
export interface ListAgentTriggersResponse {
  triggers: AgentTriggerSummary[];
  /**
   * Whether this server listens at all (`AGENT_TRIGGERS_ENABLED`). An enabled
   * trigger on a server that does not listen fires nothing, and the editor
   * says so rather than letting the toggle claim otherwise.
   */
  listening: boolean;
}

/**
 * Recipes (#70): a ready-made configuration of an agent that already exists —
 * a schedule, a trigger, or both — applied in one press.
 *
 * A recipe writes the same rows an admin would write by hand, through the same
 * services, so nothing downstream knows a recipe was involved: the sweeper and
 * the trigger listener read the schedule and the trigger, never this list.
 * Everything a recipe writes starts **disabled**. Turning it on is a separate,
 * deliberate act, and whoever does it becomes the owner its runs execute and
 * bill as — the rule every schedule and trigger already follows.
 *
 * Applying is idempotent: a schedule the agent already has, or a trigger it
 * already has for the event, is kept as it is, never overwritten.
 */
export const AGENT_RECIPE_KEYS = ['weekly-digest', 'freshness-sweep', 'glossary-suggester'] as const;
export type AgentRecipeKey = (typeof AGENT_RECIPE_KEYS)[number];

export interface AgentRecipe {
  key: AgentRecipeKey;
  agentKey: BuiltInAgentKey;
  /** A time-of-day schedule, in the timezone the person applying it sends (UTC without one). */
  schedule?: { kind: Exclude<AgentScheduleKind, 'interval'>; time: string; weekdays?: number[] };
  trigger?: { event: AgentTriggerEvent };
}

export const AGENT_RECIPES: Record<AgentRecipeKey, AgentRecipe> = {
  /** The digest agent, Mondays at 09:00 — a week of changes in one page-shaped summary. */
  'weekly-digest': { key: 'weekly-digest', agentKey: 'digest', schedule: { kind: 'weekly', time: '09:00', weekdays: [1] } },
  /**
   * The curator, told to look for staleness: weekly, and after every connector
   * sync, which is when imported pages most often fall behind their source.
   */
  'freshness-sweep': {
    key: 'freshness-sweep',
    agentKey: 'curator',
    schedule: { kind: 'weekly', time: '08:00', weekdays: [1] },
    trigger: { event: 'connector.synced' },
  },
  /** The glossarist on every merge, scoped to the merged page. */
  'glossary-suggester': { key: 'glossary-suggester', agentKey: 'glossarist', trigger: { event: 'page.merged' } },
};

// POST /v1/ai/agents/recipes/:recipe/apply
export interface ApplyAgentRecipeResponse {
  recipe: AgentRecipeKey;
  agent: AiAgentSummary;
  /** Every trigger the recipe asks for, whether this press created it or found it. */
  triggers: AgentTriggerSummary[];
  /** What this press wrote. A re-apply writes nothing that is already there. */
  created: { schedule: boolean; triggers: number };
}

/**
 * Learnings (#70): a correction a person taught an agent, kept and handed to
 * that agent's later turns as "team guidance".
 *
 * Only `active` text ever reaches a prompt, and only an admin makes a learning
 * active — the text is trusted because a person approved it, the rule skills
 * already follow. `proposed` is what anyone with edit rights (or an MCP client)
 * may write; `archived` keeps the provenance of a learning nobody wants applied.
 */
export const AGENT_LEARNING_STATUSES = ['proposed', 'active', 'archived'] as const;
export type AgentLearningStatus = (typeof AGENT_LEARNING_STATUSES)[number];

/** Where a learning came from — what its provenance link points at. */
export const AGENT_LEARNING_SOURCES = ['document-thread', 'mr-thread', 'finding', 'manual'] as const;
export type AgentLearningSource = (typeof AGENT_LEARNING_SOURCES)[number];

/** Longest learning a person may write. A learning is a rule, not a page. */
export const AGENT_LEARNING_MAX_CHARS = 1_000;

export interface AgentLearningSummary {
  id: string;
  workspaceId: string;
  /** Null applies in every project. */
  projectId: string | null;
  /** Null applies to every agent. */
  agentKey: string | null;
  text: string;
  status: AgentLearningStatus;
  sourceKind: AgentLearningSource;
  /** A thread id for a thread source; null otherwise. */
  sourceId: string | null;
  /** The page a `document-thread` source sits on, or a `finding` source cites. */
  sourceDocumentId: string | null;
  /** The merge request an `mr-thread` source sits on. */
  sourceMergeRequestId: string | null;
  /** The run and finding a `finding` source was dismissed from. */
  runId: string | null;
  findingIndex: number | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// GET /v1/ai/agents/learnings?workspaceId=&agentKey=&status=
export interface ListAgentLearningsResponse {
  learnings: AgentLearningSummary[];
  /** How many `active` learnings a prompt takes at most (`AGENT_LEARNINGS_MAX`). Newest first. */
  promptLimit: number;
}

// POST /v1/ai/agents/runs/:id/findings/:index/dismiss
export interface DismissAgentFindingResponse {
  dismissedAt: string;
  dismissedBy: string;
  /** The proposed learning "Remember why" wrote — the first press's, on a repeat. */
  learningId: string | null;
  /** False when somebody had already dismissed it; nothing was written. */
  dismissed: boolean;
}

export const AGENT_FINDING_KINDS = [
  'stale',
  'duplicate',
  'contradiction',
  'orphan',
  'gap',
  /** A relation the page should declare but does not (docs/features/28). */
  'relation',
  'other',
] as const;
export type AgentFindingKind = (typeof AGENT_FINDING_KINDS)[number];

/**
 * One thing an agent noticed. Never a change — a proposal a person acts on.
 *
 * `documentIds` is not decoration: plan.md §12.7 requires source-backed
 * citations and never a bare LLM answer, so a finding that cites nothing is
 * dropped by the executor rather than shown.
 */
export interface AgentFinding {
  kind: AgentFindingKind;
  severity: 'info' | 'warning' | 'error';
  title: string;
  detail: string;
  documentIds: string[];
  documentTitles: string[];
  /**
   * The merge request this finding was turned into, once somebody proposed a
   * fix for it. A finding is still only ever a proposal — this records that a
   * person acted on it, and is what stops the same finding opening a second
   * merge request.
   */
  mergeRequestId?: string | null;
  /**
   * Claimed the moment a proposal starts, before the model is called, so two
   * simultaneous presses cannot both open one. Cleared again if the proposal
   * fails.
   */
  proposedAt?: string | null;
  /**
   * When a person marked the cited page outdated from this finding
   * (docs/features/39, issue #66). Explicit, never automatic, and recorded so
   * the button does not offer the same declaration twice.
   */
  flaggedAt?: string | null;
  /**
   * When a person dismissed this finding as wrong or not worth acting on (#70).
   * Set once — a second press changes nothing. The runs panel hides it by
   * default, and the agent's next runs are told not to report it again.
   */
  dismissedAt?: string | null;
  dismissedBy?: string | null;
  /** The proposed learning written with the dismissal ("Remember why"), if any. */
  learningId?: string | null;
  /**
   * The knowledge issue this finding answers (docs/features/38, phase 3): a
   * sentinel judging a report points its verdict back at the report, which is
   * what lets the publisher move the issue on without guessing.
   */
  issueId?: string;
  /**
   * The relations this finding proposes the first cited page should declare
   * (docs/features/28). Set only by the cartographer, and what lets the finding
   * be applied as a frontmatter edit instead of being handed to a model that
   * would rewrite the prose. A finding without it is a prose finding.
   */
  relations?: RelationInput[];
  /**
   * Pages on the open web this finding rests on (docs/features/29).
   *
   * Web-only on purpose. A cited workspace page is already `documentIds` +
   * `documentTitles`, and widening this to `AssistantSource` would give one
   * finding two ways to cite the same page — the shape `assistantSourceKey`
   * exists to keep straight.
   *
   * What it changes is what counts as *grounded*: `readFinding` drops any
   * finding citing no page that exists, so a finding whose whole evidence is
   * off-platform was discarded in silence. It now survives if it cites either.
   */
  sources?: AssistantWebSource[];
  /**
   * A new page this finding proposes (docs/features/31). Set only by the
   * archaeologist, whose findings cite source files rather than pages: there
   * is nothing to rewrite, so `propose` does not apply — a person creates the
   * page instead, and `documentIds` then records where it went. A finding with
   * a draft and no document is one nobody has acted on yet.
   */
  draft?: AgentFindingDraft;
  /**
   * The questions this finding stands on (docs/features/38, phase 4). Set
   * only by the surveyor, whose findings are grounded in answer feedback
   * rather than in pages: a cluster of questions the workspace could not
   * answer is a fact computed from `answer_feedback`, and the page ids and
   * draft are the model's proposal for closing it.
   */
  coverage?: AgentFindingCoverage;
  /**
   * The `component.paths` edits this finding proposes for the first cited page
   * (#236): a declared path the change removed (`to: null`) or moved. Set only
   * by the sentinel, from the diff, never by a model. Applied by `propose` as a
   * frontmatter edit against the page's head, beside the corrected body when
   * the finding has a draft.
   */
  componentPaths?: ComponentPathFix[];
}

/** One declared path a change removed or moved (#236). */
export interface ComponentPathFix {
  from: string;
  /** The path it moved to; null when it is gone. */
  to: string | null;
}

/**
 * One page that documents code using what a pull request changed (#236): the
 * drift check's Affected usages, grouped by page.
 */
export interface DriftAffectedPage {
  documentId: string;
  title: string;
  /** The usage files this page documents, sorted. */
  sites: string[];
  /** The changed files those sites import. */
  uses: string[];
  /** Whether this run judged the page. False past `MAX_DRIFT_PAGES`, or when no model ran. */
  judged: boolean;
}

/** What a drift check found that is not a finding: where the changed code is used. */
export interface DriftAffectedUsages {
  pages: DriftAffectedPage[];
  /** Pages documenting a usage that the run's scope may not open — counted, never titled. */
  hiddenPages: number;
  /** Usage files no page documents, sorted and capped. */
  undocumented: string[];
  undocumentedTotal: number;
}

/**
 * A finished run's output beside its findings (`agent_runs.details`). Only the
 * sentinel writes it today; every field is optional so a run that has nothing
 * to say writes nothing.
 */
export interface AgentRunDetails {
  affectedUsages?: DriftAffectedUsages;
}

/**
 * What a surveyor finding proposes (docs/features/38, phase 4). Closed: the
 * executor validates the model's answer against it, the web picks the button
 * from it, and a value the code never emits would be a button that does
 * nothing.
 */
export const COVERAGE_RECOMMENDATIONS = ['create-page', 'update-page', 'run-archaeologist'] as const;
export type CoverageRecommendation = (typeof COVERAGE_RECOMMENDATIONS)[number];

/** One cluster of questions answers failed on, and what to do about it. */
export interface AgentFindingCoverage {
  /** Representative questions, most asked first. Capped; `count` is the whole cluster. */
  questions: string[];
  /** Signals in the cluster — one per feedback row, so a question asked three times counts three. */
  count: number;
  /** How the signals arrived: down-votes, low-confidence turns, turns with no answer. */
  signals: Record<AnswerSignalKind, number>;
  /** Where they were asked. */
  surfaces: AnswerSurface[];
  recommendation: CoverageRecommendation;
}

/** The page a finding would become: written by the run, published by a person. */
export interface AgentFindingDraft {
  title: string;
  markdown: string;
}

// POST /v1/ai/agents/runs/:id/findings/:index/propose
export interface ProposeAgentFindingResponse {
  mergeRequestId: string;
  documentId: string;
  documentTitle: string;
  branch: string;
  title: string;
}

// POST /v1/ai/agents/runs/:id/findings/:index/mark-outdated
export interface FlagFindingOutdatedResponse {
  documentId: string;
  documentTitle: string;
  /** The page's derived state after the flag — `outdated`, unless a report outranks it. */
  verification: SourceVerificationState;
}

// POST /v1/ai/agents/runs/:id/findings/:index/create-page
export interface CreatePageFromFindingResponse {
  documentId: string;
  title: string;
}

export interface AgentRunSummary {
  id: string;
  workspaceId: string;
  agentKey: string;
  agentName: string;
  trigger: AgentRunTrigger;
  /** The agent trigger behind an `'event'` run, null for any other. It may since have been deleted. */
  triggerId: string | null;
  /** What the run is about — `doc:<id>`, `mr:<id>`, `connector:<id>`; null for an unscoped run. */
  subjectKey: string | null;
  status: AgentRunStatus;
  createdBy: string;
  /** What the run was asked to do; null for a run that took no parameters. */
  input: AgentRunInput | null;
  summary: string | null;
  findings: AgentFinding[];
  findingCount: number;
  error: string | null;
  /**
   * What the run is doing now, free text from the executor (docs/features/29).
   *
   * Not a closed union: the stages a curator passes through are not the ones a
   * research run passes through, and freezing them here would mean widening a
   * contract every time an executor learns a step. The web renders it through
   * `labelFor`, which falls back to the raw value — the `documents.category`
   * rule.
   */
  stage: string | null;
  /** 0–1 where the executor can honestly say how far in it is; null where it cannot. */
  progress: number | null;
  /** What degraded without failing the run. Capped at MAX_RUN_WARNINGS. */
  warnings: string[];
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

// GET /v1/ai/agents/runs?workspaceId=&agentKey=&status=&cursor=
export interface ListAgentRunsResponse {
  runs: AgentRunSummary[];
  nextCursor: string | null;
  counts: Record<AgentRunStatus, number>;
}

/** Why the router chose what it chose — the dry-run endpoint's answer. */
export interface AgentRouteDecision {
  agentKey: string;
  providerId: string | null;
  providerName: string | null;
  model: string;
  /** explicit | only-candidate | rules | model | fallback */
  via: string;
  reason: string;
  confidence: number;
  /** Agents considered and dropped, with the reason — this is what makes routing debuggable. */
  rejected: Array<{ agentKey: string; reason: string }>;
}

/** Viewer-safe projection: no instructions, no tools, no provider endpoints. */
export interface AiAgentChoice {
  key: string;
  name: string;
  description: string;
}

// GET /v1/ai/agents/choices?workspaceId=
export interface ListAiAgentChoicesResponse {
  agents: AiAgentChoice[];
}

// ---------------------------------------------------------------------------
// Glossary (docs/features/14): workspace vocabulary + automatic term linking
