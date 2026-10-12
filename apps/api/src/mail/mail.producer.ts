import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MAIL_QUEUE } from './mail.constants.js';
import type { MailJob } from './mail.types.js';

/**
 * Enqueue side of the mailer, imported by the API and the worker alike.
 *
 * Never throws into its caller — the `ActivityService.record` contract. A
 * signup must not fail because Redis blinked; the person can ask for the link
 * again, and an unsent notification mail is still a row in the inbox.
 *
 * Queued rather than sent inline for two reasons beyond retries: SMTP latency
 * stays out of the request, and `forgot-password` therefore takes the same
 * time whether or not the account exists.
 */
@Injectable()
export class MailProducer {
  private readonly logger = new Logger(MailProducer.name);

  constructor(@InjectQueue(MAIL_QUEUE) private readonly queue: Queue) {}

  async enqueue(job: MailJob): Promise<void> {
    try {
      await this.queue.add(job.template, job, {
        // One mail per inbox row even if announce() runs twice for it.
        ...(job.template === 'notification' ? { jobId: `notification-${job.notificationId}` } : {}),
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        // Kept a day for inspection, then dropped: some payloads carry a
        // short-lived token that has no business sitting in Redis for longer.
        removeOnFail: { age: 86_400 },
      });
    } catch (e) {
      this.logger.warn(`Mail enqueue failed (non-fatal, ${job.template}): ${(e as Error).message}`);
    }
  }
}
