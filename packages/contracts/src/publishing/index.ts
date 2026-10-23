// Public publishing (issue #77): share links, published sites with their
// versions and domains, and export.
//
// Buildless package: no enums, no relative cross-file imports (see
// src/index.ts).

import type { Locale } from '@knowledge/contracts/core';

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
  /** Readers may download an export of the link's scope (#161). */
  allowDownload: boolean;
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
  /**
   * Show embedded designs' snapshots on share links and published sites
   * (#470, docs/features/64). Off shows captions and a placeholder; on or off,
   * a public page never carries a Figma link, which would reveal the file key.
   */
  allowPublicEmbeds: boolean | null;
}

export interface PublishingSettingsValues {
  allowShareLinks: boolean;
  allowPasswordlessShares: boolean;
  allowPublicSites: boolean;
  allowPublicEmbeds: boolean;
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
      /** What the reader may download (#161); null when the link has download off. */
      download: PublicShareDownloadOffer | null;
    };

/** The formats a share link's reader may export the link's scope as (#161). */
export interface PublicShareDownloadOffer {
  /** `pdf` is false without GOTENBERG_URL — shown disabled, never hidden. */
  formats: Record<ExportFormat, boolean>;
  /** How long a finished file stays downloadable. */
  ttlHours: number;
}

/**
 * A reader's export through a share link (#161): its own shape, not
 * `ExportJobSummary`, so no workspace, page or person id reaches the reader.
 */
export interface PublicShareExport {
  id: string;
  format: ExportFormat;
  status: ExportStatus;
  stage: ExportStage | null;
  pageCount: number | null;
  sizeBytes: number | null;
  error: { code: ExportErrorCode; message: string } | null;
  createdAt: string;
  expiresAt: string | null;
}

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

/** A share link's exports (#161): POST here to ask for one. */
export function publicShareExportsPath(token: string): string {
  return `/v1/public/shares/${encodeURIComponent(token)}/exports`;
}

/** One of a share link's exports, polled while it runs; `/download` 302s to the finished file. */
export function publicShareExportPath(token: string, exportId: string, download = false): string {
  return `${publicShareExportsPath(token)}/${encodeURIComponent(exportId)}${download ? '/download' : ''}`;
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
 * The URL of a site's root. A verified custom domain wins (it is the name the
 * owner chose, so canonical links use it); then a subdomain of
 * PUBLISH_BASE_DOMAIN; without either, path mode under the app's own origin.
 * The scheme follows WEB_BASE_URL, so a plain-http dev stack links plain http.
 */
