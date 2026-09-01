import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { GraphQueryModule } from './graph/graph-query.module.js';
import { IngestionAdminModule } from './ingestion/ingestion-admin.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { SearchModule } from './search/search.module.js';
import { EntitiesModule } from './entities/entities.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    AuthModule,
    DocumentsModule,
    SearchModule,
    EntitiesModule,
    GraphQueryModule,
    IngestionAdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
