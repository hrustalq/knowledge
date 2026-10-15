// Observability: the shape of a log record, the trace context that correlates
// records to each other, and the backtest event payloads.
//
// This domain is the answer to "should there be a logger package shared by api
// and web". There should not: a Node process writing JSON under an ALS scope and
// a browser that can only console/POST share no transport, and packages/* are
// consumed from source, so a Node-only dependency here would be reachable from
// the web client bundle. What both halves DO need to agree on is the record
// shape — that is what lets a browser error, an API request and a worker job be
// joined by one id. So: types here, implementations in each app.
import type { ApiErrorCode } from '@knowledge/contracts/core';

// --- levels ---------------------------------------------------------------

// pino's level names, in pino's order. Kept as our own list rather than imported
// so this file stays dependency-free.
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// --- trace context --------------------------------------------------------

/**
 * Where a unit of work entered the system. Four of these exist because the API
 * has four entrypoints and only one of them is HTTP: an http request, a BullMQ
 * job, a websocket connection (middleware never runs on an upgrade), an MCP
 * stdio tool call, and a CLI script.
 */
export const TRACE_SOURCES = ['http', 'job', 'ws', 'mcp', 'cli'] as const;
export type TraceSource = (typeof TRACE_SOURCES)[number];

/**
 * The ambient context merged into every log record.
 *
 * Only `traceId` and `source` are known when the scope opens. `workspaceId` and
 * `userId` arrive later — the guards resolve them after middleware has already
 * run — which is why the api-side scope is mutable rather than frozen at entry.
 */
export interface TraceContext {
  /** Correlates every record for one request/job. Accepted from `x-request-id` when a caller supplies one, so a browser action and the API request it caused share an id. */
  traceId: string;
  source: TraceSource;
  /** http: the matched route or raw path. job: the queue name. mcp: the tool name. */
  route?: string;
  method?: string;
  workspaceId?: string;
  userId?: string;
  /** The queue row id (ingestion_jobs.id, connector_runs.id, …), not the BullMQ job id. */
  jobId?: string;
  /** Set on a job whose parent request is known, so worker work joins back to the request that queued it. */
  parentTraceId?: string;
}

// --- log record -----------------------------------------------------------

/**
 * One emitted line. This is the *wire* shape — what lands in the JSONL file and
 * what a web client posts — not the logger's call signature.
 */
export interface LogRecord extends TraceContext {
  ts: string;
  level: LogLevel;
  msg: string;
  /** The `new Logger(X.name)` context string on the api side; a component or module name on the web side. */
  ctx?: string;
  code?: OpsCode | ApiErrorCode;
  durationMs?: number;
  err?: SerializedError;
  /** Anything site-specific. Kept separate so the top level stays a stable, indexable set. */
  fields?: Record<string, unknown>;
}

export interface SerializedError {
  type?: string;
  message: string;
  stack?: string;
}

// --- stable codes ---------------------------------------------------------

/**
 * Codes for failures that are deliberately swallowed — the ones that keep a
 * request working while something behind it did not. They are a closed set so
 * they can be counted and alerted on; a message string cannot be either.
 *
 * `ApiErrorCode` covers failures the caller is told about. These cover the ones
 * only we find out about.
 */
export const OPS_CODES = [
  'UNHANDLED_EXCEPTION',
  'TX_AFTER_COMMIT_FAILED',
  'JOB_ENQUEUE_FAILED',
  'EVENT_PUBLISH_FAILED',
  'ACTIVITY_RECORD_FAILED',
  'AI_USAGE_RECORD_FAILED',
  'FULLTEXT_INDEX_FAILED',
  'INFERRED_EXTRACTION_FAILED',
  'DEPENDENT_REINDEX_FAILED',
  'GRAPH_COMMAND_FAILED',
  'SCHEDULED_RUN_FAILED',
  'WORKFLOW_TRANSITION_FAILED',
  'SWEEP_FAILED',
  'OPS_SINK_FAILED',
] as const;
export type OpsCode = (typeof OPS_CODES)[number];

// --- backtest events ------------------------------------------------------

