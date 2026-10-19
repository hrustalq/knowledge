import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ChatChannelBinding, type ChatIntegration } from '@prisma/client';
import {
  CHAT_PLATFORM_NAMES,
  chatPlatformNeedsServer,
  type ChatBindingEntry,
  type ChatBindingsResponse,
  type ChatIntegrationSummary,
  type ChatIntegrationTestResponse,
  type ChatIntegrationsResponse,
  type ChatPlatformKind,
  type Locale,
  type ChatAnswerMode,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { decryptSecret, encryptSecret, maskSecret, parseKey } from '../ai/secret-box.js';
import { assertSafeExternalUrl } from '../common/safe-url.js';
import { t } from '../i18n/t.js';
import { ChatAdapterRegistry } from './adapters/chat-adapter.registry.js';
import { ChatPlatformError, type ChatAdapterContext } from './adapters/chat-adapter.types.js';
import { hashInboundSecret } from './adapters/telegram.adapter.js';
import type {
  CreateChatBindingDto,
  CreateChatIntegrationDto,
  UpdateChatBindingDto,
  UpdateChatIntegrationDto,
} from './chat.dto.js';

/**
 * Bots and the channels they answer in (issue #71) — the admin half.
 *
 * The token is write-only, the connector credential's rule: it goes into the
 * secret box on the way in and comes back out only to call the platform. What
 * the API returns is `credentialHint`. The inbound secret is not even that —
 * only its hash is stored, and a fresh one is minted every time the webhook is
 * set, because the platform is the only party that ever needs to read it.
 */
@Injectable()
export class ChatIntegrationsService {
  private readonly logger = new Logger(ChatIntegrationsService.name);
  private readonly key: Buffer | null;
  private readonly apiPublicUrl: string;
  private readonly enabled: boolean;
  private readonly allowPrivateUrls: boolean;
  private readonly listenTtlDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChatAdapterRegistry,
    private readonly agents: AgentRegistryService,
    config: ConfigService<Env, true>,
  ) {
    this.key = parseKey(config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    this.apiPublicUrl = config.get('API_PUBLIC_URL', { infer: true }).replace(/\/$/, '');
    this.enabled = config.get('CHAT_ENABLED', { infer: true });
    this.allowPrivateUrls = config.get('CHAT_ALLOW_PRIVATE_URLS', { infer: true });
    this.listenTtlDays = config.get('CHAT_LISTEN_TTL_DAYS', { infer: true });
  }

  async list(workspaceId: string): Promise<ChatIntegrationsResponse> {
    const rows = await this.prisma.chatIntegration.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { bindings: true, identities: true } } },
    });
    return { integrations: rows.map((r) => this.toSummary(r, r._count)), enabled: this.enabled };
  }

  async find(id: string): Promise<ChatIntegration | null> {
    return this.prisma.chatIntegration.findUnique({ where: { id } });
  }

  async require(id: string): Promise<ChatIntegration> {
    const row = await this.prisma.chatIntegration.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(t('error.chat.integrationNotFound', { id }));
    return row;
  }

  async summary(id: string): Promise<ChatIntegrationSummary> {
    const row = await this.prisma.chatIntegration.findUnique({
      where: { id },
      include: { _count: { select: { bindings: true, identities: true } } },
    });
    if (!row) throw new NotFoundException(t('error.chat.integrationNotFound', { id }));
    return this.toSummary(row, row._count);
  }

  /** What one call to the platform needs. A token that no longer decrypts is no token. */
  context(row: ChatIntegration): ChatAdapterContext | null {
    const token = decryptSecret(row.credential, this.key);
    return token
      ? { token, botUsername: row.botUsername, serverUrl: row.serverUrl || null, actionUrl: this.webhookUrl(row.id) }
      : null;
  }

  webhookUrl(id: string): string {
    return `${this.apiPublicUrl}/v1/chat/${id}/webhook`;
  }

  /**
   * Saved only once the platform has accepted the token: `getMe` is the proof,
   * and it is also where the bot's username comes from — the thing that makes a
   * second workspace connecting the same bot a conflict rather than a silent
   * split of its deliveries.
   */
  async create(dto: CreateChatIntegrationDto, createdBy: string): Promise<ChatIntegrationSummary> {
    if (!this.key) throw new BadRequestException(t('error.chat.noEncryptionKey'));
    const token = dto.token.trim();
    if (!token) throw new BadRequestException(t('error.chat.tokenRequired'));
    if (dto.defaultAgentKey) await this.assertAgent(dto.workspaceId, dto.defaultAgentKey);
    const serverUrl = await this.serverUrlFor(dto.kind, dto.serverUrl);
    const botUsername = await this.identify(dto.kind, token, serverUrl);
    let row: ChatIntegration;
    try {
      row = await this.prisma.chatIntegration.create({
        data: {
          workspaceId: dto.workspaceId,
          kind: dto.kind,
          name: dto.name.trim(),
          serverUrl,
          credential: encryptSecret(token, this.key),
          credentialHint: maskSecret(token),
          botUsername,
          defaultAgentKey: dto.defaultAgentKey ?? null,
          locale: dto.locale ?? 'en',
          createdBy,
        },
      });
    } catch (e) {
      throw this.uniqueConflict(e, dto.name);
    }
    await this.registerWebhook(row);
    return this.summary(row.id);
  }

  async update(id: string, dto: UpdateChatIntegrationDto): Promise<ChatIntegrationSummary> {
    const row = await this.require(id);
    const data: Prisma.ChatIntegrationUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.locale !== undefined) data.locale = dto.locale;
    if (dto.defaultAgentKey !== undefined) {
      if (dto.defaultAgentKey) await this.assertAgent(row.workspaceId, dto.defaultAgentKey);
      data.defaultAgentKey = dto.defaultAgentKey;
    }
    const kind = row.kind as ChatPlatformKind;
    const token = dto.token?.trim();
    const serverUrl = dto.serverUrl !== undefined ? await this.serverUrlFor(kind, dto.serverUrl) : row.serverUrl;
    const moved = serverUrl !== row.serverUrl;
    if (token || moved) {
      // A new server is asked again who the bot is, with whichever token applies.
      const proof = token || decryptSecret(row.credential, this.key);
      if (!proof || !this.key) throw new BadRequestException(t('error.chat.noEncryptionKey'));
      data.botUsername = await this.identify(kind, proof, serverUrl);
      data.serverUrl = serverUrl;
      if (token) {
        data.credential = encryptSecret(token, this.key);
        data.credentialHint = maskSecret(token);
      }
    }
    let next: ChatIntegration;
    try {
      next = await this.prisma.chatIntegration.update({ where: { id }, data });
    } catch (e) {
      throw this.uniqueConflict(e, dto.name ?? row.name);
    }
    // A new token is a new bot, which knows nothing of our webhook yet; turning
    // the bot back on re-points it in case it was moved while off.
    if (token || moved || (dto.enabled === true && !row.enabled)) await this.registerWebhook(next);
    return this.summary(id);
  }

  async remove(id: string): Promise<void> {
    await this.require(id);
    // Bindings, identities, link codes, conversations and answers cascade.
    // The platform keeps delivering until it gives up on the 404s — there is
    // nothing to unregister with once the token is gone.
    await this.prisma.chatIntegration.delete({ where: { id } });
  }

  /** The health check: is the token still accepted, and does the platform take our webhook? */
  async test(id: string): Promise<ChatIntegrationTestResponse> {
    const row = await this.require(id);
    const ctx = this.context(row);
    if (!ctx) return { ok: false, botUsername: row.botUsername, error: t('error.chat.noEncryptionKey') };
    try {
      const { username } = await this.registry.get(row.kind).identify(ctx);
      if (username !== row.botUsername) {
        await this.prisma.chatIntegration.update({ where: { id }, data: { botUsername: username } });
      }
      const webhookError = await this.registerWebhook({ ...row, botUsername: username });
      return { ok: webhookError === null, botUsername: username, error: webhookError };
    } catch (err) {
      return { ok: false, botUsername: row.botUsername, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Point the platform at us with a fresh secret. A refusal is stored, not
   * thrown: the bot is still saved, and the settings page says why it is deaf
   * (a non-HTTPS API_PUBLIC_URL in development is the usual one). Returns the
   * refusal, or null.
   */
  private async registerWebhook(row: ChatIntegration): Promise<string | null> {
    const ctx = this.context(row);
    if (!ctx) return t('error.chat.noEncryptionKey');
    // Nothing to register: the socket supervisor owns this bot's status, and
    // its last failure is the answer (null for a bot saved a moment ago).
    if (this.registry.get(row.kind).inbound === 'socket') {
      const current = await this.prisma.chatIntegration.findUnique({ where: { id: row.id }, select: { webhookError: true } });
      return current?.webhookError ?? null;
    }
    const secret = randomBytes(32).toString('base64url');
    try {
      await this.registry.get(row.kind).registerWebhook(ctx, this.webhookUrl(row.id), secret);
      await this.prisma.chatIntegration.update({
        where: { id: row.id },
        data: { inboundSecretHash: hashInboundSecret(secret), webhookError: null },
      });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({ msg: 'chat webhook registration refused', integrationId: row.id, error: message });
      await this.prisma.chatIntegration.update({ where: { id: row.id }, data: { webhookError: message.slice(0, 500) } });
      return message;
    }
  }

  /**
   * The server a self-hosted bot lives on, normalised (no trailing slash) and
   * past the SSRF guard — the address is typed by an admin, and every call
   * after this dials it. '' for a platform with a fixed API, which must not be
   * given one.
   */
  private async serverUrlFor(kind: ChatPlatformKind, raw: string | undefined): Promise<string> {
    const value = raw?.trim() ?? '';
    const platform = CHAT_PLATFORM_NAMES[kind];
    if (!chatPlatformNeedsServer(kind)) {
      if (value) throw new BadRequestException(t('error.chat.serverUrlUnexpected', { platform }));
      return '';
    }
    if (!value) throw new BadRequestException(t('error.chat.serverUrlRequired', { platform }));
    await assertSafeExternalUrl(value, this.allowPrivateUrls, {
      invalid: 'error.chat.serverUrlInvalid',
      notHttps: 'error.chat.serverUrlNotHttps',
      unresolved: 'error.chat.serverHostUnresolved',
      private: 'error.chat.serverUrlPrivate',
    });
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  }

  private async identify(kind: ChatPlatformKind, token: string, serverUrl: string): Promise<string> {
    try {
      const { username } = await this.registry
        .get(kind)
        .identify({ token, botUsername: null, serverUrl: serverUrl || null, actionUrl: '' });
      return username;
    } catch (err) {
      const reason = err instanceof ChatPlatformError ? err.message : String(err);
      throw new BadRequestException(t('error.chat.tokenRejected', { platform: CHAT_PLATFORM_NAMES[kind], reason }));
    }
  }

  private async assertAgent(workspaceId: string, key: string): Promise<void> {
    try {
      await this.agents.resolve(workspaceId, key);
    } catch {
      throw new BadRequestException(t('error.chat.unknownAgent', { agent: key }));
    }
  }

  private uniqueConflict(e: unknown, name: string): unknown {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return e;
    const target = String((e.meta as { target?: unknown } | undefined)?.target ?? '');
    return target.includes('bot_username')
      ? new ConflictException({ statusCode: HttpStatus.CONFLICT, message: t('error.chat.botTaken'), reason: 'chat.botTaken' })
      : new ConflictException({ statusCode: HttpStatus.CONFLICT, message: t('error.chat.nameTaken', { name }), reason: 'chat.nameTaken' });
  }

  private toSummary(row: ChatIntegration, counts: { bindings: number; identities: number }): ChatIntegrationSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      kind: row.kind as ChatPlatformKind,
      name: row.name,
      enabled: row.enabled,
      credentialHint: row.credentialHint,
      serverUrl: row.serverUrl || null,
      botUsername: row.botUsername,
      defaultAgentKey: row.defaultAgentKey,
      locale: row.locale as Locale,
      webhookUrl: this.webhookUrl(row.id),
      webhookError: row.webhookError,
      bindingCount: counts.bindings,
      identityCount: counts.identities,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Bindings: which groups the bot answers in, and how.
  // -------------------------------------------------------------------------

  async listBindings(integrationId: string): Promise<ChatBindingsResponse> {
    const rows = await this.prisma.chatChannelBinding.findMany({
      where: { integrationId },
      orderBy: { createdAt: 'asc' },
      include: SUBSCRIPTION_COUNT,
    });
    return { bindings: rows.map(toBindingEntry), listenTtlDays: this.listenTtlDays };
  }

  async requireBinding(id: string): Promise<ChatChannelBinding> {
    const row = await this.prisma.chatChannelBinding.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(t('error.chat.bindingNotFound', { id }));
    return row;
  }

  async findBinding(integrationId: string, externalChatId: string): Promise<ChatChannelBinding | null> {
    return this.prisma.chatChannelBinding.findUnique({
      where: { integrationId_externalChatId: { integrationId, externalChatId } },
    });
  }

  async createBinding(integrationId: string, dto: CreateChatBindingDto, createdBy: string): Promise<ChatBindingEntry> {
    const integration = await this.require(integrationId);
    await this.assertBindingRefs(integration.workspaceId, dto);
    try {
      const row = await this.prisma.chatChannelBinding.create({
        data: {
          integrationId,
          workspaceId: integration.workspaceId,
          externalChatId: dto.externalChatId.trim(),
          title: dto.title?.trim() || null,
          projectId: dto.projectId ?? null,
          agentKey: dto.agentKey ?? null,
          answerMode: dto.answerMode ?? 'mention',
          locale: dto.locale ?? null,
          createdBy,
        },
        include: SUBSCRIPTION_COUNT,
      });
      return toBindingEntry(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          message: t('error.chat.bindingExists'),
          reason: 'chat.bindingExists',
        });
      }
      throw e;
    }
  }

  async updateBinding(id: string, dto: UpdateChatBindingDto): Promise<ChatBindingEntry> {
    const row = await this.requireBinding(id);
    await this.assertBindingRefs(row.workspaceId, dto);
    if (dto.listening !== undefined && dto.listening !== row.listening) await this.switchListening(row, dto.listening);
    const next = await this.prisma.chatChannelBinding.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title?.trim() || null } : {}),
        ...(dto.projectId !== undefined ? { projectId: dto.projectId } : {}),
        ...(dto.agentKey !== undefined ? { agentKey: dto.agentKey } : {}),
        ...(dto.answerMode !== undefined ? { answerMode: dto.answerMode } : {}),
        ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
        ...(dto.listening !== undefined ? { listening: dto.listening } : {}),
      },
      include: SUBSCRIPTION_COUNT,
    });
    return toBindingEntry(next);
  }

  /**
   * Listening (#82): Telegram only, since Time's and Mattermost's threads are fetched whole.
   * On, the group is told first — if the bot cannot say so, nothing is kept,
   * because a group that was never told is a group being recorded. Off, what
   * was kept goes at once, not at the TTL.
   */
  private async switchListening(row: ChatChannelBinding, on: boolean): Promise<void> {
    const integration = await this.require(row.integrationId);
    if (integration.kind !== 'telegram') throw new BadRequestException(t('error.chat.listenTelegramOnly'));
    if (!on) {
      await this.prisma.chatBufferedMessage.deleteMany({ where: { bindingId: row.id } });
      return;
    }
    const ctx = this.context(integration);
    if (!ctx) throw new BadRequestException(t('error.chat.listenNoticeFailed', { reason: t('error.chat.tokenRequired') }));
    const adapter = this.registry.get(integration.kind);
    const locale = (row.locale ?? integration.locale) as Locale;
    const text = t('chat.listen.on', { count: this.listenTtlDays }, locale);
    try {
      await adapter.postMessage(ctx, { chatId: row.externalChatId }, adapter.render({ kind: 'notice', text }));
    } catch (err) {
      throw new BadRequestException(t('error.chat.listenNoticeFailed', { reason: err instanceof ChatPlatformError ? err.message : 'unreachable' }));
    }
  }

  async removeBinding(id: string): Promise<void> {
    await this.requireBinding(id);
    await this.prisma.chatChannelBinding.delete({ where: { id } });
  }

  /** `/bind` from inside a group, by a linked admin. Idempotent: an existing binding is left as it is. */
  async bindFromChat(
    integration: ChatIntegration,
    chat: { chatId: string; title: string | null },
    createdBy: string,
  ): Promise<'created' | 'exists'> {
    const created = await this.prisma.chatChannelBinding.createMany({
      data: [
        {
          integrationId: integration.id,
          workspaceId: integration.workspaceId,
          externalChatId: chat.chatId,
          title: chat.title,
          createdBy,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1 ? 'created' : 'exists';
  }

  async unbindFromChat(integrationId: string, chatId: string): Promise<boolean> {
    const removed = await this.prisma.chatChannelBinding.deleteMany({ where: { integrationId, externalChatId: chatId } });
    return removed.count > 0;
  }

  private async assertBindingRefs(
    workspaceId: string,
    dto: { projectId?: string | null; agentKey?: string | null },
  ): Promise<void> {
    if (dto.projectId) {
      const project = await this.prisma.project.findUnique({ where: { id: dto.projectId }, select: { workspaceId: true } });
      if (!project || project.workspaceId !== workspaceId) {
        throw new BadRequestException(t('error.chat.projectNotInWorkspace', { id: dto.projectId }));
      }
    }
    if (dto.agentKey) await this.assertAgent(workspaceId, dto.agentKey);
  }
}

const SUBSCRIPTION_COUNT = { _count: { select: { subscriptions: true } } } as const;

function toBindingEntry(row: ChatChannelBinding & { _count: { subscriptions: number } }): ChatBindingEntry {
  return {
    id: row.id,
    integrationId: row.integrationId,
    externalChatId: row.externalChatId,
    title: row.title,
    projectId: row.projectId,
    agentKey: row.agentKey,
    answerMode: row.answerMode as ChatAnswerMode,
    locale: (row.locale as Locale | null) ?? null,
    subscriptionCount: row._count.subscriptions,
    listening: row.listening,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
