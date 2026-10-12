// Public publishing (issue #77): share links today; published sites, versions
// and export follow in later phases and add their types here.
//
// Buildless package: no enums, no relative cross-file imports (see
// src/index.ts).

// ---------------------------------------------------------------------------
// Share links (docs/features/43)
// ---------------------------------------------------------------------------

/** Prefix of a share-link token. The plaintext is only ever in the URL. */
export const SHARE_TOKEN_PREFIX = 'kp_';

/** The expiry choices the share popover offers; `never` is gated (see `shareNeedsPassword`). */
export const SHARE_EXPIRY_PRESETS = ['1d', '7d', '30d', 'never'] as const;
export type ShareExpiryPreset = (typeof SHARE_EXPIRY_PRESETS)[number];

export const SHARE_PASSWORD_MIN_CHARS = 6;
export const SHARE_PASSWORD_MAX_CHARS = 200;

/** A share link as its page's editors and the workspace admins see it. */
export interface ShareLinkSummary {
  id: string;
  workspaceId: string;
  documentId: string;
  /** The shared page's title, for the admin inventory. */
  documentTitle: string;
  includeSubtree: boolean;
  /**
   * The link, when it can be shown again. Null when the server holds no
   * SETTINGS_ENCRYPTION_KEY: only the SHA-256 of the token is stored then, so
   * the link is shown once, at creation, and never again.
   */
  url: string | null;
  hasPassword: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
}

// GET /v1/documents/:id/shares
export interface ShareLinkListResponse {
  /** The page's live links (revoked ones are in the admin inventory only). */
  shares: ShareLinkSummary[];
  /** What the share popover may offer, resolved for the page's workspace. */
  policy: {
    /** Workspace switch under the env ceiling. Off: the popover explains instead of offering. */
    enabled: boolean;
    allowPasswordlessShares: boolean;
    /** SHARE_LINK_MAX_TTL_DAYS; 0 = no cap. */
    maxTtlDays: number;
  };
}

// GET /v1/workspaces/:id/shares
export interface WorkspaceShareLinksResponse {
  shares: ShareLinkSummary[];
}

// POST /v1/documents/:id/shares
export interface CreateShareLinkResponse {
  share: ShareLinkSummary;
  /** Always present here, even when `share.url` is null: this is the one time it is known. */
  url: string;
  /**
   * The expiry that was asked for, when SHARE_LINK_MAX_TTL_DAYS cut it
   * shorter. The env is a ceiling, and the UI shows both rather than letting
   * a silent clamp misreport what the link does.
   */
  requestedExpiresAt: string | null;
}

/** The workspace's publishing switches as stored: `null` inherits the code default. */
export interface PublishingSettingsOverride {
  allowShareLinks: boolean | null;
  /** Allow a link with neither a password nor an expiry. */
  allowPasswordlessShares: boolean | null;
  /** Allow publishing a project as a public docs site (docs/features/44). */
  allowPublicSites: boolean | null;
}

export interface PublishingSettingsValues {
  allowShareLinks: boolean;
  allowPasswordlessShares: boolean;
  allowPublicSites: boolean;
}

// GET/PATCH /v1/workspaces/:id/publishing-settings
export interface PublishingSettingsResponse {
  workspaceId: string;
  /** What applies: the override over the code default, under the env ceiling. */
  effective: PublishingSettingsValues;
  override: PublishingSettingsOverride;
  /** The deployment's ceiling, so the page can say why a switch it shows on still does nothing. */
  ceiling: {
    /** PUBLIC_SHARING_ENABLED */
    sharingEnabled: boolean;
    /** PUBLIC_SITES_ENABLED */
    sitesEnabled: boolean;
    /** SHARE_LINK_MAX_TTL_DAYS; 0 = no cap. */
    maxTtlDays: number;
  };
}

/** A link that never expires must carry a password unless the workspace allows otherwise. */
export function shareNeedsPassword(
  link: { expiresAt: string | Date | null; hasPassword: boolean },
  settings: Pick<PublishingSettingsValues, 'allowPasswordlessShares'>,
): boolean {
  return link.expiresAt === null && !link.hasPassword && !settings.allowPasswordlessShares;
}

