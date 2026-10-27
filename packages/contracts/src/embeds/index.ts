// ---------------------------------------------------------------------------
// Embeds (#470, docs/features/64): an `embed` block holds a group of external
// items, each pinned to a version. The provider catalogue is closed: a URL no
// provider claims stays a plain link and never becomes an iframe.
// ---------------------------------------------------------------------------

/** The closed catalogue. Figma is the only provider; each new one is its own issue. */
export const EMBED_PROVIDERS = ['figma'] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

/** How a group lays its items out. Carried by `data-kn-embed` itself. */
export const EMBED_LAYOUTS = ['strip', 'grid'] as const;
export type EmbedLayout = (typeof EMBED_LAYOUTS)[number];

export function asEmbedLayout(value: unknown): EmbedLayout {
  return value === 'grid' ? 'grid' : 'strip';
}

/**
 * Items per group when `EMBED_MAX_ITEMS` is unset. The picker stops here; the
 * API warns past the env value on any write path.
 */
export const DEFAULT_EMBED_MAX_ITEMS = 24;

/** One item as the markdown stores it. `url` is canonical when a provider claims it, verbatim otherwise. */
export interface EmbedItem {
  url: string;
  /** The pinned provider version; null = unpinned (kept, rendered as a link, warned). */
  version: string | null;
  /** Empty = none; the link text then falls back to the URL. */
  caption: string;
}

/** What a provider URL points at. */
export interface EmbedRef {
  provider: EmbedProvider;
  fileKey: string;
  /** The API's colon form (`12:34`); null = the whole file. */
  nodeId: string | null;
  /** A FigJam board rather than a design file. */
  board: boolean;
}

const FIGMA_HOSTS = new Set(['figma.com', 'www.figma.com', 'embed.figma.com']);
const FIGMA_KINDS = new Set(['design', 'file', 'proto', 'board']);
const FIGMA_KEY_RE = /^[A-Za-z0-9]{10,64}$/;
const FIGMA_NODE_RE = /^[A-Za-z0-9:;-]{1,200}$/;

/**
 * The one matcher every surface calls — the paste rule, the parse rule, the
 * importers, the connectors and the API's warnings — so they cannot disagree
 * about what is embeddable. Design, prototype, Dev Mode, legacy `/file/` and
 * FigJam board links, and Figma's own embed URLs (`/embed?url=…`,
 * `embed.figma.com/…`); a branch link's branch key is the file key, because that
 * is the key Figma's API takes.
 */
export function parseEmbedUrl(raw: string): EmbedRef | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !FIGMA_HOSTS.has(url.hostname)) return null;
  // Figma's own embed, as an iframe or another tool writes it: the old form
  // carries the file link in `url`; `embed.figma.com` mirrors the file path.
  if (url.pathname === '/embed') {
    const inner = url.searchParams.get('url');
    return inner && !/figma\.com\/embed\b/.test(inner) ? parseEmbedUrl(inner) : null;
  }
  const [kind, key, ...rest] = url.pathname.split('/').filter(Boolean);
  if (!kind || !FIGMA_KINDS.has(kind)) return null;
  const fileKey = rest[0] === 'branch' && rest[1] ? rest[1] : key;
  if (!fileKey || !FIGMA_KEY_RE.test(fileKey)) return null;
  // The URL writes `12-34`; the API takes `12:34`. Instance ids (`I1:2;3:4`) fold the same way.
  const node = url.searchParams.get('node-id');
  if (node !== null && !FIGMA_NODE_RE.test(node)) return null;
  return { provider: 'figma', fileKey, nodeId: node ? node.replace(/-/g, ':') : null, board: kind === 'board' };
}

/** The one spelling the markdown stores: title slugs and every other parameter dropped. */
export function canonicalEmbedUrl(ref: EmbedRef): string {
  const base = `https://www.figma.com/${ref.board ? 'board' : 'design'}/${ref.fileKey}/`;
  return ref.nodeId ? `${base}?node-id=${encodeURIComponent(ref.nodeId.replace(/:/g, '-'))}` : base;
}

/** A URL in its canonical spelling, or unchanged when no provider claims it. */
export function canonicalizeEmbedUrl(raw: string): string {
  const ref = parseEmbedUrl(raw);
  return ref ? canonicalEmbedUrl(ref) : raw.trim();
}

// --------------------------------------------------------- figma connector

/** The `figma` connector's config keys. */
export const FIGMA_ALLOWLIST_CONFIG_KEY = 'allowlist';
export const FIGMA_TOKEN_EXPIRES_CONFIG_KEY = 'tokenExpiresAt';
/**
 * The OAuth grant a connector dials with (#557): the Figma user id its
 * `figma_oauth_grants` row is keyed by, and that person's handle for the card.
 * Server-owned: only the OAuth callback writes them, and a create or update
 * that names them is ignored, so no admin can point a connector at a grant
 * another workspace connected.
 */
export const FIGMA_GRANT_CONFIG_KEY = 'figmaGrant';
export const FIGMA_HANDLE_CONFIG_KEY = 'figmaHandle';

// GET /v1/connectors/figma/oauth
export interface FigmaOauthStatusResponse {
  /** False with the client id unset (the off switch) or no encryption key; the PAT field is then the only way in. */
  configured: boolean;
}
// GET /v1/connectors/:id/figma/authorize
export interface FigmaAuthorizeResponse {
  url: string;
}

/** Days before the typed-in expiry that the connector card starts warning. */
export const FIGMA_TOKEN_WARN_DAYS = 14;

