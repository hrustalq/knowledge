import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Connector, type ConnectorRun } from '@prisma/client';
import {
  connectorKindInfo,
  GITHUB_INSTALLATION_CONFIG_KEY,
  type ConnectorConflictPolicy,
  type ConnectorDirection,
  type ConnectorKind,
  type ConnectorRunDirection,
  type ConnectorRunInfo,
  type ConnectorRunPhase,
  type ConnectorRunStatus,
  type ConnectorRunWarning,
  type ConnectorSummary,
  type ConnectorSyncMode,
  type ConnectorTrigger,
  type DocumentCategory,
} from '@knowledge/contracts';
import { decryptSecret, encryptSecret, MissingEncryptionKeyError, maskSecret, parseKey } from '../ai/secret-box.js';
import { assertSafeExternalUrl } from '../common/safe-url.js';
import type { Env } from '../config/env.js';
import { currentLocale } from '../i18n/locale.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ConnectorRegistry } from './adapters/connector.registry.js';
import { GithubAppService } from './github/github-app.service.js';
import type { ConnectorContext } from './adapters/connector.types.js';

/** Warnings are capped: a run over a 5 000-page space must not write a novel into one row. */
const MAX_WARNINGS = 200;

export interface CreateConnectorInput {
  workspaceId: string;
  kind: string;
  name: string;
  projectId: string;
  config?: Record<string, string>;
  credential?: string;
  parentId?: string | null;
  category?: DocumentCategory;
  direction?: ConnectorDirection;
  conflict?: ConnectorConflictPolicy;
  pushOnPublish?: boolean;
  syncMode?: ConnectorSyncMode;
  preserveHierarchy?: boolean;
  syncIntervalMinutes?: number | null;
  webhookSecret?: string | null;
  enabled?: boolean;
}
export type UpdateConnectorInput = Partial<Omit<CreateConnectorInput, 'workspaceId' | 'kind' | 'credential'>> & {
  /** `null` clears the stored credential; absent keeps it. */
  credential?: string | null;
};

/**
 * Connector configuration, credentials and run bookkeeping (docs/features/19).
 *
 * Controller-free and auth-free by construction so the worker can use it — the
 * same reason AiProvidersService parses its own encryption key rather than
 * depending on AiConfigService's load order.
 */