export function siteRootUrl(slug: string, opts: { baseDomain: string; webBaseUrl: string; domain?: string | null }): string {
  const web = opts.webBaseUrl.replace(/\/+$/, '');
  const scheme = web.startsWith('http://') ? 'http' : 'https';
  if (opts.domain) return `${scheme}://${opts.domain}`;
  if (opts.baseDomain) {
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

/**
 * The plain-markdown URL of a page, below the site's root prefix: its slug
 * path plus `.md` (the home keeps its own slug here, so `/welcome.md` works
 * beside `/`). A page at slug path `''` — the root of a site published from
 * one page — is `index.md` under its version.
 */
export function siteMarkdownPath(prefix: string, versionSlug: string | null, slugPath: string): string {
  if (!slugPath) return `${sitePagePath(prefix, versionSlug, '').replace(/\/$/, '')}/index.md`;
  return `${sitePagePath(prefix, versionSlug, slugPath)}.md`;
}

/**
 * A site's home page: the root page of a site published from one page (slug
 * path `''`), otherwise the first top-level page in reading order. The API's
 * resolve, its sitemap and llms.txt, and the web reader all ask this, so a
 * page never has one URL in the nav and another in the sitemap.
 */
export function siteHomeDocumentId(
  tree: ReadonlyArray<{ documentId: string; parentId: string | null; slugPath: string; position: number }>,
): string | null {
  return (
    tree.find((n) => n.slugPath === '')?.documentId ??
    tree.filter((n) => n.parentId === null).sort((a, b) => a.position - b.position)[0]?.documentId ??
    null
  );
}

// ---------------------------------------------------------------------------
// Custom domains (issue #77 phase 2b)
//
// A site may also answer on hostnames its owner controls. A name is served
// only once proven: a TXT record at `_knowledge.<hostname>` holding the
// domain's token. Unique across the deployment.
// ---------------------------------------------------------------------------

/** Most hostnames one site may claim. */
export const SITE_MAX_DOMAINS = 5;

/** The TXT record proving control of `<hostname>` lives at `<label>.<hostname>`. */
export const SITE_DOMAIN_TXT_LABEL = '_knowledge';
/** …and holds `<prefix><token>`. */
export const SITE_DOMAIN_TXT_PREFIX = 'knowledge-site-verification=';

/**
 * Why the last check did not verify a domain:
 * - `txtMissing`: DNS answered, and no record carries our prefix;
 * - `txtMismatch`: a record carries our prefix, with another token;
 * - `dnsError`: DNS did not answer (timeout, SERVFAIL); tried again later.
 */
export const SITE_DOMAIN_CHECK_ERRORS = ['txtMissing', 'txtMismatch', 'dnsError'] as const;
export type SiteDomainCheckError = (typeof SITE_DOMAIN_CHECK_ERRORS)[number];

const HOST_LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * A hostname as typed or pasted (`Docs.Acme.com.`, `https://docs.acme.com/`,
 * `документы.рф`), reduced to the one spelling the platform stores and
 * compares: lower-case ASCII (IDNA), no scheme, path, port or trailing dot.
 * Null for anything that is not a public DNS name: one label, an IP address,
 * a port, credentials.
 */
export function normalizeHostname(raw: string): string | null {
  let value = raw.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.replace(/[/?#].*$/, '').replace(/\.$/, '');
  if (!value || /[:@\s\\]/.test(value)) return null;
  let host: string;
  try {
    host = new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
  if (host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => HOST_LABEL_RE.test(l))) return null;
  // An all-digit last label is an IPv4 address, never a TLD.
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return null;
  return host;
}

export interface SiteDomainSummary {
  id: string;
  hostname: string;
  /** Served, and given a certificate, only once verified. */
  verified: boolean;
  verifiedAt: string | null;
  lastCheckAt: string | null;
  lastError: SiteDomainCheckError | null;
  /** The TXT record to create: its name… */
  txtName: string;
  /** …and its value. */
  txtValue: string;
  /** Where the hostname's CNAME (or A record) should point: this deployment's site host for the site. */
  dnsTarget: string;
  createdAt: string;
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
  /** Where the site is (or would be) served: its first verified domain, else its subdomain or path. */
  url: string;
  versions: SiteVersionSummary[];
  /** Its own hostnames, oldest first (issue #77 phase 2b). */
  domains: SiteDomainSummary[];
  /** The Ask widget (issue #77 phase 3). */
  ask: SiteAskSettings;
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
    /** SITE_CUSTOM_DOMAINS: whether this deployment routes custom hostnames at all. */
    customDomains: boolean;
    /** A suggestion for a new site, from the project name. */
    suggestedSlug: string;
    /** PUBLIC_ASK_DAILY_BUDGET: the most answers a day any site may give; 0 turns Ask off everywhere. */
    askDailyCeiling: number;
    /** The workspace has a model configured, so Ask can answer at all. */
    askModelConfigured: boolean;
  };
}

// ---------------------------------------------------------------------------
// Audiences (issue #77 phase 3, docs/features/44)
//
// A site can keep pages from the public. A rule on a page restricts it and
// everything below it to `members` (anyone with a role in the workspace,
// signed in through the app) or `visitors` (a person the customer's own
// backend vouches for with a signed JWT, optionally only when its claims
// match). Rules only restrict, and they add up down the tree, so a subpage is
// never more open than its parent: its URL, which carries the parent's slug,
// and its place in the nav could not be shown without the parent.
//
// Every version's snapshot rows carry the folded result (`audience` +
// `audienceClaims`), restamped whenever a rule changes, so a reader filters
// on the row alone and a frozen version follows the rules of today.
// ---------------------------------------------------------------------------

/** Who a snapshot row is shown to. `public` is the absence of any rule above it. */
export const SITE_AUDIENCES = ['public', 'visitors', 'members'] as const;
export type SiteAudience = (typeof SITE_AUDIENCES)[number];

/** What a rule may ask for. `public` is not a rule: removing the rules is. */
export const SITE_AUDIENCE_RULE_KINDS = ['visitors', 'members'] as const;
export type SiteAudienceRuleKind = (typeof SITE_AUDIENCE_RULE_KINDS)[number];

/**
 * Claim requirements of a `visitors` rule: each key must be in the visitor's
 * JWT with a value (or, for an array claim, any element) among the listed
 * ones, e.g. `{ "plan": ["pro", "enterprise"] }`. Null or `{}`: any valid
 * token will do.
 */
export type SiteAudienceClaims = Record<string, string[]>;

export const SITE_AUDIENCE_CLAIM_LIMITS = { keys: 10, values: 50, keyChars: 64, valueChars: 200 } as const;
const CLAIM_KEY = /^[A-Za-z0-9_.:-]+$/;

/**
 * Who is reading. `member` is a workspace member signed in through the app,
 * and sees every page; `visitor` carries the claims of the JWT it signed in
 * with.
 */
export type SiteViewer =
  | { kind: 'anonymous' }
  | { kind: 'member' }
  | { kind: 'visitor'; claims: Record<string, unknown> };

export type SiteViewerKind = SiteViewer['kind'];

/** Why a claims object is refused, as field paths; empty when it is fine. */
export function siteAudienceClaimsErrors(input: unknown): string[] {
  if (input === null || input === undefined) return [];
  if (typeof input !== 'object' || Array.isArray(input)) return ['claims'];
  const entries = Object.entries(input as Record<string, unknown>);
  const errors: string[] = [];
  if (entries.length > SITE_AUDIENCE_CLAIM_LIMITS.keys) errors.push('claims');
  for (const [key, values] of entries) {
    if (!key || key.length > SITE_AUDIENCE_CLAIM_LIMITS.keyChars || !CLAIM_KEY.test(key)) errors.push(`claims.${key}`);
    else if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > SITE_AUDIENCE_CLAIM_LIMITS.values ||
      values.some((v) => typeof v !== 'string' || !v.trim() || v.length > SITE_AUDIENCE_CLAIM_LIMITS.valueChars)
    ) {
      errors.push(`claims.${key}`);
    }
  }
  return errors;
}

/** Trimmed, deduplicated and key-sorted; null when nothing is required. Assumes `siteAudienceClaimsErrors` passed. */
export function normalizeAudienceClaims(input: unknown): SiteAudienceClaims | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: SiteAudienceClaims = {};
  for (const key of Object.keys(input).sort()) {
    const values = (input as Record<string, unknown>)[key];
    if (!Array.isArray(values)) continue;
    const kept = [...new Set(values.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean))];
    if (kept.length) out[key] = kept;
  }
  return Object.keys(out).length ? out : null;
}

