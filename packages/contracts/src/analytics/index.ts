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
