// Usage & search analytics (issue #79).
//
// Event rows only — a view, a search, an MCP tool call. Every number a
// dashboard shows is a rollup over those rows at read time; there is no stored
// aggregate (CLAUDE.md, "No stored aggregate tables").

/**
 * Where a read or a search came from. Resolved centrally by the API's
 * recorder: a caller names its surface when it is not a person at a browser,
 * and the principal decides the rest.
 *
 * - `web`: a person in the app (the page-view beacon, a session search).
 * - `api`: a `kn_` key over REST.
 * - `mcp`: any MCP tool call, HTTP or stdio.
 * - `assistant`: the in-app assistant's tools, on a person's turn.
 * - `chat`: a chat-bot answer (docs/features/47).
 * - `agent`: a background agent run or workflow step.
 */
export const ANALYTICS_CHANNELS = ['web', 'api', 'mcp', 'assistant', 'chat', 'agent'] as const;
export type AnalyticsChannel = (typeof ANALYTICS_CHANNELS)[number];

/**
 * Who is behind the traffic. `assisted` is a model answering one person's
 * question — the in-app assistant or a chat bot — which is neither a person
 * reading nor an agent working on its own.
 */
export const TRAFFIC_CLASSES = ['human', 'assisted', 'agent'] as const;
export type TrafficClass = (typeof TRAFFIC_CLASSES)[number];

const CLASS_OF: Record<AnalyticsChannel, TrafficClass> = {
  web: 'human',
  assistant: 'assisted',
  chat: 'assisted',
  api: 'agent',
  mcp: 'agent',
  agent: 'agent',
};

/** Derived, never stored: a channel's traffic class. */
export function trafficClassFor(channel: AnalyticsChannel): TrafficClass {
  return CLASS_OF[channel];
}

/** The inverse, so a `?traffic=` filter stays a `channel = ANY(…)` in SQL. */
export function channelsForTrafficClass(cls: TrafficClass): AnalyticsChannel[] {
  return ANALYTICS_CHANNELS.filter((c) => CLASS_OF[c] === cls);
}

/** The `?traffic=` filter of a rollup: one class, or everything. */
export const ANALYTICS_TRAFFIC_FILTERS = ['all', ...TRAFFIC_CLASSES] as const;
export type AnalyticsTrafficFilter = (typeof ANALYTICS_TRAFFIC_FILTERS)[number];

/** Days a rollup may span, and the span it takes when none is asked for. */
export const ANALYTICS_MAX_DAYS = 366;
export const ANALYTICS_DEFAULT_DAYS = 30;

/** One UTC day of page views, split by traffic class. Days without views are absent. */
export interface AnalyticsDayPoint {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  human: number;
  assisted: number;
  agent: number;
}

/** Page-view numbers over a window. */
export interface AnalyticsViewTotals {
  views: number;
  byClass: Record<TrafficClass, number>;
  /** Distinct reader keys; views sent under DNT / GPC count as views only. */
  uniqueReaders: number;
  /** Median active read time of web views that read for any time at all; null with none. */
  medianReadMs: number | null;
  series: AnalyticsDayPoint[];
}

// GET /v1/documents/:id/insights
export interface PageInsightsResponse extends AnalyticsViewTotals {
  documentId: string;
  /** ISO window bounds. */
  from: string;
  to: string;
  /** The newest web view, whenever it was. */
  lastHumanViewAt: string | null;
  /** The workspace's first recorded view: before it, "no views" means "not counted". */
  collectingSince: string | null;
}

/** A page in a ranked list. */
export interface AnalyticsPageRow {
  documentId: string;
  title: string;
  views: number;
  uniqueReaders: number;
  medianReadMs: number | null;
}

/** A page in a "not read" list. */
export interface AnalyticsQuietPage {
  documentId: string;
  title: string;
  createdAt: string;
  lastHumanViewAt: string | null;
}

/** The window and filter a rollup answered for. */
export interface AnalyticsWindow {
  /** ISO window bounds. */
  from: string;
  to: string;
  traffic: AnalyticsTrafficFilter;
  /** The workspace's first recorded view: before it, "no views" means "not counted". */
  collectingSince: string | null;
}

/** The three page lists a curator acts on. */
export interface AnalyticsPageLists {
  topPages: AnalyticsPageRow[];
  /** Pages with no web view since collection began, oldest first. */
  neverRead: AnalyticsQuietPage[];
  /**
   * Pages older than `deadAfterDays` that nobody opened in the app and no
   * search returned in that window. Empty until collection covers the window.
   */
  dead: AnalyticsQuietPage[];
  deadAfterDays: number;
}