export interface FigmaAllowlist {
  teams: string[];
  projects: string[];
  /** Entries that are neither, echoed back so the form can say which. */
  invalid: string[];
}

/**
 * The allowlist field: team and folder links or `team:<id>` / `folder:<id>`,
 * separated by whitespace or commas. Figma's links are
 * `/files/team/<id>/…`, `/files/folder/<id>/…`, and either one under an
 * organization (`/files/<org>/team/<id>/…`), so the id is the number after
 * the word. A folder is what Figma used to call a project, with the same id,
 * so `project:` and `/project/` links still read as folders (#549).
 */
export function parseFigmaAllowlist(text: string | null | undefined): FigmaAllowlist {
  const out: FigmaAllowlist = { teams: [], projects: [], invalid: [] };
  for (const entry of (text ?? '').split(/[\s,]+/).filter(Boolean)) {
    const match = /^(team|project|folder):(\d+)$/.exec(entry) ?? /^https:\/\/(?:www\.)?figma\.com\/files\/(?:[^/?#]+\/)*?(team|project|folder)\/(\d+)(?:[/?#]|$)/.exec(entry);
    if (!match) out.invalid.push(entry);
    else (match[1] === 'team' ? out.teams : out.projects).push(match[2]);
  }
  out.teams = [...new Set(out.teams)];
  out.projects = [...new Set(out.projects)];
  return out;
}

/** The typed-in token expiry against today: null when no valid date was entered. */
export function figmaTokenExpiry(value: string | null | undefined, now: Date = new Date()): 'ok' | 'soon' | 'expired' | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? '').trim());
  if (!match) return null;
  // The token works through the whole day it expires on, in UTC.
  const end = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1);
  if (Number.isNaN(end)) return null;
  const left = end - now.getTime();
  if (left <= 0) return 'expired';
  return left <= FIGMA_TOKEN_WARN_DAYS * 86_400_000 ? 'soon' : 'ok';
}

// ------------------------------------------------------------- snapshots

/**
 * What the reader can show for one pinned item (#470), derived on read:
 * `ready` — the snapshot is served; `rendering` — not yet, and queued;
 * `unavailable` — no Figma connector, or the file is outside its allowlist;
 * `failed` — Figma refused it, retried later.
 */
export const EMBED_ITEM_STATES = ['ready', 'rendering', 'unavailable', 'failed'] as const;
export type EmbedItemState = (typeof EMBED_ITEM_STATES)[number];

/** What the markdown itself got wrong, stored on `revision_embeds.warning`. */
export const EMBED_WARNINGS = ['unknown-provider', 'unpinned', 'over-limit'] as const;
export type EmbedWarning = (typeof EMBED_WARNINGS)[number];

// GET /v1/documents/:id/embeds
export interface EmbedItemStatus {
  fileKey: string;
  /** '' for a whole-file item. */
  nodeId: string;
  version: string;
  state: EmbedItemState;
  /** The frame's name in Figma, once rendered. */
  name: string | null;
  /** The node's size at 1×, for the tile's aspect ratio. */
  width: number | null;
  height: number | null;
  /**
   * The node itself changed in Figma since this version was pinned (its
   * subtree hash differs; edits elsewhere in the file do not count). Derived
   * from the connector's last change check, never stored.
   */
  changed: boolean;
}

export interface DocumentEmbedsResponse {
  items: EmbedItemStatus[];
}

/** The key one status row answers for: a pinned provider item. */
export function embedStatusKey(fileKey: string, nodeId: string | null, version: string): string {
  return `${fileKey}/${nodeId || '_'}/${version}`;
}

/** The snapshot route, relative to the API root; `_` stands for a whole-file item. */
export function embedSnapshotPath(documentId: string, fileKey: string, nodeId: string | null, version: string): string {
  return `/v1/documents/${documentId}/embeds/${encodeURIComponent(fileKey)}/${encodeURIComponent(nodeId || '_')}/${encodeURIComponent(version)}`;
}

// ---------------------------------------------------------------- picker

// GET /v1/embeds/figma/files?workspaceId=
export interface FigmaPickerFilesResponse {
  /** False when the workspace has no enabled Figma connector: the picker says so. */
  connected: boolean;
  files: Array<{ fileKey: string; name: string }>;
}

// GET /v1/embeds/figma/files/:fileKey?workspaceId=
export interface FigmaPickerFileResponse {
  fileKey: string;
  name: string;
  /** The file's current version: what a picked item pins. */
  version: string;
  board: boolean;
  pages: Array<{
    id: string;
    name: string;
    frames: Array<{ id: string; name: string; type: string; thumbnailUrl: string | null }>;
  }>;
}

// POST /v1/embeds/figma/resolve
export interface FigmaResolveRequest {
  workspaceId: string;
  url: string;
}

export interface FigmaResolveResponse {
  /** Canonical spelling of the pasted link. */
  url: string;
  /** The file's current version, pinned; null when the allowlist does not reach the file. */
  version: string | null;
  /** The node's (or file's) name in Figma, offered as the caption. */
  name: string | null;
  allowed: boolean;
}

// GET /v1/embeds/usages?workspaceId=&figmaUrl=|fileKey=
export interface EmbedUsagesResponse {
  pages: Array<{
    documentId: string;
    title: string;
    revisionId: string;
    /** Each matching group of the page's current version, with all of its items. */
    groups: Array<{ group: number; items: Array<{ url: string; caption: string; version: string | null }> }>;
  }>;
}
