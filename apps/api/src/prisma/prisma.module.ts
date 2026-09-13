import { Global, Module } from '@nestjs/common';
import { PrismaService, createPrismaService } from './prisma.service.js';

@Global()
@Module({
  // useFactory, not the class: every injection site gets the transaction-aware
  // proxy (see createPrismaService). Injecting `PrismaService` by type still
  // works unchanged — the token is the class, the value is the proxy.
  providers: [{ provide: PrismaService, useFactory: createPrismaService }],
  exports: [PrismaService],
})
export class PrismaModule {}