/** `expiresAt` for a preset, from `now`. */
export function shareExpiryFor(preset: ShareExpiryPreset, now: Date = new Date()): Date | null {
  const days = preset === '1d' ? 1 : preset === '7d' ? 7 : preset === '30d' ? 30 : null;
  return days === null ? null : new Date(now.getTime() + days * 86_400_000);
}

// ---------------------------------------------------------------------------
// The anonymous reader (GET /v1/public/shares/…)
//
// Separate shapes from the member DTOs on purpose: nothing here carries an
// author, a revision id, frontmatter, comments or history, and a field added
// to a member DTO cannot leak through by accident.
// ---------------------------------------------------------------------------

export interface PublicShareTreeNode {
  documentId: string;
  /** Null for the shared page itself: the tree is rooted there. */
  parentId: string | null;
  title: string;
  position: number;
}

// GET /v1/public/shares/:token
export type PublicShareResponse =
  | { locked: true }
  | {
      locked: false;
      rootDocumentId: string;
      title: string;
      includeSubtree: boolean;
      /** The pages a reader can open, root first. Only the root when `includeSubtree` is false. */
      tree: PublicShareTreeNode[];
      /** True when the subtree was larger than the cap and the tree was cut short. */
      treeTruncated: boolean;
      expiresAt: string | null;
    };

// GET /v1/public/shares/:token/pages/:documentId
export interface PublicSharePage {
  documentId: string;
  title: string;
  /** The page body without frontmatter. */
  markdown: string;
  /** When the revision shown was published. */
  updatedAt: string | null;
}

/**
 * The public attachment route for an attachment path found in a shared page.
 * Pages store `/v1/documents/<doc>/attachments/<att>/content`; anonymous
 * readers cannot use that route, so the reader rewrites it to this one.
 */
export function publicShareAttachmentPath(token: string, attachmentId: string): string {
  return `/v1/public/shares/${encodeURIComponent(token)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** `{ documentId, attachmentId }` from a stored attachment path, or null for anything else. */
export function parseAttachmentPath(path: string): { documentId: string; attachmentId: string } | null {
  const m = /^\/v1\/documents\/([0-9a-fA-F-]{36})\/attachments\/([0-9a-fA-F-]{36})\/content(?:[?#].*)?$/.exec(path);
  return m ? { documentId: m[1], attachmentId: m[2] } : null;
}

// ---------------------------------------------------------------------------
// Published sites (issue #77 phase 2a, docs/features/44)
//
// A project published as a read-only docs site. Public routes read only a
// version's snapshot — `site_version_pages` rows pinning one revision per
// page — never a branch head, so a draft or a failed revision cannot leak and
// a frozen version stays frozen.
// ---------------------------------------------------------------------------

export const PUBLISHED_SITE_STATUSES = ['draft', 'live', 'unpublished'] as const;
export type PublishedSiteStatus = (typeof PUBLISHED_SITE_STATUSES)[number];

/** `live` follows its branch and rebuilds itself; `frozen` changes only when rebuilt by hand. */
export const SITE_VERSION_KINDS = ['live', 'frozen'] as const;
export type SiteVersionKind = (typeof SITE_VERSION_KINDS)[number];

/** The last build attempt. A version that once built keeps serving its snapshot through a rebuild or a failure. */
export const SITE_VERSION_STATUSES = ['building', 'ready', 'failed'] as const;
export type SiteVersionStatus = (typeof SITE_VERSION_STATUSES)[number];

/**
 * Why a page is not in a build as it stands on its branch:
 * - `headNotIndexed`: the head is not indexed (still indexing, or failed), so
 *   the newest indexed revision before it is published instead;
 * - `noIndexedRevision`: the branch has no indexed revision at all, so the page
 *   is left out (and its subpages hang from its nearest published ancestor);
 * - `pageLimit`: the site reached SITE_MAX_PAGES and the rest was cut.
 */
export const SITE_BUILD_WARNING_CODES = ['headNotIndexed', 'noIndexedRevision', 'pageLimit'] as const;
export type SiteBuildWarningCode = (typeof SITE_BUILD_WARNING_CODES)[number];

export interface SiteBuildWarning {
  code: SiteBuildWarningCode;
  /** Null for `pageLimit`, which is about the site rather than one page. */
  documentId: string | null;
  title: string | null;
}

/**
 * Font stacks a theme may pick. System stacks only: an anonymous reader's
 * browser makes no request to a third party on the site's behalf, so there is
 * no web font to load.
 */
export const SITE_FONTS = ['system', 'serif', 'rounded', 'mono'] as const;
export type SiteFont = (typeof SITE_FONTS)[number];
export const SITE_FONT_STACKS: Record<SiteFont, string> = {
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", Quicksand, Nunito, ui-sans-serif, system-ui, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
};

export const SITE_THEME_LIMITS = { headerLinks: 5, linkLabel: 40, linkUrl: 500, footerText: 500 } as const;

export interface SiteHeaderLink {
  label: string;
  /** Absolute http(s) URL. */
  url: string;
}

/**
 * A site's look. Values, never CSS: colours are hex, the font is a key into
 * SITE_FONT_STACKS, and the logo is the project's own avatar. No arbitrary CSS
 * or script, by design.
 */
export interface SiteTheme {
  /** `#rrggbb`; null keeps the app's own primary. */
  primaryColor: string | null;
  /** `#rrggbb` for dark mode; null reuses `primaryColor`. */
  primaryColorDark: string | null;
  font: SiteFont;
  /** Show the project's avatar beside the site title. */
  showLogo: boolean;
  headerLinks: SiteHeaderLink[];
  /** Plain text under every page; null for none. */
  footerText: string | null;
}

