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
}

export interface PublishingSettingsValues {
  allowShareLinks: boolean;
  allowPasswordlessShares: boolean;
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