/**
 * The measurable events. These go to a separate JSONL stream rather than to
 * stdout and to Postgres: a full corpus re-index emits tens of thousands of step
 * events, which belongs in a file a harness reads, not in the transactional DB.
 */
export const BACKTEST_EVENT_KINDS = ['http.request', 'search.executed', 'ai.call', 'ingest.step'] as const;
export type BacktestEventKind = (typeof BACKTEST_EVENT_KINDS)[number];

interface BacktestEventBase extends TraceContext {
  kind: BacktestEventKind;
  ts: string;
  durationMs: number;
}

/** Metadata only, deliberately: no request or response bodies, so there is no redaction policy to get wrong. */
export interface HttpRequestEvent extends BacktestEventBase {
  kind: 'http.request';
  method: string;
  status: number;
  requestBytes?: number;
  responseBytes?: number;
}

/** The tuple a recall@k / MRR sweep needs. `results` is the ranked head, in order. */
export interface SearchExecutedEvent extends BacktestEventBase {
  kind: 'search.executed';
  query: string;
  mode: string;
  /** Requested k, and the over-fetch actually issued when metadata filters are present. */
  limit: number;
  fetchK: number;
  /** Per-leg timings — the point of recording these is that a regression is almost always in one leg. */
  vectorMs?: number;
  fulltextMs?: number;
  tagsMs?: number;
  vectorHits: number;
  fulltextHits: number;
  fusedHits: number;
  embeddingModel?: string;
  /** Whether the trust re-rank multiplied the fused scores (docs/features/39), so two runs can be compared. */
  trustApplied?: boolean;
  /** Fused hits dropped by the page-permission post-filter (#76), so restricted recall can be measured. */
  aclFiltered?: number;
  results: Array<{ documentId: string; chunkId?: string; score: number }>;
}

export interface AiCallEvent extends BacktestEventBase {
  kind: 'ai.call';
  operation: string;
  provider: string;
  model: string;
  agentKey?: string;
  promptTokens?: number;
  completionTokens?: number;
  toolCallCount?: number;
  ok: boolean;
  errorCode?: string;
  /** The provider returned no usage block and the counts are a local estimate. */
  estimated?: boolean;
}

/** One event per revision carrying every pipeline step, rather than one event per step. */
export interface IngestStepEvent extends BacktestEventBase {
  kind: 'ingest.step';
  documentId: string;
  revisionId: string;
  ok: boolean;
  bytes?: number;
  chunks?: number;
  embeddingModel?: string;
  steps: Array<{ step: string; ms: number; count?: number; ok: boolean }>;
}

export type BacktestEvent = HttpRequestEvent | SearchExecutedEvent | AiCallEvent | IngestStepEvent;

// --- feedback as a backtest dataset -----------------------------------------
//
// Phase 5 of the answer trust milestone (docs/features/38, issue #67). The
// `search.executed` stream above knows what came back; it never knows what
// *should* have. Votes do: an up-vote says the cited pages answered the
// question, a "wrong" or "irrelevant sources" down-vote says they did not, and a
// report that ended in a merged fix says the page answers it *now*. Each of
// those is one labelled case the retrieval backtest can replay.
//
// `BACKTEST_EVENT_KINDS` is deliberately not widened: a case is ground truth
// built from PostgreSQL rows, not an event the app emitted.

import type { AnswerFeedbackReason, AnswerRating, AnswerSurface } from '@knowledge/contracts/ai';

/** One line of the exported NDJSON. */
export interface FeedbackBacktestCase {
  /** The export is per workspace; the replay searches in it. */
  workspaceId: string;
  query: string;
  surface: AnswerSurface;
  rating: AnswerRating;
  reason: AnswerFeedbackReason | null;
  /** Pages a correct retrieval must return: cited by an up-voted answer, or fixed by a merged report. */
  expectedDocumentIds: string[];
  /** Pages a correct retrieval should keep out of its head: cited by a `wrong` / `irrelevant-sources` down-vote. */
  rejectedDocumentIds: string[];
  createdAt: string;
}

/** The down-vote reasons that blame the pages rather than the answer's wording. */
export const REJECTING_FEEDBACK_REASONS: readonly AnswerFeedbackReason[] = ['wrong', 'irrelevant-sources'];