export const DEFAULT_SITE_THEME: SiteTheme = {
  primaryColor: null,
  primaryColorDark: null,
  font: 'system',
  showLogo: true,
  headerLinks: [],
  footerText: null,
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Any stored or submitted theme, reduced to a valid `SiteTheme`. Unknown keys
 * are dropped and an invalid value falls back to the default, so a row written
 * by an older build, or edited by hand, still renders. The API also refuses an
 * invalid theme outright on write (`siteThemeErrors`); this is the reader's
 * belt to that brace.
 */
export function normalizeSiteTheme(input: unknown): SiteTheme {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const links = Array.isArray(raw.headerLinks) ? raw.headerLinks : [];
  return {
    primaryColor: isHexColor(raw.primaryColor) ? raw.primaryColor.toLowerCase() : null,
    primaryColorDark: isHexColor(raw.primaryColorDark) ? raw.primaryColorDark.toLowerCase() : null,
    font: (SITE_FONTS as readonly string[]).includes(raw.font as string) ? (raw.font as SiteFont) : 'system',
    showLogo: typeof raw.showLogo === 'boolean' ? raw.showLogo : DEFAULT_SITE_THEME.showLogo,
    headerLinks: links
      .filter(
        (l): l is SiteHeaderLink =>
          !!l &&
          typeof (l as SiteHeaderLink).label === 'string' &&
          typeof (l as SiteHeaderLink).url === 'string' &&
          (l as SiteHeaderLink).label.trim().length > 0 &&
          (l as SiteHeaderLink).label.length <= SITE_THEME_LIMITS.linkLabel &&
          (l as SiteHeaderLink).url.length <= SITE_THEME_LIMITS.linkUrl &&
          isHttpUrl((l as SiteHeaderLink).url),
      )
      .slice(0, SITE_THEME_LIMITS.headerLinks)
      .map((l) => ({ label: l.label.trim(), url: l.url })),
    footerText:
      typeof raw.footerText === 'string' && raw.footerText.trim()
        ? raw.footerText.trim().slice(0, SITE_THEME_LIMITS.footerText)
        : null,
  };
}

/** What is wrong with a submitted theme, as field names; empty when it is valid. */
export function siteThemeErrors(input: Partial<SiteTheme>): string[] {
  const errors: string[] = [];
  if (input.primaryColor != null && !isHexColor(input.primaryColor)) errors.push('primaryColor');
  if (input.primaryColorDark != null && !isHexColor(input.primaryColorDark)) errors.push('primaryColorDark');
  if (input.font !== undefined && !(SITE_FONTS as readonly string[]).includes(input.font)) errors.push('font');
  if (input.headerLinks !== undefined) {
    const links = input.headerLinks;
    if (!Array.isArray(links) || links.length > SITE_THEME_LIMITS.headerLinks) errors.push('headerLinks');
    else if (normalizeSiteTheme({ headerLinks: links }).headerLinks.length !== links.length) errors.push('headerLinks');
  }
  if (input.footerText != null && (typeof input.footerText !== 'string' || input.footerText.length > SITE_THEME_LIMITS.footerText)) {
    errors.push('footerText');
  }
  return errors;
}

/**
 * A site's slug is a DNS label (`<slug>.PUBLISH_BASE_DOMAIN`) as well as a
 * path segment (`/pub/<slug>`): lowercase ASCII letters, digits and inner
 * hyphens, 2–40 characters.
 */
const SITE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38})[a-z0-9]$/;

