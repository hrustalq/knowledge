import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import type { Notification, User } from '@prisma/client';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { asLocale } from '../i18n/locale.js';
import { t } from '../i18n/t.js';
import { MAIL_QUEUE } from './mail.constants.js';
import { isMailedReason, type MailJob } from './mail.types.js';
import {
  inviteMail,
  notificationMail,
  passwordChangedMail,
  passwordResetMail,
  verifyEmailMail,
  type Recipient,
} from './mail.templates.js';
import { MailTransport } from './mail.transport.js';

/**
 * Worker half of the mailer (docs/features/41).
 *
 * Everything about the recipient is read here, at send time: the address, the
 * language, whether the account is still enabled. A job can sit in the queue
 * through a retry backoff, and what matters is the person as they are when the
 * message leaves.
 */
@Processor(MAIL_QUEUE)
export class MailProcessor extends WorkerHost implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transport: MailTransport,
    private readonly config: ConfigService<Env, true>,
  ) {
    super();
  }

  /** Non-fatal: a worker with a broken relay still indexes; it just says so, loudly, once. */
  async onModuleInit(): Promise<void> {
    if (this.transport.transport !== 'smtp') {
      this.logger.log('MAIL_TRANSPORT=log — messages are written to this log, not sent');
      return;
    }
    const { ok, error } = await this.transport.verify();
    if (ok) this.logger.log('SMTP relay reachable and accepted the credentials');
    else this.logger.error(`SMTP relay check failed — mail will retry and then drop: ${error}`);
  }

  onModuleDestroy(): void {
    this.transport.close();
  }

  async process(job: Job<MailJob>): Promise<void> {
    const data = job.data;
    switch (data.template) {
      case 'notification':
        return this.sendNotification(data.notificationId);
      default: {
        const user = await this.prisma.user.findUnique({ where: { id: data.userId } });
        // Disabled since the job was queued: no link to an account that cannot sign in.
        if (!user || user.disabledAt) return;
        const to = recipientOf(user);
        if (data.template === 'verify-email') {
          const hours = this.config.get('AUTH_VERIFY_TTL_HOURS', { infer: true });
          return this.transport.send(user.email, verifyEmailMail(to, this.link(`/verify-email?token=${data.token}`), hours));
        }
        if (data.template === 'password-reset') {
          const minutes = this.config.get('AUTH_RESET_TTL_MIN', { infer: true });
          return this.transport.send(
            user.email,
            passwordResetMail(to, this.link(`/reset-password?token=${data.token}`), minutes),
          );
        }
        if (data.template === 'invite') {
          const hours = this.config.get('AUTH_INVITE_TTL_HOURS', { infer: true });
          return this.transport.send(
            user.email,
            inviteMail(to, this.link(`/reset-password?token=${data.token}&invite=1`), hours, data.inviter),
          );
        }
        return this.transport.send(user.email, passwordChangedMail(to, this.link('/forgot-password')));
      }
    }
  }

  /**
   * One email per inbox row. The row is claimed with a single guarded
   * statement before sending — so a coalesced bump, a second `announce`, or a
   * redelivered job finds it taken — and released if the send fails, so the
   * retry can claim it again. At most once, and at least once while retries
   * last.
   */
  private async sendNotification(notificationId: string): Promise<void> {
    if (!this.config.get('MAIL_NOTIFICATIONS_ENABLED', { infer: true })) return;
    const row = await this.prisma.notification.findUnique({ where: { id: notificationId } });
    if (!row || row.emailedAt || row.readAt || !isMailedReason(row.reason)) return;

    const user = await this.prisma.user.findUnique({ where: { id: row.userId } });
    // An unproven address is not one to send other people's words to.
    if (!user || user.disabledAt || !user.emailVerifiedAt) return;
    const pref = await this.prisma.notificationPreference.findUnique({
      where: { userId_workspaceId: { userId: row.userId, workspaceId: row.workspaceId } },
      select: { emailDirected: true },
    });
    if (pref && !pref.emailDirected) return;

    const claimed = await this.prisma.notification.updateMany({
      where: { id: row.id, emailedAt: null },
      data: { emailedAt: new Date() },
    });
    if (claimed.count === 0) return;

    const to = recipientOf(user);
    try {
      await this.transport.send(
        user.email,
        notificationMail(to, {
          reason: row.reason,
          actor: await this.actorName(row.actor, to),
          title: row.title ?? t('mail.untitled', undefined, to.locale),
          url: this.link(notificationPath(row)),
          settingsUrl: this.link('/settings/notifications'),
          alert: typeof (row.metadata as Record<string, unknown> | null)?.alert === 'string' ? String((row.metadata as Record<string, unknown>).alert) : undefined,
        }),
      );
    } catch (e) {
      await this.prisma.notification.update({ where: { id: row.id }, data: { emailedAt: null } });
      throw e;
    }
  }

  private async actorName(actor: string | null, to: Recipient): Promise<string> {
    if (actor && actor !== 'dev') {
      const user = await this.prisma.user.findUnique({ where: { id: actor }, select: { displayName: true } });
      if (user) return user.displayName;
    }
    return t('mail.someone', undefined, to.locale);
  }

  private link(path: string): string {
    return `${this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '')}${path}`;
  }
}

function recipientOf(user: User): Recipient {
  return { displayName: user.displayName, locale: asLocale(user.locale) };
}

/**
 * Where a mailed notification points. Mirrors the directed branches of the
 * web's `notificationLink` (modules/notifications/model/notification-ui.ts): a
 * merge request opens on the discussion that named you, anything else opens
 * its page, and a row with neither opens the inbox.
 */
export function notificationPath(row: Pick<Notification, 'subjectType' | 'subjectId' | 'documentId' | 'metadata'>): string {
  if (row.subjectType === 'merge-request' && row.subjectId) {
    const thread = (row.metadata as Record<string, unknown> | null)?.threadId;
    return `/merge-requests/${row.subjectId}${typeof thread === 'string' ? `?thread=${thread}` : ''}`;
  }
  if (row.documentId) return `/documents/${row.documentId}`;
  return '/notifications';
}
