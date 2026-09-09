import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { ConnectorProcessor } from './connector.processor.js';
import { ConnectorQueueModule } from './connector-queue.module.js';
import { ConnectorScheduleSweeper } from './connector-schedule.sweeper.js';
import { ConnectorsCoreModule } from './connectors-core.module.js';

/** Worker only: the sync processor and the schedule sweeper. */
@Module({
  imports: [ConnectorsCoreModule, ConnectorQueueModule, EventsModule],
  providers: [ConnectorProcessor, ConnectorScheduleSweeper],
})
export class ConnectorWorkerModule {}