@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);
  private readonly key: Buffer | null;
  private readonly allowPrivateUrls: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly registry: ConnectorRegistry,
    private readonly projects: ProjectsService,
    private readonly githubApp: GithubAppService,
  ) {
    this.key = parseKey(this.config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    this.allowPrivateUrls = this.config.get('CONNECTOR_ALLOW_PRIVATE_URLS', { infer: true });
    if (!this.key) {
      this.logger.warn('SETTINGS_ENCRYPTION_KEY is not set — connector credentials cannot be saved from the UI');
    }
  }

  get canStoreSecrets(): boolean {
    return this.key !== null;
  }

  // --- reads ---

  async list(workspaceId: string): Promise<ConnectorSummary[]> {
    const rows = await this.prisma.connector.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(rows.map((row) => this.toSummary(row)));
  }

  async get(connectorId: string): Promise<ConnectorSummary> {
    return this.toSummary(await this.require(connectorId));
  }

  async require(connectorId: string): Promise<Connector> {
    const row = await this.prisma.connector.findUnique({ where: { id: connectorId } });
    if (!row) throw new NotFoundException(t('error.connector.notFound', { id: connectorId }));
    return row;
  }

  // --- writes ---

  async create(input: CreateConnectorInput, userId?: string): Promise<ConnectorSummary> {
    const info = connectorKindInfo(input.kind);
    if (!info) throw new BadRequestException(t('error.connector.unknownKind', { kind: input.kind }));

    await this.projects.requireProjectInWorkspace(input.projectId, input.workspaceId);

    const config = input.config ?? {};
    await this.validateConfig(info.kind, config);

    const taken = await this.prisma.connector.findUnique({
      where: { workspaceId_name: { workspaceId: input.workspaceId, name: input.name } },
    });
    if (taken) throw new ConflictException(t('error.connector.nameTaken', { name: input.name }));

    const row = await this.prisma.connector.create({
      data: {
        workspaceId: input.workspaceId,
        kind: info.kind,
        name: input.name,
        projectId: input.projectId,
        parentId: input.parentId ?? null,
        category: input.category ?? 'other',
        config: config as Prisma.InputJsonValue,
        credential: this.encrypt(input.credential ?? null),
        credentialHint: input.credential ? maskSecret(input.credential) : null,
        direction: this.checkDirection(info.kind, input.direction ?? 'pull'),
        conflict: input.conflict ?? 'manual',
        pushOnPublish: input.pushOnPublish ?? false,
        syncMode: input.syncMode ?? 'auto',
        preserveHierarchy: input.preserveHierarchy ?? false,
        syncIntervalMinutes: input.syncIntervalMinutes ?? null,
        webhookSecret: this.encrypt(input.webhookSecret ?? null),
        enabled: input.enabled ?? true,
        locale: currentLocale(),
        createdBy: userId ?? null,
      },
    });
    return this.toSummary(row);
  }

  async update(connectorId: string, input: UpdateConnectorInput): Promise<ConnectorSummary> {
    const row = await this.require(connectorId);
    const kind = row.kind as ConnectorKind;

    if (input.projectId !== undefined) {
      await this.projects.requireProjectInWorkspace(input.projectId, row.workspaceId);
    }
    if (input.config !== undefined) await this.validateConfig(kind, input.config);
    if (input.name !== undefined && input.name !== row.name) {
      const taken = await this.prisma.connector.findUnique({
        where: { workspaceId_name: { workspaceId: row.workspaceId, name: input.name } },
      });
      if (taken) throw new ConflictException(t('error.connector.nameTaken', { name: input.name }));
    }

    // undefined keeps, null clears — the AiSettingsService `pick` contract.
    const keep = <K extends keyof UpdateConnectorInput>(key: K) =>
      input[key] === undefined ? {} : { [key]: input[key] };

    const updated = await this.prisma.connector.update({
      where: { id: connectorId },
      data: {
        ...keep('name'),
        ...keep('projectId'),
        ...keep('parentId'),
        ...keep('category'),
        ...keep('conflict'),
        ...keep('pushOnPublish'),
        ...keep('syncMode'),
        ...keep('preserveHierarchy'),
        ...keep('syncIntervalMinutes'),
        ...keep('enabled'),
        ...(input.config === undefined ? {} : { config: input.config as Prisma.InputJsonValue }),
        ...(input.direction === undefined ? {} : { direction: this.checkDirection(kind, input.direction) }),
        ...(input.credential === undefined
          ? {}
          : {
              credential: this.encrypt(input.credential),
              credentialHint: input.credential ? maskSecret(input.credential) : null,
            }),
        ...(input.webhookSecret === undefined ? {} : { webhookSecret: this.encrypt(input.webhookSecret) }),
      },
    });
    return this.toSummary(updated);
  }

  async remove(connectorId: string): Promise<void> {
    await this.require(connectorId);
    // Links and runs cascade; the pages they produced are deliberately kept —
    // deleting a connector should not delete a workspace's knowledge.
    await this.prisma.connector.delete({ where: { id: connectorId } });
  }

  async testConnection(connectorId: string): Promise<{ ok: boolean; detail: string | null }> {
    const row = await this.require(connectorId);
    const adapter = this.adapterFor(row);
    try {
      const ctx = await this.contextFor(row, async () => undefined);
      const result = await adapter.testConnection(ctx);
      return { ok: result.ok, detail: result.detail ?? null };
    } catch (err) {
      return { ok: false, detail: (err as Error).message.slice(0, 500) };
    }
  }

  // --- adapters & context ---

  adapterFor(row: Connector) {
    const adapter = this.registry.resolve(row.kind);
    if (!adapter) throw new BadRequestException(t('error.connector.unknownKind', { kind: row.kind }));
    return adapter;
  }

  /**
   * Builds the per-call context. Secrets are decrypted here and nowhere else,
   * and live only for the duration of the call.
   */
  /**
   * The credential an adapter will actually dial with (docs/features/30).
   *
   * A connector created through the repository picker holds no secret of its
   * own: it names a GitHub App installation, and the token is minted per run
   * and expires within the hour. One that was configured by pasting a personal
   * access token keeps using it, which is what makes the App optional.
   *
   * This is the whole integration seam. Every adapter already reads
   * `ctx.credential` and `githubHeaders` already sends it as a bearer token, so
   * nothing below this line knows or cares which of the two it got.
   *
   * Null when the mint fails — an expired installation, a revoked App, a
   * suspended org. The adapter then behaves exactly as it would for a missing
   * token, and the 404 classifier in `repo-archive.ts` says so in words.
   */
  private async credentialFor(row: Connector): Promise<string | null> {
    const config = (row.config ?? {}) as Record<string, unknown>;
    const installationId = config[GITHUB_INSTALLATION_CONFIG_KEY];
    if (typeof installationId === 'string' && installationId.trim() !== '') {
      return this.githubApp.installationToken(installationId.trim());
    }
    return decryptSecret(row.credential, this.key);
  }

  async contextFor(
    row: Connector,
    onStage: (stage: string, progress?: number | null) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<ConnectorContext> {
    // Resolved once per context rather than per call: the flag cannot change
    // mid-run, and an adapter calling `debug` in a tight pagination loop should
    // not pay a ConfigService lookup each time.
    const enabled = this.config.get('CONNECTOR_DEBUG', { infer: true });
    const logger = this.logger;
    const debug: ConnectorContext['debug'] = enabled
      ? (message, fields) => {
          const detail = fields
            ? ' ' +
              Object.entries(fields)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(' ')
            : '';
          logger.log(`[${row.kind} ${row.id}] ${message}${detail}`);
        }
      : () => undefined;

    return {
      connectorId: row.id,
      workspaceId: row.workspaceId,
      config: (row.config ?? {}) as Record<string, string>,
      credential: await this.credentialFor(row),
      webhookSecret: decryptSecret(row.webhookSecret, this.key),
      onStage,
      debug,
      // Read once per context for the same reason `debug` is, and handed to
      // `connectorFetch` so the SSRF guard runs at the dial rather than only
      // when an admin saved the base URL.
      allowPrivate: this.allowPrivateUrls,
      // Who to bill and which language to answer in (docs/features/27). Both
      // come off the row rather than a request, because the path that needs
      // them most is the worker's, where there is no request at all.
      userId: row.createdBy,
      locale: row.locale as ConnectorContext['locale'],
      signal,
    };
  }

  // --- runs ---

  async createRun(
    row: Connector,
    direction: ConnectorRunDirection,
    trigger: ConnectorTrigger,
    options: { externalIds?: string[]; actorId?: string; mode?: ConnectorSyncMode } = {},
  ): Promise<ConnectorRun> {
    if (!row.enabled) throw new BadRequestException(t('error.connector.disabled'));

    const adapter = this.adapterFor(row);
    if (direction === 'pull' && !adapter.capabilities.pull) {
      throw new BadRequestException(t('error.connector.pullNotSupported', { kind: row.kind }));
    }
    if (direction === 'push' && !adapter.capabilities.push) {
      throw new BadRequestException(t('error.connector.pushNotSupported', { kind: row.kind }));
    }
    if (row.direction !== 'both' && row.direction !== direction) {
      throw new BadRequestException(t('error.connector.directionNotAllowed', { direction }));
    }

    // One run at a time per connector: two concurrent pulls would race on the
    // same links and could both create the same page. `paused` and
    // `awaiting-review` count as in flight — a parked run still owns its items,
    // and starting a second pull behind it would stage the same pages twice.
    const inFlight = await this.prisma.connectorRun.findFirst({
      where: { connectorId: row.id, status: { in: ['queued', 'running', 'paused', 'awaiting-review'] } },
      select: { id: true },
    });
    if (inFlight) throw new ConflictException(t('error.connector.runInFlight'));

    // A push is a write-out, not an import: there is nothing to stage or review,
    // so it always runs straight through whatever the connector's mode says.
    const mode: ConnectorSyncMode =
      direction === 'push' ? 'auto' : (options.mode ?? (row.syncMode as ConnectorSyncMode));

    return this.prisma.connectorRun.create({
      data: {
        connectorId: row.id,
        workspaceId: row.workspaceId,
        direction,
        trigger,
        status: 'queued',
        // Frozen here, not read from the connector at execution time: editing the
        // connector must not change a run already under way.
        mode,
        scope: options.externalIds?.length ? (options.externalIds as Prisma.InputJsonValue) : Prisma.DbNull,
        locale: row.locale,
        actorId: options.actorId ?? null,
      },
    });
  }

  /**
   * Webhook-triggered pulls coalesce instead of being refused.
   *
   * A burst of edits produces a burst of webhooks, and a run's scope is frozen
   * when it starts — so simply dropping the ones that arrive during a run would
   * lose those items until the next full sync. Instead the ids are merged into
   * the run that is still `queued`, and only a connector with nothing waiting
   * gets a new run. Returns the run to enqueue, or null when it merged into one
   * that is already queued.
   */
  async queueWebhookRefs(row: Connector, externalIds: string[]): Promise<ConnectorRun | null> {
    if (!row.enabled) return null;

    const queued = await this.prisma.connectorRun.findFirst({
      where: { connectorId: row.id, status: 'queued', direction: 'pull' },
      orderBy: { createdAt: 'desc' },
    });

    if (queued) {
      // A queued run with no scope is a full sync and already covers everything.
      const scope = Array.isArray(queued.scope) ? (queued.scope as unknown as string[]) : null;
      if (scope) {
        const merged = [...new Set([...scope, ...externalIds])];
        await this.prisma.connectorRun.update({
          where: { id: queued.id },
          data: { scope: merged as Prisma.InputJsonValue },
        });
      }
      return null;
    }

    return this.prisma.connectorRun.create({
      data: {
        connectorId: row.id,
        workspaceId: row.workspaceId,
        direction: 'pull',
        trigger: 'webhook',
        status: 'queued',
        scope: [...new Set(externalIds)] as Prisma.InputJsonValue,
        locale: row.locale,
      },
    });
  }

  async listRuns(connectorId: string, limit = 20): Promise<ConnectorRunInfo[]> {
    const rows = await this.prisma.connectorRun.findMany({
      where: { connectorId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toRunInfo);
  }

  async getRun(runId: string): Promise<ConnectorRunInfo> {
    const row = await this.prisma.connectorRun.findUnique({ where: { id: runId } });
    if (!row) throw new NotFoundException(t('error.connector.runNotFound', { id: runId }));
    return toRunInfo(row);
  }

  // --- internals ---

  private encrypt(plaintext: string | null): string | null {
    if (plaintext === null || plaintext === '') return null;
    try {
      return encryptSecret(plaintext, this.key);
    } catch (err) {
      if (err instanceof MissingEncryptionKeyError) {
        throw new BadRequestException(t('error.connector.encryptionKeyMissing'));
      }
      throw err;
    }
  }

  /** Required fields present, and every URL run through the shared SSRF guard. */
  private async validateConfig(kind: ConnectorKind, config: Record<string, string>): Promise<void> {
    const info = connectorKindInfo(kind);
    if (!info) throw new BadRequestException(t('error.connector.unknownKind', { kind }));

    for (const field of info.fields) {
      const value = config[field.key];
      const present = typeof value === 'string' && value.trim() !== '';
      if (field.required && !present) {
        throw new BadRequestException(t('error.connector.missingField', { kind: info.label, field: field.label }));
      }
      if (present && /url$/i.test(field.key)) {
        await assertSafeExternalUrl(String(value), this.allowPrivateUrls, {
          invalid: 'error.connector.urlInvalid',
          notHttps: 'error.connector.urlNotHttps',
          unresolved: 'error.connector.hostUnresolved',
          private: 'error.connector.urlPrivate',
        });
      }
    }
  }

  private checkDirection(kind: ConnectorKind, direction: ConnectorDirection): ConnectorDirection {
    const info = connectorKindInfo(kind);
    if ((direction === 'push' || direction === 'both') && !info?.capabilities.push) {
      throw new BadRequestException(t('error.connector.pushNotSupported', { kind: info?.label ?? kind }));
    }
    return direction;
  }

  private async toSummary(row: Connector): Promise<ConnectorSummary> {
    const info = connectorKindInfo(row.kind);
    const [linkCount, lastRun] = await Promise.all([
      this.prisma.connectorLink.count({ where: { connectorId: row.id } }),
      this.prisma.connectorRun.findFirst({ where: { connectorId: row.id }, orderBy: { createdAt: 'desc' } }),
    ]);

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      kind: row.kind as ConnectorKind,
      name: row.name,
      enabled: row.enabled,
      config: (row.config ?? {}) as Record<string, string>,
      hasCredential: row.credential !== null,
      credentialHint: row.credentialHint,
      canStoreSecrets: this.canStoreSecrets,
      projectId: row.projectId,
      parentId: row.parentId,
      category: row.category as DocumentCategory,
      direction: row.direction as ConnectorDirection,
      conflict: row.conflict as ConnectorConflictPolicy,
      pushOnPublish: row.pushOnPublish,
      syncMode: row.syncMode as ConnectorSyncMode,
      preserveHierarchy: row.preserveHierarchy,
      syncIntervalMinutes: row.syncIntervalMinutes,
      hasWebhookSecret: row.webhookSecret !== null,
      webhookPath: row.webhookSecret ? `/v1/connectors/${row.id}/webhook` : null,
      capabilities: info?.capabilities ?? { pull: false, push: false, webhook: false, tree: false },
      linkCount,
      lastRun: lastRun ? toRunInfo(lastRun) : null,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/**
 * `awaitingReview` is not a column: it is counted from the item rows by the
 * caller that has them, exactly as `MergeRequestsService.statsFor` batches
 * thread counts rather than denormalising them. Callers without the count pass
 * nothing and get 0, which is right for a push run and for a list row.
 */
export function toRunInfo(row: ConnectorRun, awaitingReview = 0): ConnectorRunInfo {
  return {
    id: row.id,
    connectorId: row.connectorId,
    workspaceId: row.workspaceId,
    direction: row.direction as ConnectorRunDirection,
    trigger: row.trigger as ConnectorTrigger,
    status: row.status as ConnectorRunStatus,
    mode: row.mode as ConnectorSyncMode,
    phase: (row.phase as ConnectorRunPhase | null) ?? null,
    stage: row.stage,
    progress: row.progress,
    created: row.created,
    updated: row.updated,
    skipped: row.skipped,
    failed: row.failed,
    conflicts: row.conflicts,
    discovered: row.discovered,
    applied: row.applied,
    reverted: row.reverted,
    awaitingReview,
    warnings: Array.isArray(row.warnings) ? (row.warnings as unknown as ConnectorRunWarning[]) : [],
    error: (row.error as { message: string } | null) ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export { MAX_WARNINGS };