// GET /v1/projects/:id/analytics?days=&traffic=
export interface ProjectAnalyticsResponse extends AnalyticsViewTotals, AnalyticsPageLists, AnalyticsWindow {
  projectId: string;
}

// GET /v1/analytics/overview?workspaceId=&days=&traffic=
export interface AnalyticsOverviewResponse extends AnalyticsViewTotals, AnalyticsWindow {
  workspaceId: string;
  /** Whether recording is on for the workspace now (env ceiling and its setting). */
  recording: boolean;
  /** Searches, a reader's repeats of one query within 10 s counted once. */
  searches: number;
  zeroResultSearches: number;
  /** Web searches followed by a result click ÷ web searches that found something; null with none. */
  clickThrough: number | null;
  /** Questions asked of the in-app assistant; null when the traffic filter leaves out `assisted`. */
  assistantQuestions: number | null;
  /** MCP tool calls; null when the traffic filter leaves out `agent`. */
  mcpCalls: number | null;
}

// GET /v1/analytics/pages?workspaceId=&days=&traffic=
export interface AnalyticsPagesResponse extends AnalyticsPageLists, AnalyticsWindow {
  workspaceId: string;
}

/** One query, grouped by its hash so it survives retention redacting the text. */
export interface AnalyticsQueryRow {
  queryHash: string;
  /** The newest text on record; null once retention has redacted every copy. */
  queryText: string | null;
  searches: number;
  zeroResults: number;
  /** Over web searches that found something — nothing else can be clicked. Null with none. */
  clickThrough: number | null;
  meanClickedRank: number | null;
  lastSearchedAt: string;
}

// GET /v1/analytics/search?workspaceId=&days=&traffic=
export interface AnalyticsSearchResponse extends AnalyticsWindow {
  workspaceId: string;
  top: AnalyticsQueryRow[];
  zeroResult: AnalyticsQueryRow[];
  /** Web searches that returned results nobody opened. */
  noClick: AnalyticsQueryRow[];
}

export interface AnalyticsToolRow {
  tool: string;
  calls: number;
  errors: number;
  medianMs: number | null;
}

/** What one API key did. Name and prefix only — never the key. */
export interface AnalyticsKeyRow {
  apiKeyId: string;
  /** Null when the key has since been deleted. */
  name: string | null;
  prefix: string | null;
  mcpCalls: number;
  views: number;
  searches: number;
}

export interface AnalyticsOperationRow {
  operation: string;
  calls: number;
}

// GET /v1/analytics/agents?workspaceId=&days=
export interface AnalyticsAgentsResponse {
  workspaceId: string;
  from: string;
  to: string;
  tools: AnalyticsToolRow[];
  keys: AnalyticsKeyRow[];
  assistantQuestions: number;
  /** Questions per UTC day; days without any are absent. */
  questionSeries: Array<{ date: string; count: number }>;
  /** Model calls by `ai_usage.operation`. */
  operations: AnalyticsOperationRow[];
}

/** The tables the dashboard can download: `GET /v1/analytics/export.csv?report=`. */
export const ANALYTICS_REPORTS = [
  'pages-top',
  'pages-never-read',
  'pages-dead',
  'search-top',
  'search-zero-result',
  'search-no-click',
  'agents-tools',
  'agents-keys',
  'agents-operations',
] as const;
export type AnalyticsReport = (typeof ANALYTICS_REPORTS)[number];

export interface AnalyticsSettingsValues {
  enabled: boolean;
  retentionDays: number;
}

// GET /v1/analytics/settings?workspaceId=
export interface AnalyticsSettingsResponse {
  workspaceId: string;
  /** The workspace's own values; null inherits the ceiling. */
  requested: { enabled: boolean | null; retentionDays: number | null };
  /** The deployment's env: a workspace may turn recording off and keep rows for less, never more. */
  ceiling: AnalyticsSettingsValues;
  effective: AnalyticsSettingsValues;
  /** After this many days a search keeps its hash and loses its text. */
  queryTextDays: number;
  /** The unread / dead window: a retention shorter than it means those lists never match. */
  deadPageDays: number;
}

// PUT /v1/analytics/settings
export interface UpdateAnalyticsSettingsRequest {
  workspaceId: string;
  enabled: boolean | null;
  retentionDays: number | null;
}