/** Both sets of requirements at once: a key in both keeps only the values both allow (possibly none, which nobody matches). */
export function mergeAudienceClaims(a: SiteAudienceClaims | null, b: SiteAudienceClaims | null): SiteAudienceClaims | null {
  if (!a) return b;
  if (!b) return a;
  const out: SiteAudienceClaims = { ...a };
  for (const [key, values] of Object.entries(b)) out[key] = key in out ? out[key].filter((v) => values.includes(v)) : values;
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => x.localeCompare(y)));
}

/** Does a visitor's token satisfy the requirements? Only string, number and boolean claim values compare. */
export function audienceClaimsMatch(required: SiteAudienceClaims | null | undefined, claims: Record<string, unknown>): boolean {
  if (!required) return true;
  for (const [key, allowed] of Object.entries(required)) {
    const raw = claims[key];
    const values = Array.isArray(raw) ? raw : [raw];
    const ok = values.some((v) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && allowed.includes(String(v)));
    if (!ok) return false;
  }
  return true;
}

export interface SiteAudienceRuleInput {
  audience: SiteAudienceRuleKind;
  claims: SiteAudienceClaims | null;
}

/** A row's stamp: the strictest audience on its way down from the top, with every `visitors` rule's claims combined. */
export interface SiteAudienceStamp {
  audience: SiteAudience;
  claims: SiteAudienceClaims | null;
}

const AUDIENCE_RANK: Record<SiteAudience, number> = { public: 0, visitors: 1, members: 2 };

