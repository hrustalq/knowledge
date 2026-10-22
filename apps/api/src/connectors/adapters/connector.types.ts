import type {
  ApiSpecKind,
  ApiSpecSyntax,
  ConnectorCapabilities,
  ConnectorKind,
  ExternalAclAudience,
  Locale,
} from '@knowledge/contracts';
import { safeFetch } from '../../common/safe-fetch.js';
import { t } from '../../i18n/t.js';

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
  /** The page body — or, when `spec` is set, the spec text exactly as it will be stored. */
  markdown: string;
  /**
   * An API spec file rather than a page (#78). The sync creates a document of
   * this kind, stores the text with no frontmatter, and delivers every later
   * change by merge request.
   */
  spec?: { kind: ApiSpecKind; syntax: ApiSpecSyntax };
  frontmatter?: Record<string, unknown>;
  attachments?: ExternalAttachment[];
  /** What the conversion could not carry. Surfaced verbatim on the run. */
  warnings: string[];
}

/**
 * Somebody an upstream ACL names (#76, phase 6). `externalId` is the source's
 * stable id — a Confluence accountId or userKey, a GitHub user id or team slug.
 * Names and emails are untrusted source text: stored length-limited, shown as
 * text, never interpolated.
 */
export interface ExternalPrincipal {
  type: 'user' | 'group';
  externalId: string;
  name?: string;
  email?: string;
  level: 'view' | 'edit';
}

/**
 * Who may open one item upstream. `source-wide` means everyone who can see the
 * connector's scope, which mirrors as no restriction; `restricted` means only
 * `principals`. An adapter folds whatever inheritance the source has into this
 * one list, so a page reads correctly even when its ancestors were not imported.
 */
export interface ExternalAcl {
  audience: ExternalAclAudience;
  principals: ExternalPrincipal[];
}

/**
 * Why an item left the connector's view (#338). `trashed` is the source's own
 * bin; `removed` covers everything the feed cannot tell apart — deleted for
 * good, no longer shared with the connector, or moved out of its scope.
 */
export type ExternalRemovalReason = 'trashed' | 'removed';

/**
 * What changed upstream since a cursor (#338) — the Drive Changes API, read as
 * one page of answers.
 *
 * `changed` is already narrowed to the connector's scope and to what the
 * adapter can convert, and carries `parentExternalId` so a run seeded from it
 * still nests. `removed` is deliberately not narrowed: an item that is gone
 * cannot have its ancestry read, so the caller keeps the ids it has a link
 * for and ignores the rest.
 */
export interface ExternalChanges {
  /** Where the next read starts. Stored only once the run that read it finishes. */
  cursor: string;
  changed: ExternalRef[];
  removed: Array<{ externalId: string; reason: ExternalRemovalReason }>;
}

export interface ExternalGroupMember {
  externalId: string;
  name?: string;
  email?: string;
}

/** A page on its way out. */
export interface OutboundDocument {
  documentId: string;
  title: string;
  markdown: string;
  /** Absent when this page has never been pushed — the adapter creates instead of updating. */
  ref?: ExternalRef;
}

/** One importer → imported file pair at a code connector's head (#236). Paths are repo-relative. */
export interface CodeImportEdge {
  importer: string;
  imported: string;
  /** Names taken: `default`, `*` (namespace, star or dynamic import), empty for a side-effect import. */
  names: string[];
}

export interface CodeImportIndex {
  /** The commit the edges were read at, or null when the host did not say. */
  headSha: string | null;
  edges: CodeImportEdge[];
  /**
   * Every file at the head, read or not (#236, phase 6). Absent from an
   * adapter that cannot list them, and then nothing is ever reported missing.
   */
  files?: string[];
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
  /**
   * CONNECTOR_ALLOW_PRIVATE_URLS. Pointing a connector at an internal Confluence
   * is a legitimate self-hosted deployment, so `connectorFetch` needs to know
   * whether this install is one before it refuses a private address.
   */
  allowPrivate: boolean;
  /**
   * A warning for the run as a whole, raised during discovery (#338): files
   * the adapter will not import, said once per folder rather than never.
   * Optional because only a pull run has somewhere to put it.
   */
  warn?(message: string): void;
  /**
   * Who owns this connector — `connectors.created_by` (docs/features/27).
   *
   * Null is a real state: the column is nullable, and a connector whose creator
   * was deleted still syncs. It is carried because an adapter that spends money
   * has to bill somebody: `ai_usage.user_id` is a uuid column, so a run with no
   * owner would fail its insert and be swallowed, which is precisely the
   * invisible background spend feature 20 was written to stop. The codebase
   * adapter therefore declines to call a model at all when this is null, rather
   * than spending anonymously.
   */
  userId: string | null;
  /**
   * The connector's frozen locale (docs/features/18). Worker paths have no
   * request to read `Accept-Language` from, so it travels with the context the
   * way `import_jobs.locale` and `workflow_runs.locale` do.
   */
  locale: Locale;
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

