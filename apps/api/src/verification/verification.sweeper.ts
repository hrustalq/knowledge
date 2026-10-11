import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import matter from 'gray-matter';
import { ActivityService } from '../activity/activity.service.js';
import { SYSTEM_ACTOR } from '../activity/actor.js';
import type { Env } from '../config/env.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { VerificationPolicyService } from './verification-policy.service.js';

/** One tick. The deadline is a date, so a minute's lag is invisible. */
const SWEEP_INTERVAL_MS = 60_000;
/** Pages reminded or expired per tick; the next tick continues. */
const BATCH = 200;
/** Legacy head revisions whose `body_chars` one tick fills from MinIO. */
const BODY_CHARS_BATCH = 50;

interface DueRow {
  id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  owner_id: string | null;
  verified_by: string | null;
  verification_expires_at: Date;
}

/**
 * The expiry clock of page verification (docs/features/39, issue #66): tells
 * the owner that a stamp is about to run out, records when it has, and fills
 * `body_chars` for revisions indexed before the column existed.
 *
 * API-side, like `DriftPublishSweeper` and `ReportPublishSweeper`, because
 * a notification is a user-facing act and the worker has no principal. There
 * is no cron in this repo: a fixed tick, a `running` back-pressure flag, and a
 * bounded batch per pass.
 *
 * Nothing here changes what a page *reads as*. `expired` is derived by
 * `verificationStateFor` from the deadline alone, with no write; this sweeper
 * only decides when a person hears about it. Each page hears **once** per
 * stamp: the row is claimed by `expiry_reminded_at` / `expired_notified_at` in
 * one guarded `updateMany` before anything is sent, so two API replicas
 * cannot both tell the owner, and `verify` resets both stamps so the next
 * interval starts clean.
 *
 * Only a page that currently *reads* `verified` is reminded or expired: no
 * declared flag, and the stamp at the head. A page already reading
 * `requested` or `edited` has a louder state than "about to expire", and a
 * reminder on top of it would be noise.
 */
