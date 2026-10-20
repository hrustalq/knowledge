import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ShareLink } from '@prisma/client';
import {
  SHARE_TOKEN_PREFIX,
  shareNeedsPassword,
  type CreateShareLinkResponse,
  type ShareLinkListResponse,
  type ShareLinkSummary,
  type WorkspaceShareLinksResponse,
} from '@knowledge/contracts';
import { ActivityService } from '../activity/activity.service.js';
import { decryptSecret, encryptSecret, parseKey } from '../ai/secret-box.js';
import { hashPassword } from '../auth/password.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PublishingSettingsService } from './publishing-settings.service.js';

/** The dev principal has no users row; same stub the rest of the API records. */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

/** SHA-256 of a `kp_` token — the only form the database looks a link up by. */
export function shareTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface ShareLinkInput {
  includeSubtree?: boolean;
  /** ISO timestamp; `null` asks for a link that never expires. */
  expiresAt?: string | null;
  /** A string sets the password; `null` clears it; omitted keeps it. */
  password?: string | null;
  /** Readers may download an export of the scope (#161). Omitted: off on create, kept on update. */
  allowDownload?: boolean;
}

type ShareRow = ShareLink & { document: { title: string } };

/**
 * Share links: the management side (docs/features/43, issue #77 phase 1).
 *
 * Controller-free and auth-free, so `McpService` can create one for
 * `knowledge_share_page`. The anonymous read side is `PublicSharesService`,
 * which never sees anything here but the row.
 *
 * - The token is 32 random bytes behind `kp_`. Only its SHA-256 is looked up;
 *   the plaintext is kept under the secret box so an editor can copy the link
 *   again, and not at all when no SETTINGS_ENCRYPTION_KEY is set.
 * - Expiry is clamped to SHARE_LINK_MAX_TTL_DAYS, and the response says what
 *   was asked for when the clamp moved it: the env is a ceiling, not a silent
 *   rewrite.
 * - Every write re-checks the workspace switch, and the password rule
 *   (`shareNeedsPassword`) runs on the link as it will be after the write.
 */