/**
 * Fold the rules met on a page's path (`documents.path` ids, top first,
 * the page itself last) into its stamp. `members` outranks `visitors`, which
 * outranks `public`; claims are only kept while the stamp is `visitors`.
 */
export function foldSiteAudience(pathIds: readonly string[], rules: ReadonlyMap<string, SiteAudienceRuleInput>): SiteAudienceStamp {
  let audience: SiteAudience = 'public';
  let claims: SiteAudienceClaims | null = null;
  for (const id of pathIds) {
    const rule = rules.get(id);
    if (!rule) continue;
    if (AUDIENCE_RANK[rule.audience] > AUDIENCE_RANK[audience]) audience = rule.audience;
    if (rule.audience === 'visitors') claims = mergeAudienceClaims(claims, rule.claims);
  }
  return { audience, claims: audience === 'visitors' ? claims : null };
}

/** May this viewer read a row with this stamp? */
export function siteViewerCanSee(stamp: { audience: string; audienceClaims?: unknown }, viewer: SiteViewer): boolean {
  if (stamp.audience === 'public') return true;
  if (viewer.kind === 'member') return true;
  if (stamp.audience === 'visitors' && viewer.kind === 'visitor') {
    return audienceClaimsMatch((stamp.audienceClaims ?? null) as SiteAudienceClaims | null, viewer.claims);
  }
  return false;
}

export interface SiteAudienceRule {
  documentId: string;
  documentTitle: string;
  audience: SiteAudienceRuleKind;
  claims: SiteAudienceClaims | null;
  updatedAt: string;
}

// GET /v1/sites/:id/audiences
export interface SiteAudiencesResponse {
  rules: SiteAudienceRule[];
  visitorAuth: {
    /** A JWT secret is set: visitor sign-in works. */
    configured: boolean;
    setAt: string | null;
    /** SETTINGS_ENCRYPTION_KEY is set, so a secret can be stored at all. */
    canStore: boolean;
  };
  /** How long a sign-in lasts, SITE_VISITOR_TTL_MIN. */
  sessionTtlMinutes: number;
}

// POST /v1/sites/:id/visitor-secret — the only time the secret is shown.
export interface SiteVisitorSecretResponse {
  secret: string;
  setAt: string;
}

// POST /v1/sites/:id/sign-in
export interface SiteSignInResponse {
  /** Where to send the browser: the site's own session route, carrying a one-time code. */
  url: string;
}

/** The cookie a site's sign-in sets on the site's own origin. */
export function siteSessionCookieName(siteId: string): string {
  return `kn_site_${siteId}`;
}

/** The query parameter a customer's backend appends to any site URL to sign a visitor in. */
export const SITE_VISITOR_TOKEN_PARAM = 'jwt_token';

/** The site's session route, on whatever origin the reader is on (Caddy and Vite strip `/api`). */
export function publicSiteSessionPath(siteId: string): string {
  return `/v1/public/sites/${encodeURIComponent(siteId)}/session`;
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
  /**
   * Children of this page the viewer may see. The tree arrives a level at a
   * time (issue #204), so a branch whose children have not been sent yet still
   * knows to draw itself as a branch.
   */
  childCount: number;
}

/** A page named by the reader's chrome: enough to link to it. */
export interface PublicSitePageRef {
  documentId: string;
  title: string;
  slugPath: string;
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
  /**
   * The same page in the site's other built versions: each version and the
   * page's path there below the site root (the home is the version root).
   * Drives `<link rel="alternate">` and lets the switcher link straight to it.
   */
  alternates: { version: PublicSiteVersionRef; path: string }[];
  /** The pages before and after this one in reading order (depth first), among those the viewer may see. */
  prev: PublicSitePageRef | null;
  next: PublicSitePageRef | null;
  /**
   * Where the pages this body links to live, for those the viewer may see. The
   * tree no longer names every page, so the reader rewrites `/documents/<id>`
   * links from this; a link to any other page is unlinked.
   */
  links: { documentId: string; slugPath: string }[];
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
    /**
     * Some pages of this version are not public (issue #77 phase 3): the
     * reader offers members a way to sign in. Says nothing about which pages.
     */
    restricted: boolean;
    /** The app page that signs a member in to this site; the reader appends `return`. Null when nothing is restricted. */
    signInUrl: string | null;
    /** The site answers questions (issue #77 phase 3): the reader offers Ask. */
    ask: boolean;
  };
  /** Who the API read this as: decides what `tree` and `page` contain. */
  viewer: SiteViewerKind;
  version: PublicSiteVersionRef & { id: string; builtAt: string };
  versions: PublicSiteVersionRef[];
  /**
   * The top level, plus the children of every page on the path to the current
   * one: what the reader's nav draws before anyone expands a branch (issue
   * #204). Deeper levels come from the tree route.
   */
  tree: PublicSiteTreeNode[];
  /** Null when the site and version exist but no page answers the path: a 404 inside the site's chrome. */
  page: PublicSitePage | null;
}

