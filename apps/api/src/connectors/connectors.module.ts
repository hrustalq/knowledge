import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ConnectorConflictSweeper } from './connector-conflict.sweeper.js';
import { ConnectorQueueModule } from './connector-queue.module.js';
import { ConnectorWebhookController } from './connector-webhook.controller.js';
import { ConnectorsCoreModule } from './connectors-core.module.js';
import { ConnectorsController } from './connectors.controller.js';

/**
 * API side (docs/features/19). Holds the controllers and the conflict sweeper,
 * which needs MergeRequestsService and therefore AccessService — the reason it
 * cannot live in the worker.
 */
@Module({
  imports: [ConnectorsCoreModule, ConnectorQueueModule, ActivityModule, DocumentsModule],
  controllers: [ConnectorsController, ConnectorWebhookController],
  providers: [ConnectorConflictSweeper],
  exports: [ConnectorsCoreModule],
})
export class ConnectorsModule {}