@Injectable()
export class ShareLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PublishingSettingsService,
    private readonly activity: ActivityService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Null when no key is configured or it is malformed: links are then shown once. */
  private secretKey(): Buffer | null {
    try {
      return parseKey(this.config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    } catch {
      return null;
    }
  }

  shareUrl(token: string): string {
    return `${this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '')}/s/${token}`;
  }

  async list(documentId: string): Promise<ShareLinkListResponse> {
    const rows = await this.prisma.shareLink.findMany({
      where: { documentId, revokedAt: null },
      include: { document: { select: { title: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const document = await this.prisma.document.findUniqueOrThrow({ where: { id: documentId }, select: { workspaceId: true } });
    const settings = await this.settings.get(document.workspaceId);
    return {
      shares: rows.map((r) => this.toSummary(r)),
      policy: {
        enabled: settings.effective.allowShareLinks,
        allowPasswordlessShares: settings.effective.allowPasswordlessShares,
        maxTtlDays: settings.ceiling.maxTtlDays,
      },
    };
  }

  /** Every link in the workspace, revoked and expired included — the admin inventory. */
  async listWorkspace(workspaceId: string): Promise<WorkspaceShareLinksResponse> {
    const rows = await this.prisma.shareLink.findMany({
      where: { workspaceId },
      include: { document: { select: { title: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return { shares: rows.map((r) => this.toSummary(r)) };
  }

  async create(documentId: string, input: ShareLinkInput, actorId?: string): Promise<CreateShareLinkResponse> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, workspaceId: true, archivedAt: true, restrictedBy: true },
    });
    if (!document) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    if (document.archivedAt) throw new ConflictException(t('error.document.archived', { id: documentId }));
    // A restricted page is shared by granting access, never by a public link (#76).
    if (document.restrictedBy.length > 0) {
      throw new ConflictException({ statusCode: 409, message: t('error.share.restricted'), reason: 'share.restricted' });
    }
    const settings = await this.requireEnabled(document.workspaceId);

    const { expiresAt, requestedExpiresAt } = this.clampExpiry(input.expiresAt ?? null);
    const hasPassword = typeof input.password === 'string';
    if (shareNeedsPassword({ expiresAt, hasPassword }, settings)) {
      throw new BadRequestException(t('error.share.passwordRequired'));
    }

    const token = `${SHARE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const key = this.secretKey();
    const row = await this.prisma.shareLink.create({
      data: {
        workspaceId: document.workspaceId,
        documentId,
        includeSubtree: input.includeSubtree ?? false,
        tokenHash: shareTokenHash(token),
        tokenCipher: key ? encryptSecret(token, key) : null,
        passwordHash: hasPassword ? await hashPassword(input.password as string) : null,
        allowDownload: input.allowDownload ?? false,
        expiresAt,
        createdBy: actorId ?? AUTHOR_ID_STUB,
      },
      include: { document: { select: { title: true } } },
    });
    this.record(row, 'share.created', actorId);
    return {
      share: this.toSummary(row),
      url: this.shareUrl(token),
      requestedExpiresAt: requestedExpiresAt?.toISOString() ?? null,
    };
  }

  async update(shareId: string, input: ShareLinkInput, actorId?: string): Promise<ShareLinkSummary> {
    const current = await this.requireLive(shareId);
    const settings = await this.requireEnabled(current.workspaceId);

    const data: { includeSubtree?: boolean; expiresAt?: Date | null; passwordHash?: string | null; allowDownload?: boolean } = {};
    if (input.includeSubtree !== undefined) data.includeSubtree = input.includeSubtree;
    if (input.allowDownload !== undefined) data.allowDownload = input.allowDownload;
    if (input.expiresAt !== undefined) data.expiresAt = this.clampExpiry(input.expiresAt).expiresAt;
    if (input.password !== undefined) data.passwordHash = input.password === null ? null : await hashPassword(input.password);

    const after = {
      expiresAt: data.expiresAt !== undefined ? data.expiresAt : current.expiresAt,
      hasPassword: data.passwordHash !== undefined ? data.passwordHash !== null : current.passwordHash !== null,
    };
    if (shareNeedsPassword(after, settings)) throw new BadRequestException(t('error.share.passwordRequired'));

    const row = await this.prisma.shareLink.update({
      where: { id: shareId },
      data,
      include: { document: { select: { title: true } } },
    });
    this.record(row, 'share.updated', actorId, {
      changed: Object.keys(data).map((k) => (k === 'passwordHash' ? 'password' : k)),
    });
    return this.toSummary(row);
  }

  /** Idempotent: a second revoke changes nothing and records nothing. The row stays, for the inventory. */
  async revoke(shareId: string, actorId?: string): Promise<{ revoked: true }> {
    const { count } = await this.prisma.shareLink.updateMany({
      where: { id: shareId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count > 0) {
      const row = await this.prisma.shareLink.findUniqueOrThrow({
        where: { id: shareId },
        include: { document: { select: { title: true } } },
      });
      this.record(row, 'share.revoked', actorId);
    }
    return { revoked: true };
  }

  private async requireEnabled(workspaceId: string) {
    const settings = await this.settings.effective(workspaceId);
    if (!settings.allowShareLinks) {
      throw new ForbiddenException({
        statusCode: 403,
        message: t('error.share.disabledByWorkspace'),
        reason: 'share.disabledByWorkspace',
      });
    }
    return settings;
  }

  private async requireLive(shareId: string): Promise<ShareLink> {
    const row = await this.prisma.shareLink.findUnique({ where: { id: shareId } });
    if (!row || row.revokedAt) throw new NotFoundException(t('error.share.notFound'));
    return row;
  }

  /**
   * `null` is "never", which the TTL cap turns into "the cap". The requested
   * value comes back only when the cap moved it.
   */
  private clampExpiry(requested: string | null): { expiresAt: Date | null; requestedExpiresAt: Date | null } {
    const asked = requested === null ? null : new Date(requested);
    if (asked && (Number.isNaN(asked.getTime()) || asked.getTime() <= Date.now())) {
      throw new BadRequestException(t('error.share.expiryInPast'));
    }
    const maxDays = this.config.get('SHARE_LINK_MAX_TTL_DAYS', { infer: true });
    if (!maxDays) return { expiresAt: asked, requestedExpiresAt: null };
    const cap = new Date(Date.now() + maxDays * 86_400_000);
    if (asked && asked <= cap) return { expiresAt: asked, requestedExpiresAt: null };
    return { expiresAt: cap, requestedExpiresAt: asked };
  }

  private record(row: ShareLink, action: string, actorId?: string, extra: Record<string, unknown> = {}): void {
    void this.activity.record({
      workspaceId: row.workspaceId,
      ...(actorId ? { actor: actorId } : {}),
      action,
      documentId: row.documentId,
      subjectId: row.documentId,
      metadata: {
        shareId: row.id,
        includeSubtree: row.includeSubtree,
        hasPassword: row.passwordHash !== null,
        allowDownload: row.allowDownload,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        ...extra,
      },
    });
  }

  private toSummary(row: ShareRow): ShareLinkSummary {
    const token = decryptSecret(row.tokenCipher, this.secretKey());
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      documentId: row.documentId,
      documentTitle: row.document.title,
      includeSubtree: row.includeSubtree,
      url: token ? this.shareUrl(token) : null,
      hasPassword: row.passwordHash !== null,
      allowDownload: row.allowDownload,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