/** Labels a site may not take: they name the platform's own hosts, or would read as if they did. */
export const RESERVED_SITE_SLUGS = [
  'www', 'api', 'app', 'admin', 'pub', 'static', 'assets', 'cdn', 'mail', 'smtp', 'status', 'auth', 'login',
  'account', 'accounts', 'dashboard', 'settings', 'knowledge', 'internal', 'localhost',
] as const;

export function isValidSiteSlug(slug: string): boolean {
  return SITE_SLUG_RE.test(slug) && !slug.includes('--') && !(RESERVED_SITE_SLUGS as readonly string[]).includes(slug);
}

const CYRILLIC_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * A slug suggestion for a project name: transliterated, ASCII, hyphenated.
 * Only a suggestion; `isValidSiteSlug` decides, and an empty result means the
 * name gave nothing to work with.
 */
export function suggestSiteSlug(name: string): string {
  const ascii = name
    .toLowerCase()
    .split('')
    .map((ch) => CYRILLIC_LATIN[ch] ?? ch)
    .join('')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  return ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** A version's URL segment, e.g. `v1.2`, `next`: lowercase letters, digits, dots and hyphens. */
const VERSION_SLUG_RE = /^[a-z0-9](?:[a-z0-9.-]{0,30}[a-z0-9])?$/;

export function isValidVersionSlug(slug: string): boolean {
  return VERSION_SLUG_RE.test(slug);
}

/** A version slug from its display name: `V1.2 (LTS)` → `v1.2-lts`. */
export function suggestVersionSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 32)
    .replace(/[-.]+$/g, '');
}

/**
 * A heading id from a heading (the web's `slugifyHeading`), and the base of a
 * site page's URL segment from its title (the API's site builder, which also
 * tidies hyphen runs). One function, so the two never drift on what a slug
 * may contain. Unicode letters survive — a Russian title keeps a Russian URL;
 * punctuation does not.
 */
