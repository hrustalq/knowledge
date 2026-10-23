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

const FIGMA_HOSTS = new Set(['figma.com', 'www.figma.com']);
const FIGMA_KINDS = new Set(['design', 'file', 'proto', 'board']);
const FIGMA_KEY_RE = /^[A-Za-z0-9]{10,64}$/;
const FIGMA_NODE_RE = /^[A-Za-z0-9:;-]{1,200}$/;

/**
 * The one matcher every surface calls — the paste rule, the parse rule, the
 * importers, the connectors and the API's warnings — so they cannot disagree
 * about what is embeddable. Design, prototype, Dev Mode, legacy `/file/` and
 * FigJam board links; a branch link's branch key is the file key, because that
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
