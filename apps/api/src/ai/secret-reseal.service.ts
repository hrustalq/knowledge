import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { decryptSecret, encryptSecret, parseKey, type SecretSlot } from './secret-box.js';
import { slots } from './secret-slots.js';

/**
 * Every column a first-format `gcm$` envelope can sit in, with how its row
 * names its slot. Mirrors {@link slots}; table and column names are SQL
 * identifiers interpolated below, so they come from this constant only.
 */
const COLUMNS: Array<{ table: string; column: string; id: string; workspace: string | null; slot: (id: string, workspaceId: string | null) => SecretSlot }> = [
  { table: 'ai_settings', column: 'api_key_cipher', id: 'workspace_id', workspace: 'workspace_id', slot: (id) => slots.aiSettingsKey(id) },
  { table: 'ai_providers', column: 'api_key_cipher', id: 'id', workspace: 'workspace_id', slot: (id, ws) => slots.aiProviderKey({ id, workspaceId: ws! }) },
  { table: 'ai_plugins', column: 'auth_value_cipher', id: 'id', workspace: 'workspace_id', slot: (id, ws) => slots.aiPluginAuth({ id, workspaceId: ws! }) },
  { table: 'agent_triggers', column: 'webhook_secret', id: 'id', workspace: 'workspace_id', slot: (id, ws) => slots.agentTriggerWebhook({ id, workspaceId: ws! }) },
  { table: 'chat_integrations', column: 'credential', id: 'id', workspace: 'workspace_id', slot: (id, ws) => slots.chatIntegration({ id, workspaceId: ws! }, 'credential') },
  { table: 'chat_integrations', column: 'signing_secret', id: 'id', workspace: 'workspace_id', slot: (id, ws) => slots.chatIntegration({ id, workspaceId: ws! }, 'signing_secret') },
  { table: 'published_sites', column: 'visitor_secret_cipher', id: 'id', workspace: 'workspace_id', slot: (id, ws) => slots.publishedSiteVisitor({ id, workspaceId: ws! }) },
  { table: 'share_links', column: 'token_cipher', id: 'id', workspace: 'workspace_id', slot: (id, ws) => slots.shareLinkToken({ id, workspaceId: ws! }) },
  { table: 'identity_providers', column: 'secret_cipher', id: 'id', workspace: 'workspace_id', slot: (id, ws) => slots.identityProviderSecret({ id, workspaceId: ws! }) },
  { table: 'connectors', column: 'webhook_secret', id: 'id', workspace: 'workspace_id', slot: (id, ws) => slots.connectorWebhook({ id, workspaceId: ws! }) },
  { table: 'api_test_environments', column: 'secrets_cipher', id: 'id', workspace: 'workspace_id', slot: (id, ws) => slots.apiTestEnvironmentSecrets({ id, workspaceId: ws! }) },
  { table: 'credentials', column: 'secret', id: 'id', workspace: null, slot: (id) => slots.credential({ id }, 'secret') },
  { table: 'credentials', column: 'refresh_secret', id: 'id', workspace: null, slot: (id) => slots.credential({ id }, 'refresh_secret') },
];

/**
 * Re-seals every first-format envelope (no AAD, readable in any row) into
 * `gcm2$`, bound to the row it sits in (#1141). Until then a legacy envelope
 * copied into another row still decrypts there. Idempotent: each UPDATE is
 * guarded on the envelope it read, so two replicas racing write once, and a
 * second pass finds nothing. An envelope this key cannot read (written under a
 * rotated key) is left alone and counted.
 */
export async function resealLegacySecrets(
  prisma: Pick<PrismaService, '$queryRawUnsafe' | '$executeRawUnsafe'>,
  key: Buffer | null,
): Promise<{ resealed: number; unreadable: number }> {
  let resealed = 0;
  let unreadable = 0;
  if (!key) return { resealed, unreadable };
  for (const c of COLUMNS) {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; workspaceId: string | null; envelope: string }>>(
      `SELECT ${c.id}::text AS id, ${c.workspace ? `${c.workspace}::text` : 'NULL'} AS "workspaceId", ${c.column} AS envelope FROM ${c.table} WHERE ${c.column} LIKE 'gcm$%'`,
    );
    for (const row of rows) {
      const slot = c.slot(row.id, row.workspaceId);
      const plain = decryptSecret(row.envelope, key, slot);
      if (plain === null) {
        unreadable++;
        continue;
      }
      resealed += await prisma.$executeRawUnsafe(
        `UPDATE ${c.table} SET ${c.column} = $1 WHERE ${c.id}::text = $2 AND ${c.column} = $3`,
        encryptSecret(plain, key, slot),
        row.id,
        row.envelope,
      );
    }
  }
  return { resealed, unreadable };
}

/** Runs the re-seal once per API boot, off the request path. API-only (AiModule). */
@Injectable()
export class SecretResealService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SecretResealService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    // Not awaited: boot does not wait on a pass that usually finds nothing.
    void resealLegacySecrets(this.prisma, parseKey(this.config.get('SETTINGS_ENCRYPTION_KEY', { infer: true })))
      .then(({ resealed, unreadable }) => {
        if (resealed || unreadable) this.logger.log(`Legacy secret envelopes: ${resealed} re-sealed, ${unreadable} unreadable under this key`);
      })
      .catch((e: unknown) => this.logger.warn(`Legacy secret re-seal failed: ${(e as Error).message}`));
  }
}
