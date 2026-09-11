import type { ConnectorCapabilities, ConnectorKind } from '@knowledge/contracts';

/**
 * The connector adapter interface (docs/features/19).
 *
 * Deliberately the `DocumentParser` shape from feature 16: a closed catalogue
 * of kinds in contracts, a DI registry keyed by kind, one file per adapter, and
 * every adapter reporting what it could *not* carry rather than silently
 * dropping it. All four talk plain `fetch` — the house pattern (ArcadeClient,
 * the OpenSearch client), no per-vendor SDK.
 */

/** A reference to one item on the far side, cheap enough to enumerate in bulk. */
export interface ExternalRef {
  externalId: string;
  title: string;
  url?: string;
  /** Confluence version.number, Notion last_edited_time, git blob sha, ... */
  version?: string;
  /**
   * The item this one hangs under on the far side; absent means a root of the
   * connector's scope (docs/features/26). Without this field hierarchy is not
   * merely unimplemented but unrepresentable, which is why every pulled page
   * used to land as a sibling of every other.
   */
  parentExternalId?: string;
  /**
   * The adapter knows the branch continues but has not walked it. Lets the tree
   * draw a collapsed branch honestly instead of as a leaf — the one thing a
   * lazily discovered tree must never do.
   */
  hasChildren?: boolean;
}

export interface ExternalAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/** One external item, fetched and converted to this platform's shape. */
export interface ExternalDocument {
  ref: ExternalRef;
  title: string;
  markdown: string;
  frontmatter?: Record<string, unknown>;
  attachments?: ExternalAttachment[];
  /** What the conversion could not carry. Surfaced verbatim on the run. */
  warnings: string[];
}

/** A page on its way out. */
export interface OutboundDocument {
  documentId: string;
  title: string;
  markdown: string;
  /** Absent when this page has never been pushed — the adapter creates instead of updating. */
  ref?: ExternalRef;
}

export interface ConnectorContext {
  connectorId: string;
  workspaceId: string;
  /** Non-secret, kind-specific settings (validated by the adapter's own `fields`). */
  config: Record<string, unknown>;
  /** Decrypted for the duration of the call; never persisted or logged. */
  credential: string | null;
  /** Decrypted inbound-webhook secret, for `verifyWebhook`. Null = webhooks refused. */
  webhookSecret?: string | null;
  /** Throttled by the caller — adapters may call it freely. */
  onStage(stage: string, progress?: number | null): Promise<void>;
  /**
   * Developer trace, a no-op unless CONNECTOR_DEBUG is on — so adapters may call
   * it as freely as `onStage` (docs/features/26). Never pass a credential or a
   * full URL with a query string; `connectorFetch` traces the HTTP layer itself.
   */
  debug(message: string, fields?: Record<string, unknown>): void;
  signal?: AbortSignal;
}

export interface ConnectorAdapter {
  readonly kind: ConnectorKind;
  /**
   * `push: false` is how an adapter says it is pull-only — Jira does, because
   * authoring Atlassian Document Format is its own piece of work. The optional
   * `push` method below is the type-level half of the same statement.
   */
  readonly capabilities: ConnectorCapabilities;

  /** Cheap round trip proving the credential and config reach something. */
  testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }>;

  /** Enumerate the connector's scope. Paginates internally; the caller bounds it. */
  list(ctx: ConnectorContext): AsyncIterable<ExternalRef>;

  /**
   * Direct children of `parent`, or the roots of the scope when it is null
   * (docs/features/26). Optional in the `push?` sense: an adapter that cannot
   * express hierarchy simply does not have it, and the caller falls back to the
   * flat `list()` — which is what Jira, Notion and markdown-git still do.
   *
   * Implementations must yield refs carrying `parentExternalId` and, where the
   * upstream says so, `hasChildren`, so the walk knows where to go next without
   * a second request per page.
   */
  children?(ctx: ConnectorContext, parent: ExternalRef | null): AsyncIterable<ExternalRef>;

  fetch(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument>;

  push?(ctx: ConnectorContext, doc: OutboundDocument): Promise<ExternalRef>;

  /**
   * Verify an inbound webhook and say which items changed. Returning null means
   * "not verified" — the caller answers 401 and does no work. An empty array
   * means verified but nothing to do (ping/handshake events).
   */
  verifyWebhook?(
    ctx: ConnectorContext,
    headers: Record<string, string>,
    rawBody: string,
  ): ExternalRef[] | null;
}

/** Reads a required string out of `config`, with the adapter's own error. */
export function requireConfig(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing config field: ${key}`);
  }
  return value.trim();
}

export function optionalConfig(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Trailing slashes make every template literal below ambiguous. */
export function trimBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

/**
 * One place for "the upstream said no". Adapters throw this so the processor can
 * record a per-item warning and carry on instead of failing the whole run.
 */
export class ConnectorRequestError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    body: string,
  ) {
    super(`${status} from ${url}${body ? `: ${body.slice(0, 300)}` : ''}`);
    this.name = 'ConnectorRequestError';
  }
}

/**
 * The reason underneath a `fetch` rejection.
 *
 * undici reports every network-level failure as the bare words "fetch failed"
 * and puts the actual reason — TLS chain, DNS, refused connection — on `cause`,
 * occasionally one level deeper again. Unwrapping it is the difference between
 * a run that says `fetch failed` and one that names the certificate.
 */
function causeOf(err: unknown): string {
  const seen = new Set<unknown>();
  let code: string | undefined;
  let message: string | undefined;
  for (let cur: unknown = err; cur && typeof cur === 'object' && !seen.has(cur); ) {
    seen.add(cur);
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === 'string') code = e.code;
    if (typeof e.message === 'string' && e.message !== 'fetch failed') message = e.message;
    cur = e.cause;
  }
  return [code, message].filter(Boolean).join(': ') || 'fetch failed';
}

/** The far side was never reached — as opposed to reached and refusing. */
export class ConnectorNetworkError extends Error {
  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    // The query string is dropped: it is the one part of a URL that can carry a
    // token, and this message is written to a run row anyone may read.
    super(`could not reach ${url.split('?')[0]}: ${causeOf(cause)}`);
    this.name = 'ConnectorNetworkError';
    this.cause = cause;
  }
}

/**
 * `fetch` with the error shapes above; every adapter goes through it.
 *
 * Passing `debug` traces the HTTP layer (docs/features/26) — the one place a
 * "the space looks empty" bug is actually visible, since a wrong token gets an
 * anonymous 200 from Confluence rather than a 401. The query string is stripped
 * from the trace for the same reason `ConnectorNetworkError` strips it: it is
 * the one part of a URL that can carry a token.
 */
export async function connectorFetch(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  debug?: ConnectorContext['debug'],
): Promise<Response> {
  const started = Date.now();
  const method = init.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // An abort is the caller's own timeout, which carries its own message.
    if (init.signal?.aborted) throw err;
    debug?.('http failed', { method, url: url.split('?')[0], ms: Date.now() - started });
    throw new ConnectorNetworkError(url, err);
  }
  debug?.('http', {
    method,
    url: url.split('?')[0],
    status: res.status,
    ms: Date.now() - started,
    bytes: res.headers.get('content-length') ?? '?',
  });
  if (!res.ok) {
    throw new ConnectorRequestError(res.status, url, await res.text().catch(() => ''));
  }
  return res;
}
