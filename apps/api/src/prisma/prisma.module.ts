import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService, createPrismaService } from './prisma.service.js';

@Global()
@Module({
  // useFactory, not the class: every injection site gets the transaction-aware
  // proxy (see createPrismaService). Injecting `PrismaService` by type still
  // works unchanged — the token is the class, the value is the proxy.
  providers: [
    {
      provide: PrismaService,
      useFactory: (config?: ConfigService<Env, true>) =>
        createPrismaService(config?.get('OPS_QUERY_COUNT_ENABLED', { infer: true }) ?? false),
      inject: [{ token: ConfigService, optional: true }],
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