export function slugifyPath(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

/**
 * The URL of a site's root. With PUBLISH_BASE_DOMAIN set, a subdomain on the
 * scheme WEB_BASE_URL uses; without it, path mode under the app's own origin.
 */
export function siteRootUrl(slug: string, opts: { baseDomain: string; webBaseUrl: string }): string {
  const web = opts.webBaseUrl.replace(/\/+$/, '');
  if (opts.baseDomain) {
    const scheme = web.startsWith('http://') ? 'http' : 'https';
    const port = (() => {
      try {
        const u = new URL(web);
        return u.port ? `:${u.port}` : '';
      } catch {
        return '';
      }
    })();
    return `${scheme}://${slug}.${opts.baseDomain}${port}`;
  }
  return `${web}${SITE_PATH_PREFIX}${slug}`;
}

/** Path-mode prefix: `/pub/<slug>/…`, for dev and single-domain installs. */
export const SITE_PATH_PREFIX = '/pub/';

/**
 * The path of a page on a site, below the site's root prefix (`''` on a site's
 * own host, `/pub/<slug>` in path mode). The default version has no segment of
 * its own; any other version's slug comes first.
 */
export function sitePagePath(prefix: string, versionSlug: string | null, slugPath: string): string {
  const parts = [versionSlug, ...slugPath.split('/')].filter((p): p is string => !!p).map(encodeURIComponent);
  return `${prefix}/${parts.join('/')}`;
}

export interface SiteVersionSummary {
  id: string;
  name: string;
  slug: string;
  kind: SiteVersionKind;
  /** The branch name each page is read from; null = each page's default branch. A page without it falls back to its default. */
  sourceBranch: string | null;
  status: SiteVersionStatus;
  /** When the snapshot being served was built; null until the first build succeeds. */
  builtAt: string | null;
  pageCount: number;
  warnings: SiteBuildWarning[];
  error: string | null;
  isDefault: boolean;
  createdAt: string;
}

export interface PublishedSiteSummary {
  id: string;
  workspaceId: string;
  projectId: string;
  slug: string;
  status: PublishedSiteStatus;
  /** Null publishes the whole project; otherwise that page and its subpages. */
  rootDocumentId: string | null;
  rootDocumentTitle: string | null;
  theme: SiteTheme;
  seoIndexable: boolean;
  defaultVersionId: string | null;
  /** Where the site is (or would be) served. */
  url: string;
  versions: SiteVersionSummary[];
  createdAt: string;
  updatedAt: string;
}

// GET /v1/projects/:id/site
export interface ProjectSiteResponse {
  site: PublishedSiteSummary | null;
  policy: {
    /** Workspace switch under the env ceiling. Off: the site can be configured but not published, and a live one 404s. */
    enabled: boolean;
    /** PUBLIC_SITES_ENABLED */
    ceiling: boolean;
    /** PUBLISH_BASE_DOMAIN, or null in path mode. */
    baseDomain: string | null;
    /** A suggestion for a new site, from the project name. */
    suggestedSlug: string;
  };
}

// ---------------------------------------------------------------------------
// The anonymous site reader (GET /v1/public/sites/…). Like the share shapes:
// nothing here carries an author, a revision id, frontmatter or history.
// ---------------------------------------------------------------------------

export interface PublicSiteTreeNode {
  documentId: string;
  /** Null for a top-level page of the site. */
  parentId: string | null;
  title: string;
  /** `guides/install`; `''` for the root page of a site published from one page. */
  slugPath: string;
  position: number;
}

export interface PublicSiteVersionRef {
  slug: string;
  name: string;
  isDefault: boolean;
}

export type PublicSiteLogo =
  | { kind: 'image'; url: string }
  | { kind: 'emoji'; emoji: string; color: string | null }
  | null;

export interface PublicSitePage {
  documentId: string;
  title: string;
  /** Canonical; a request for any other path that resolved here should redirect to it. */
  slugPath: string;
  /** The page body without frontmatter. */
  markdown: string;
  /** When the published revision was finalized. */
  updatedAt: string | null;
}

// GET /v1/public/sites/resolve?slug=|host=&path=&from=
export interface PublicSiteResolveResponse {
  site: {
    id: string;
    slug: string;
    title: string;
    theme: SiteTheme;
    seoIndexable: boolean;
    logo: PublicSiteLogo;
    /** Absolute URL of the site root, for canonical links. */
    rootUrl: string;
  };
  version: PublicSiteVersionRef & { id: string; builtAt: string };
  versions: PublicSiteVersionRef[];
  tree: PublicSiteTreeNode[];
  /** Null when the site and version exist but no page answers the path: a 404 inside the site's chrome. */
  page: PublicSitePage | null;
}

/** The public attachment route for an attachment of a page in a version's snapshot. */
export function publicSiteAttachmentPath(siteId: string, versionId: string, attachmentId: string): string {
  return `/v1/public/sites/${encodeURIComponent(siteId)}/versions/${encodeURIComponent(versionId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