// GET /v1/public/sites/:siteId/tree?parent=&version= (issue #204)
export interface PublicSiteTreeResponse {
  /** One level: the children of `parent` (the top level without it) the viewer may see, in reading order. */
  nodes: PublicSiteTreeNode[];
}

/** The tree route of a site; `parent` is a page id (omitted for the top level), `version` a version slug. */
export function publicSiteTreePath(siteId: string): string {
  return `/v1/public/sites/${encodeURIComponent(siteId)}/tree`;
}

// GET /v1/public/sites/:siteId/search?q=&version=&category=&tag= (issue #77 phase 2b-2, #205)

/** Shorter queries answer nothing: one letter matches most of a site. */
export const SITE_SEARCH_MIN_CHARS = 2;
export const SITE_SEARCH_MAX_CHARS = 200;
export const SITE_SEARCH_MAX_RESULTS = 20;
/** Values one facet filter may carry (`category=a&category=b`); any of them matches. */
export const SITE_SEARCH_MAX_FILTER_VALUES = 20;

/**
 * Every query parameter the search route reads. The reader's facets are the
 * ones a snapshot carries, so anything else — a workspace, a project, a mode —
 * is refused rather than silently ignored.
 */
export const SITE_SEARCH_PARAMS = ['q', 'version', 'category', 'tag'] as const;

/** A tag as a published page carries it: `key` is what a filter sends (`tag:billing`), `name` the author's spelling. */
export interface SiteSearchTag {
  key: string;
  name: string;
}

/** A run of snippet text. `hit` marks words the query matched; the reader highlights them, never as HTML. */
export interface PublicSiteSearchSnippetPart {
  text: string;
  hit: boolean;
}

export interface PublicSiteSearchResult {
  documentId: string;
  title: string;
  slugPath: string;
  /** Empty when the page has no body text; the title matched. */
  snippet: PublicSiteSearchSnippetPart[];
  /** As the version was built (#205). Free text, like `documents.category`. */
  category: string;
  tags: SiteSearchTag[];
}

export interface PublicSiteSearchResponse {
  results: PublicSiteSearchResult[];
}

/** The search route of a site; `version` is a version slug, omitted for the default. */
export function publicSiteSearchPath(siteId: string): string {
  return `/v1/public/sites/${encodeURIComponent(siteId)}/search`;
}

// GET /v1/public/sites/:siteId/facets?version= (#205)

/**
 * What the reader's filter rail offers: the categories and tags of the pages
 * this viewer may read in this version, most common first. Nothing is offered
 * that would filter to an empty result before a word is typed.
 */
export interface PublicSiteFacetsResponse {
  categories: { value: string; count: number }[];
  tags: (SiteSearchTag & { count: number })[];
}

export function publicSiteFacetsPath(siteId: string): string {
  return `/v1/public/sites/${encodeURIComponent(siteId)}/facets`;
}

// ---------------------------------------------------------------------------
// Ask (issue #77 phase 3, docs/features/44)
//
// A site may answer questions from its own published pages: in its reader,
// and in a widget other sites embed (`<script src="<site>/widget.js">`). The
// answer is one model call over passages retrieved from the version's
// snapshot only, the passages the viewer may read, with every citation
// settled server-side against what was retrieved. Nothing is stored; each
// answer counts against the site's daily budget.
// ---------------------------------------------------------------------------

