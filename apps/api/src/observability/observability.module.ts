import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { configureBacktest } from '@knowledge/observability';
import type { Env } from '../config/env.js';
import { OpsSinkService } from './ops-sink.service.js';

/**
 * Applies the env-configured observability settings once DI exists.
 *
 * The same shape as I18nRegistry: the backtest stream is a module-level
 * singleton in @knowledge/observability so that free functions can emit without
 * being injected, but its configuration comes from validated env, which is only
 * readable through ConfigService. This provider is the bridge. Before it runs —
 * and it runs at boot — every emit is a no-op, which is the same graceful
 * degradation t() has before I18nRegistry parks the service.
 *
 * Registered in BootstrapModule, so all three Nest entrypoints get it.
 */
@Injectable()
export class ObservabilityRegistry implements OnModuleInit {
  constructor(private readonly config: ConfigService<Env, true>) {}

  onModuleInit(): void {
    configureBacktest({
      enabled: this.config.get('OPS_JSONL_ENABLED', { infer: true }),
      dir: this.config.get('LOG_DIR', { infer: true }),
    });
  }
}

// PrismaModule is @Global() and registered by all three entrypoint modules
// (App/Worker/Mcp), which is what lets a Prisma-dependent provider live here in
// the shared prelude rather than in AppModule alone.
@Module({ providers: [ObservabilityRegistry, OpsSinkService] })
export class ObservabilityModule {}
