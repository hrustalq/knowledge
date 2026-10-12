import { Module } from '@nestjs/common';
import { MailQueueModule } from './mail-queue.module.js';
import { MailProcessor } from './mail.processor.js';
import { MailTransport } from './mail.transport.js';

/**
 * Consumer side — imported ONLY by the worker entrypoint (worker.module.ts).
 * The transport lives here and nowhere else: the API enqueues, the worker
 * sends, so only one process ever holds an SMTP connection (docs/features/41).
 */
@Module({
  imports: [MailQueueModule],
  providers: [MailProcessor, MailTransport],
})
export class MailWorkerModule {}
