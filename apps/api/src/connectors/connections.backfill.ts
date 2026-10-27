import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseKey } from '../ai/secret-box.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { bindConnection } from './connection-binding.js';

/**
 * Gives every connector that has none its connection (#564), at API boot.
 *
 * Here rather than in the migration: the provider comes from
 * `connectionProviderFor` and equal tokens are found by decrypting, and SQL
 * can do neither. Idempotent — it reads only unbound connectors, and
 * `bindConnection` reuses an equal connection before creating one. API-only,
 * so one process does it; until it has, a connector dials with its inline
 * credential exactly as before.
 */
@Injectable()
export class ConnectionsBackfill implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConnectionsBackfill.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    // Not awaited: boot must not wait on it, and nothing depends on it finishing.
    void this.run().catch((err: Error) => this.logger.warn(`connections backfill failed: ${err.message}`));
  }

  async run(): Promise<number> {
    const key = parseKey(this.config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    const rows = await this.prisma.connector.findMany({ where: { connectionId: null }, orderBy: { createdAt: 'asc' } });
    let bound = 0;
    for (const row of rows) if (await bindConnection(this.prisma, row, key)) bound++;
    if (bound) this.logger.log(`bound ${bound} connector(s) to a connection`);
    return bound;
  }
}