  /**
   * Cheap round trip proving the credential and config reach something. A git
   * adapter may also name the spec files it saw (#78), for the dialog to offer.
   */
  testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string; apiSpecSuggestions?: string[] }>;

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
   * Who may open `ref` upstream (#76, phase 6). Present exactly when
   * `capabilities.acl` is true. Permission calls only — no content — so the
   * ACL-only refresh can run it over every linked page cheaply. Throws when the
   * ACL cannot be read; the caller fails closed rather than guessing.
   */
  permissions?(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalAcl>;

  /**
   * The people in an upstream group a `permissions()` result named. Asked
   * lazily, per group an ACL actually uses, rather than enumerating every
   * group in the source: a Confluence site can hold thousands that no page in
   * this connector's scope mentions.
   */
  groupMembers?(ctx: ConnectorContext, group: ExternalPrincipal): Promise<ExternalGroupMember[]>;

  /**
   * The source's change feed since `cursor` (#338). With a null cursor it reads
   * nothing and returns where the feed starts now — the bookmark a full walk
   * takes before it begins, so nothing that changes during the walk is lost.
   *
   * A scheduled pull with a stored cursor seeds its run from `changed` instead
   * of walking the tree; every pull reports the linked items in `removed`.
   * Throws when the cursor is no longer accepted; the caller then walks.
   */
  changes?(ctx: ConnectorContext, cursor: string | null): Promise<ExternalChanges>;

  /**
   * The repository's reverse-import index at the head this run read (#236).
   * Present on code connectors only. Asked once per pull, when discovery
   * finishes, and stored whole in place of the previous head's index.
   */
  codeImports?(ctx: ConnectorContext): Promise<CodeImportIndex>;

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

  /**
   * A harvest connector's delivery (#382, doc 59). Null means "not verified":
   * the caller answers 401 and does no work. `item: null` is verified but not
   * a resolution by a person. The payload is only a prefilter — whether the
   * item is resolved and labelled is decided by {@link readHarvestItem}.
   * Present exactly when `capabilities.harvest` is true.
   */
  verifyHarvestDelivery?(ctx: ConnectorContext, headers: Record<string, string>, rawBody: string): HarvestDelivery | null;

  /** The item as it is now, read fresh; null when it is gone or the credential cannot see it. */
  readHarvestItem?(ctx: ConnectorContext, externalId: string): Promise<HarvestItem | null>;
}

/** A resolution, as a delivery tells it: which item, and who resolved it. */
export interface HarvestDelivery {
  item: { externalId: string; actor: ExternalGroupMember } | null;
}

/** An item a harvest reads: its messages as a chat thread, oldest first. */
export interface HarvestItem {
  /** How a person cites it (`ENG-123`). */
  key: string;
  title: string;
  url: string;
  /** In its resolved state now (Linear: a `completed`-type state). */
  resolved: boolean;
  labels: string[];
  /** Authors are the source's opaque ids; the text is raw and is masked by the harvest. */
  messages: Array<{ authorId: string; text: string; at: Date }>;
}

/** Reads a required string out of `config`, with the adapter's own error. */
export function requireConfig(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(t('error.connector.missingConfig', { field: key }));
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
 * Pass `ctx`. It is optional only so a call can be written without one, and a
 * call without one is guarded at its strictest (private addresses refused);
 * every real adapter call should pass it, both for the trace and so a
 * self-hosted install reaching its own network still works.
 *
 * The context's `debug` traces the HTTP layer (docs/features/26) — the one place a
 * "the space looks empty" bug is actually visible, since a wrong token gets an
 * anonymous 200 from Confluence rather than a 401. The query string is stripped
 * from the trace for the same reason `ConnectorNetworkError` strips it: it is
 * the one part of a URL that can carry a token.
 */
export async function connectorFetch(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  ctx?: Pick<ConnectorContext, 'debug' | 'allowPrivate'>,
): Promise<Response> {
  const debug = ctx?.debug;
  const allowPrivate = ctx?.allowPrivate ?? false;
  const started = Date.now();
  const method = init.method ?? 'GET';
  let res: Response;
  try {
    // safeFetch: a connector base URL is validated when an admin saves it, but
    // that resolution is not the one this dial uses. The guard belongs at the
    // connection, where a rebound name cannot slip between the two.
    res = await safeFetch(url, init, allowPrivate);
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