@Injectable()
export class VerificationSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VerificationSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  /** Revisions whose source could not be read this process lifetime — skipped, not retried every minute. */
  private readonly unreadable = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly policy: VerificationPolicyService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('VERIFICATION_SWEEP_ENABLED', { infer: true })) {
      this.logger.log('Verification sweeper disabled (VERIFICATION_SWEEP_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.remind(now);
      await this.expire(now);
      await this.fillBodyChars();
    } catch (error) {
      this.logger.warn(`Verification sweep failed (non-fatal): ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Stamps inside their reminder window, not yet reminded. The window is the
   * workspace's `remindBeforeDays` (its settings row, else the env default),
   * resolved in SQL so one query serves every workspace. A window of 0 days
   * selects nothing: no reminders.
   */
  async remind(now: Date): Promise<number> {
    const defaultDays = this.policy.defaults().remindBeforeDays;
    const due = await this.prisma.$queryRaw<DueRow[]>`
      SELECT d.id, d.workspace_id, d.project_id, d.title, d.owner_id, d.verified_by, d.verification_expires_at
        FROM documents d
        JOIN document_branches b ON b.document_id = d.id AND b.name = d.default_branch
        LEFT JOIN knowledge_health_settings s ON s.workspace_id = d.workspace_id
       WHERE d.archived_at IS NULL
         AND d.verification_flag IS NULL
         AND d.verified_revision_id IS NOT NULL
         AND b.head_revision_id = d.verified_revision_id
         AND d.expiry_reminded_at IS NULL
         AND d.verification_expires_at > ${now}::timestamptz
         AND d.verification_expires_at <= ${now}::timestamptz
             + make_interval(days => COALESCE(s.remind_before_days, ${defaultDays}::int))
       ORDER BY d.verification_expires_at ASC
       LIMIT ${BATCH}
    `;
    let sent = 0;
    for (const row of due) {
      const { count } = await this.prisma.document.updateMany({
        where: { id: row.id, expiryRemindedAt: null },
        data: { expiryRemindedAt: now },
      });
      if (count === 0) continue;
      sent += 1;
      await this.tell(row, 'document.verification-expiring');
    }
    if (sent > 0) this.logger.log(`Reminded ${sent} page owner(s) of a verification about to expire`);
    return sent;
  }

  /**
   * Stamps past their deadline, not yet announced. The page already reads
   * `expired` (derived); this writes the one feed row that says when, under
   * the system actor, and tells the owner.
   */
  async expire(now: Date): Promise<number> {
    const due = await this.prisma.$queryRaw<DueRow[]>`
      SELECT d.id, d.workspace_id, d.project_id, d.title, d.owner_id, d.verified_by, d.verification_expires_at
        FROM documents d
        JOIN document_branches b ON b.document_id = d.id AND b.name = d.default_branch
       WHERE d.archived_at IS NULL
         AND d.verification_flag IS NULL
         AND d.verified_revision_id IS NOT NULL
         AND b.head_revision_id = d.verified_revision_id
         AND d.expired_notified_at IS NULL
         AND d.verification_expires_at <= ${now}::timestamptz
       ORDER BY d.verification_expires_at ASC
       LIMIT ${BATCH}
    `;
    let sent = 0;
    for (const row of due) {
      const { count } = await this.prisma.document.updateMany({
        where: { id: row.id, expiredNotifiedAt: null },
        data: { expiredNotifiedAt: now },
      });
      if (count === 0) continue;
      sent += 1;
      void this.activity.record({
        workspaceId: row.workspace_id,
        actor: SYSTEM_ACTOR,
        action: 'document.verification-expired',
        documentId: row.id,
        projectId: row.project_id,
        metadata: { title: row.title, expiredAt: row.verification_expires_at.toISOString() },
        patch: { verification: 'expired' },
      });
      await this.tell(row, 'document.verification-expired');
    }
    if (sent > 0) this.logger.log(`Announced ${sent} expired verification(s)`);
    return sent;
  }

  /**
   * `body_chars` for head revisions indexed before the column existed, so the
   * dashboard's "empty" stops reading as unknown. Bounded per tick and
   * non-fatal: a revision whose source cannot be read is skipped for the rest
   * of this process rather than retried every minute. Finalized-but-unindexed
   * revisions are left to the ingestion normalizer, which writes the same
   * value.
   */
  async fillBodyChars(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; s3_key: string }>>`
      SELECT r.id, r.s3_key
        FROM document_revisions r
        JOIN document_branches b ON b.head_revision_id = r.id
       WHERE r.body_chars IS NULL
         AND r.status IN ('indexed', 'failed')
       ORDER BY r.finalized_at ASC NULLS LAST
       LIMIT ${BODY_CHARS_BATCH + this.unreadable.size}
    `;
    let filled = 0;
    for (const row of rows.filter((r) => !this.unreadable.has(r.id)).slice(0, BODY_CHARS_BATCH)) {
      try {
        const raw = await this.storage.getObjectText(row.s3_key);
        const bodyChars = matter(raw).content.trim().length;
        await this.prisma.documentRevision.updateMany({ where: { id: row.id, bodyChars: null }, data: { bodyChars } });
        filled += 1;
      } catch (error) {
        this.unreadable.add(row.id);
        this.logger.warn(`body_chars for revision ${row.id} not filled: ${(error as Error).message}`);
      }
    }
    if (filled > 0) this.logger.log(`Filled body_chars for ${filled} legacy revision(s)`);
    return filled;
  }

  /** The owner, or the last verifier of an unowned page. Nobody → nothing to send. */
  private async tell(row: DueRow, type: 'document.verification-expiring' | 'document.verification-expired'): Promise<void> {
    const recipient = row.owner_id ?? row.verified_by;
    if (!recipient) return;
    await this.notifications.notify({
      workspaceId: row.workspace_id,
      userIds: [recipient],
      type,
      reason: 'owner',
      actor: null,
      documentId: row.id,
      subjectType: 'document',
      subjectId: row.id,
      title: row.title,
      metadata: { expiresAt: row.verification_expires_at.toISOString() },
    });
  }
}
