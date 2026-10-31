import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatIdentity, ChatIntegration } from '@prisma/client';
import type { ChatIdentityEntry, ChatLinkPreview, ChatPlatformKind } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../auth/access.service.js';
import type { Principal } from '../auth/principal.js';
import { t, withLocale } from '../i18n/t.js';
import { ChatAdapterRegistry } from './adapters/chat-adapter.registry.js';
import { ChatIntegrationsService } from './chat-integrations.service.js';

const hashCode = (code: string): string => createHash('sha256').update(code, 'utf8').digest('hex');

/**
 * Who a messenger account is (issue #71).
 *
 * Linking needs two proofs, one from each side, and neither can be forged
 * from the other. The code is minted only in reply to a *verified* delivery
 * from that account, in a private chat — so whoever holds it controls the
 * account. It is redeemed only by a signed-in session — so whoever redeems it
 * is the person. The code is stored hashed, used once, and expires
 * (CHAT_LINK_CODE_TTL_MINUTES): the PasswordResetToken shape.
 *
 * Codes are never sent into a group. There, anyone could open the link, and
 * the account would then ask its questions as whoever clicked first.
 */
@Injectable()
export class ChatIdentityService {
  private readonly logger = new Logger(ChatIdentityService.name);
  private readonly ttlMinutes: number;
  private readonly webBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly integrations: ChatIntegrationsService,
    private readonly registry: ChatAdapterRegistry,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMinutes = config.get('CHAT_LINK_CODE_TTL_MINUTES', { infer: true });
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
  }

  async resolve(integrationId: string, externalUserId: string): Promise<ChatIdentity | null> {
    return this.prisma.chatIdentity.findUnique({
      where: { integrationId_externalUserId: { integrationId, externalUserId } },
    });
  }

  /** A fresh code for an account asking in a private chat. Earlier unused codes for it stop working. */
  async issueCode(
    integration: ChatIntegration,
    account: { externalUserId: string; externalUserName: string | null; chatId: string },
  ): Promise<{ url: string; minutes: number }> {
    const code = randomBytes(24).toString('base64url');
    await this.prisma.$transaction([
      this.prisma.chatLinkCode.deleteMany({
        where: { integrationId: integration.id, externalUserId: account.externalUserId, usedAt: null },
      }),
      this.prisma.chatLinkCode.create({
        data: {
          integrationId: integration.id,
          externalUserId: account.externalUserId,
          externalUserName: account.externalUserName,
          externalChatId: account.chatId,
          codeHash: hashCode(code),
          expiresAt: new Date(Date.now() + this.ttlMinutes * 60_000),
        },
      }),
    ]);
    return { url: `${this.webBaseUrl}/chat/link?code=${encodeURIComponent(code)}`, minutes: this.ttlMinutes };
  }

  /** What the confirmation page shows. Refuses exactly what {@link confirm} would. */
  async preview(code: string, principal: Principal): Promise<ChatLinkPreview> {
    const { row, integration } = await this.redeemable(code);
    await this.assertMember(principal, integration.workspaceId);
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: integration.workspaceId },
      select: { name: true },
    });
    return {
      kind: integration.kind as ChatPlatformKind,
      integrationName: integration.name,
      botUsername: integration.botUsername,
      externalUserName: row.externalUserName,
      workspaceId: integration.workspaceId,
      workspaceName: workspace?.name ?? integration.workspaceId,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /**
   * Link the account to the signed-in person. The code is spent with a guarded
   * update, so two tabs confirming at once link once. An account already linked
   * to somebody is re-linked: only the account's owner could have asked for this
   * code, and moving their own account is theirs to do.
   */
  async confirm(code: string, principal: Principal): Promise<ChatIdentityEntry> {
    const { row, integration } = await this.redeemable(code);
    await this.assertMember(principal, integration.workspaceId);
    // The spent code and the identity commit together (#658), or a failed
    // upsert burns the code with nothing linked.
    const identity = await this.prisma.withTransaction(async () => {
      const spent = await this.prisma.chatLinkCode.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (spent.count === 0) throw this.codeError('linkCodeUsed');
      return this.prisma.chatIdentity.upsert({
        where: { integrationId_externalUserId: { integrationId: integration.id, externalUserId: row.externalUserId } },
        create: {
          integrationId: integration.id,
          workspaceId: integration.workspaceId,
          externalUserId: row.externalUserId,
          externalUserName: row.externalUserName,
          userId: principal.userId,
        },
        update: { userId: principal.userId, externalUserName: row.externalUserName, linkedAt: new Date() },
      });
    });
    void this.announceLinked(integration, row.externalChatId, principal);
    return this.toEntry(identity, integration, principal.displayName);
  }

  async listMine(userId: string): Promise<ChatIdentityEntry[]> {
    const rows = await this.prisma.chatIdentity.findMany({
      where: { userId },
      include: { integration: true },
      orderBy: { linkedAt: 'desc' },
    });
    return rows.map((r) => this.toEntry(r, r.integration, null));
  }

  /** Own rows only — someone else's id reads as not found, never as forbidden. */
  async removeMine(id: string, userId: string): Promise<void> {
    const removed = await this.prisma.chatIdentity.deleteMany({ where: { id, userId } });
    if (removed.count === 0) throw new NotFoundException(t('error.chat.identityNotFound', { id }));
  }

  async listForIntegration(integrationId: string): Promise<ChatIdentityEntry[]> {
    const integration = await this.integrations.require(integrationId);
    const rows = await this.prisma.chatIdentity.findMany({ where: { integrationId }, orderBy: { linkedAt: 'desc' } });
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
      select: { id: true, displayName: true },
    });
    const name = new Map(users.map((u) => [u.id, u.displayName]));
    return rows.map((r) => this.toEntry(r, integration, name.get(r.userId) ?? null));
  }

  async removeForIntegration(integrationId: string, identityId: string): Promise<void> {
    const removed = await this.prisma.chatIdentity.deleteMany({ where: { id: identityId, integrationId } });
    if (removed.count === 0) throw new NotFoundException(t('error.chat.identityNotFound', { id: identityId }));
  }

  async unlinkExternal(integrationId: string, externalUserId: string): Promise<boolean> {
    const removed = await this.prisma.chatIdentity.deleteMany({ where: { integrationId, externalUserId } });
    return removed.count > 0;
  }

  private async redeemable(code: string) {
    const row = await this.prisma.chatLinkCode.findUnique({
      where: { codeHash: hashCode(code.trim()) },
      include: { integration: true },
    });
    if (!row) throw this.codeError('linkCodeInvalid');
    if (row.usedAt) throw this.codeError('linkCodeUsed');
    if (row.expiresAt.getTime() <= Date.now()) throw this.codeError('linkCodeExpired');
    return { row, integration: row.integration };
  }

  private codeError(key: 'linkCodeInvalid' | 'linkCodeExpired' | 'linkCodeUsed'): BadRequestException {
    return new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      message: t(`error.chat.${key}`),
      reason: `chat.${key}`,
    });
  }

  private async assertMember(principal: Principal, workspaceId: string): Promise<void> {
    try {
      await this.access.requireRole(principal, workspaceId, 'viewer');
    } catch {
      throw new ForbiddenException(t('error.chat.linkNotMember'));
    }
  }

  /** "Linked" in the private chat the code came from — in the person's language, since they now have one. */
  private async announceLinked(integration: ChatIntegration, chatId: string, principal: Principal): Promise<void> {
    const ctx = this.integrations.context(integration);
    if (!ctx) return;
    const workspace = await this.prisma.workspace.findUnique({ where: { id: integration.workspaceId }, select: { name: true } });
    const adapter = this.registry.get(integration.kind);
    const text = withLocale(principal.locale, () =>
      t('chat.link.success', { user: principal.displayName, workspace: workspace?.name ?? '' }),
    );
    try {
      await adapter.postMessage(ctx, { chatId }, adapter.render({ kind: 'notice', text }));
    } catch (err) {
      this.logger.warn({ msg: 'chat link confirmation not delivered', integrationId: integration.id, error: String(err) });
    }
  }

  private toEntry(row: ChatIdentity, integration: ChatIntegration, userDisplayName: string | null): ChatIdentityEntry {
    return {
      id: row.id,
      integrationId: integration.id,
      integrationName: integration.name,
      kind: integration.kind as ChatPlatformKind,
      workspaceId: row.workspaceId,
      externalUserId: row.externalUserId,
      externalUserName: row.externalUserName,
      userId: row.userId,
      userDisplayName,
      linkedAt: row.linkedAt.toISOString(),
    };
  }
}