export const SITE_ASK_MIN_CHARS = 3;
export const SITE_ASK_MAX_CHARS = 500;
/** The most sites that may frame the widget. */
export const SITE_EMBED_ORIGINS_MAX = 20;
/** The highest per-site daily budget an admin may ask for; the env ceiling still applies. */
export const SITE_ASK_BUDGET_MAX = 100_000;

export interface SiteAskSettings {
  enabled: boolean;
  /** Answers a day this site asks for; null takes PUBLIC_ASK_DAILY_BUDGET. */
  dailyBudget: number | null;
  /** What applies: the asked budget under the env ceiling. 0 = Ask does not answer. */
  effectiveDailyBudget: number;
  /** Origins allowed to frame the widget (`Content-Security-Policy: frame-ancestors`). */
  embedOrigins: string[];
}

/** The budget that applies: what the site asks for (null = the ceiling), never above the ceiling. */
export function effectiveSiteAskBudget(asked: number | null, ceiling: number): number {
  return Math.max(0, Math.min(asked ?? ceiling, ceiling));
}

/**
 * An embed origin as stored: `scheme://host[:port]`, lower-cased, nothing
 * after it. https only, except plain http on a loopback host for local
 * testing. Null for anything else, so a path, a wildcard or a pasted page URL
 * with a query is refused rather than guessed at — except that a pasted page
 * URL is reduced to its origin, which is what anyone pasting one means.
 */
export function normalizeEmbedOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 300 || /[\s*'"]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  if (!url.hostname.includes('.') && !loopback) return null;
  return url.origin.toLowerCase();
}

// POST /v1/public/sites/:siteId/ask
export interface PublicSiteAskRequest {
  question: string;
  /** A version slug; omitted = the default version. */
  version?: string;
}

/** A passage an answer rests on, as a public page of the site. */
export interface PublicSiteAskSource {
  /** `S1`, `S2`, …: the label the answer's `[S#]` markers name. */
  cite: string;
  documentId: string;
  title: string;
  /** Headings above the passage, outermost first; the reader links to the last one's anchor. */
  headingPath: string[];
  /** The page's absolute URL on the site, without an anchor. */
  url: string;
}

export interface PublicSiteAskResponse {
  /** Markdown with `[S#]` markers, each naming one of `sources`; empty when nothing on the site matched. */
  answer: string;
  /** The sources the answer cites, in label order. */
  sources: PublicSiteAskSource[];
}

/** The Ask route of a site. */
export function publicSiteAskPath(siteId: string): string {
  return `/v1/public/sites/${encodeURIComponent(siteId)}/ask`;
}

// GET /v1/public/sites/widget?slug=|host= — what the widget's frame needs.
export interface PublicSiteWidgetResponse {
  site: {
    id: string;
    title: string;
    theme: SiteTheme;
    logo: PublicSiteLogo;
    rootUrl: string;
  };
  /** The origins that may frame it; the site's own are always allowed. */
  embedOrigins: string[];
}

/** The path below a site root that serves the widget's frame. A top-level page slugged `_widget` is shadowed by it. */
export const SITE_WIDGET_PATH = '/_widget';