/** What the builder reads off an `answer_feedback` vote row. */
export interface FeedbackVoteLike {
  workspaceId: string;
  query: string;
  surface: AnswerSurface;
  rating: AnswerRating;
  reason: AnswerFeedbackReason | null;
  citedDocumentIds: readonly string[];
  createdAt: string;
}

/**
 * One vote → one case, or nothing. `fixedDocumentIds` are the cited pages a
 * later report on this vote got merged for: the page was wrong when the vote
 * was cast and answers the question now, so it moves from rejected to expected.
 * A vote with no ground truth either way — an up-vote on a web-only answer, a
 * down-vote that blames the wording — yields `null` rather than an empty case.
 */
export function feedbackCaseFromVote(
  vote: FeedbackVoteLike,
  fixedDocumentIds: readonly string[] = [],
): FeedbackBacktestCase | null {
  const query = vote.query.trim();
  if (!query) return null;
  const cited = [...new Set(vote.citedDocumentIds)];
  const fixed = [...new Set(fixedDocumentIds)].filter((id) => cited.includes(id));
  let expected: string[];
  let rejected: string[];
  if (vote.rating === 'up') {
    expected = cited;
    rejected = [];
  } else {
    expected = fixed;
    rejected =
      vote.reason && REJECTING_FEEDBACK_REASONS.includes(vote.reason) ? cited.filter((id) => !fixed.includes(id)) : [];
  }
  if (expected.length === 0 && rejected.length === 0) return null;
  return {
    workspaceId: vote.workspaceId,
    query,
    surface: vote.surface,
    rating: vote.rating,
    reason: vote.reason,
    expectedDocumentIds: expected,
    rejectedDocumentIds: rejected,
    createdAt: vote.createdAt,
  };
}

/** One replayed case. `null` where the case carries no label of that kind. */
export interface FeedbackCaseScore {
  hitAt1: boolean | null;
  hitAtK: boolean | null;
  reciprocalRank: number | null;
  rejectedInTopK: boolean | null;
}

/** Score one case against the ranked head a search returned for its query. */
export function scoreFeedbackCase(c: FeedbackBacktestCase, rankedDocumentIds: readonly string[], k: number): FeedbackCaseScore {
  const head = rankedDocumentIds.slice(0, Math.max(1, k));
  let hitAt1: boolean | null = null;
  let hitAtK: boolean | null = null;
  let reciprocalRank: number | null = null;
  if (c.expectedDocumentIds.length > 0) {
    const rank = head.findIndex((id) => c.expectedDocumentIds.includes(id));
    hitAt1 = rank === 0;
    hitAtK = rank >= 0;
    reciprocalRank = rank >= 0 ? 1 / (rank + 1) : 0;
  }
  const rejectedInTopK =
    c.rejectedDocumentIds.length > 0 ? head.some((id) => c.rejectedDocumentIds.includes(id)) : null;
  return { hitAt1, hitAtK, reciprocalRank, rejectedInTopK };
}

/** Rates over the cases that carry the label, so a split with no expectations reads as 0/0, not 0%. */
export interface FeedbackMetrics {
  cases: number;
  withExpected: number;
  hitAt1: number;
  hitAtK: number;
  mrr: number;
  withRejected: number;
  rejectedInTopK: number;
}

export function summarizeFeedbackScores(scores: readonly FeedbackCaseScore[]): FeedbackMetrics {
  let withExpected = 0;
  let hitAt1 = 0;
  let hitAtK = 0;
  let rrSum = 0;
  let withRejected = 0;
  let rejectedInTopK = 0;
  for (const s of scores) {
    if (s.reciprocalRank !== null) {
      withExpected += 1;
      rrSum += s.reciprocalRank;
      if (s.hitAt1) hitAt1 += 1;
      if (s.hitAtK) hitAtK += 1;
    }
    if (s.rejectedInTopK !== null) {
      withRejected += 1;
      if (s.rejectedInTopK) rejectedInTopK += 1;
    }
  }
  return {
    cases: scores.length,
    withExpected,
    hitAt1,
    hitAtK,
    mrr: withExpected ? rrSum / withExpected : 0,
    withRejected,
    rejectedInTopK,
  };
}
