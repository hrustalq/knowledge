import type {
  ApiErrorPayload,
  AssistantSource,
  AssistantToolCall,
  AssistantWebSource,
} from '@knowledge/contracts/core';
import type { RelationInput } from '@knowledge/contracts/documents';

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
  /** Per-purpose routing into the workspace's provider profiles. */
  routing: AiRouting;
  /** False when SETTINGS_ENCRYPTION_KEY is unset — the UI must disable key entry. */
  canStoreSecrets: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
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
}
// GET /v1/ai/skills?workspaceId=
export interface ListAiSkillsResponse {
  skills: AiSkillSummary[];
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
   * Inferring graph relations from a chunk during ingestion. One row per chunk
   * call, so a reindex of a large corpus is visible as the spend it is.
   */
  | 'extraction';

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
] as const;
export type BuiltInAgentKey = (typeof BUILT_IN_AGENT_KEYS)[number];

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
  'ask_user',
  'request_agent_mode',
  'render_component',
  'create_document',
  'propose_update',
  /** Edits the page's frontmatter relations, as a merge request (docs/features/28). */
  'edit_relations',
] as const;

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
  scheduleMinutes: number | null;
  scheduleNote: string | null;
  scheduleOwner: string | null;
  lastRunAt: string | null;
  updatedAt: string | null;
}

// GET /v1/ai/agents?workspaceId=
export interface ListAiAgentsResponse {
  agents: AiAgentSummary[];
}

/** Background agent runs (docs/features/20). */
export const AGENT_RUN_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/**
 * How a run was started. Deliberately only what the code emits: an event
 * trigger is a plausible third value, but a closed vocabulary that promises one
 * nothing produces is the defect this feature was written against
 * (`WorkflowStep.tools`, declared and ignored). Add `'event'` back together
 * with the service that emits it, and with WorkflowTriggerService's guards.
 */
export const AGENT_RUN_TRIGGERS = ['manual', 'schedule'] as const;
export type AgentRunTrigger = (typeof AGENT_RUN_TRIGGERS)[number];

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
}

// POST /v1/ai/agents/runs/:id/findings/:index/propose
export interface ProposeAgentFindingResponse {
  mergeRequestId: string;
  documentId: string;
  documentTitle: string;
  branch: string;
  title: string;
}

export interface AgentRunSummary {
  id: string;
  workspaceId: string;
  agentKey: string;
  agentName: string;
  trigger: AgentRunTrigger;
  status: AgentRunStatus;
  createdBy: string;
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