/** The public attachment route for an attachment of a page in a version's snapshot. */
export function publicSiteAttachmentPath(siteId: string, versionId: string, attachmentId: string): string {
  return `/v1/public/sites/${encodeURIComponent(siteId)}/versions/${encodeURIComponent(versionId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

// ---------------------------------------------------------------------------
// Export (issue #77 phase 2c, docs/features/45)
//
// A page, a page and its subpages, or a whole project, written out as a file a
// member downloads: markdown sources in a ZIP, an offline HTML bundle, a PDF
// or a Word document. The worker collects and packages; the web renders the
// HTML (`renderExport`, apps/web), and the worker writes the Word document
// from the same parser's tokens (`markdownTokens`, @knowledge/editor-schema).
// ---------------------------------------------------------------------------

export const EXPORT_SCOPES = ['page', 'subtree', 'project'] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];

/**
 * What an export can be written as. `pdf` needs a Gotenberg sidecar
 * (GOTENBERG_URL); the others need nothing beyond the worker. `docx` is
 * written by the worker itself from the parser's tokens (#162), because
 * Gotenberg converts only *to* PDF.
 */
export const EXPORT_FORMATS = ['zip', 'html', 'pdf', 'docx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** queued → running → completed | failed; a completed file becomes `expired` after EXPORT_TTL_HOURS. */
export const EXPORT_STATUSES = ['queued', 'running', 'completed', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** Still in flight: the exports page polls while any row says so. */
export function isActiveExportStatus(status: string): boolean {
  return status === 'queued' || status === 'running';
}

/** What the worker is doing right now, as a message key under `export.stage.*` (web) — never free text. */
export const EXPORT_STAGES = ['collecting', 'rendering', 'converting', 'packaging'] as const;
export type ExportStage = (typeof EXPORT_STAGES)[number];

/** Why an export failed, as a key the web translates; `message` carries the detail. */
export const EXPORT_ERROR_CODES = ['tooLarge', 'renderFailed', 'convertFailed', 'formatUnavailable', 'timedOut', 'failed'] as const;
export type ExportErrorCode = (typeof EXPORT_ERROR_CODES)[number];

export interface ExportJobSummary {
  id: string;
  workspaceId: string;
  scope: ExportScope;
  format: ExportFormat;
  documentId: string | null;
  projectId: string | null;
  /** The branch asked for; null = each page's default branch. */
  branch: string | null;
  /** The page's or project's name when the export was asked for. */
  title: string;
  status: ExportStatus;
  stage: ExportStage | null;
  pageCount: number | null;
  sizeBytes: number | null;
  error: { code: ExportErrorCode; message: string } | null;
  requestedBy: string;
  createdAt: string;
  completedAt: string | null;
  /** When the file is deleted; set once it is written. */
  expiresAt: string | null;
}

export interface ExportListResponse {
  exports: ExportJobSummary[];
}

export interface ExportCapabilitiesResponse {
  /** Formats this deployment can write; `pdf` is false without GOTENBERG_URL. */
  formats: Record<ExportFormat, boolean>;
  maxPages: number;
  ttlHours: number;
}

/** `manifest.json` at the root of a ZIP export: enough for an import to rebuild the tree. */
export const EXPORT_MANIFEST_VERSION = 1;

export interface ExportManifestAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** Inside the archive. */
  path: string;
}

export interface ExportManifestPage {
  documentId: string;
  title: string;
  category: string;
  /** The nearest exported ancestor; null at the top of the export. */
  parentId: string | null;
  position: number;
  depth: number;
  revisionId: string;
  branch: string;
  /** The markdown source, frontmatter included, inside the archive. */
  path: string;
  attachments: ExportManifestAttachment[];
}

export interface ExportManifest {
  format: 'knowledge-export';
  version: typeof EXPORT_MANIFEST_VERSION;
  exportedAt: string;
  workspaceId: string;
  scope: ExportScope;
  rootDocumentId: string | null;
  projectId: string | null;
  branch: string | null;
  title: string;
  /** Reading order: parents before children, siblings by position then title. */
  pages: ExportManifestPage[];
}

/**
 * The worker's request to the web renderer (`POST /_internal/export/render`).
 * Every path is relative to the root of what is being built: the bundle's
 * root for `html`, Gotenberg's flat upload folder for `pdf`.
 */
export interface ExportRenderRequest {
  /** `zip` needs no render, and `docx` is written by the worker from the parser's tokens. */
  format: Exclude<ExportFormat, 'zip' | 'docx'>;
  locale: Locale;
  title: string;
  exportedAt: string;
  pages: ExportRenderPage[];
  /** attachmentId → where its bytes will sit. An attachment missing here is dropped from the output. */
  assets: Record<string, string>;
}

export interface ExportRenderPage {
  documentId: string;
  title: string;
  depth: number;
  /** `html`: the page's file (`pages/guides/install.html`). Unused by `pdf`, which is one document. */
  path: string;
  /** Frontmatter already stripped. */
  markdown: string;
}

export interface ExportRenderResponse {
  /** Text files to write beside the assets: `index.html`, page files, scripts. */
  files: { path: string; content: string }[];
}

/** The window flag the PDF's print script raises once diagrams are drawn; Gotenberg waits for it. */
export const EXPORT_PRINT_READY_FLAG = '__KN_PRINT_READY__';

export interface ExportDownloadResponse {
  /** A presigned URL that downloads the file; valid for a few minutes. */
  url: string;
  filename: string;
}
