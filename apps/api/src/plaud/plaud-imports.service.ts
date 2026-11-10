import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PlaudImport, PlaudLink, Prisma } from '@prisma/client';
import {
  type PlaudImportEntry,
  type PlaudImportStatus,
  type PlaudRules,
  type PlaudSettingsResponse,
} from '@knowledge/contracts';
import type { Principal } from '../auth/principal.js';
import type { Env } from '../config/env.js';
import { currentLocale, t } from '../i18n/t.js';
import { MemosService } from '../memos/memos.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { effectiveRules, listFrom, picks } from './plaud-rules.js';
import { PlaudService } from './plaud.service.js';

/** Rows a person can still say yes or no to. */
const OPEN: PlaudImportStatus[] = ['waiting', 'pending', 'confirmed', 'failed'];
/** How many waiting recordings one pass asks Plaud about, oldest first. */
const CHECK_BATCH = 20;
const DAY_MS = 86_400_000;
/** The least time between two looks at one account that a person can ask for. */
const REFRESH_FLOOR_MS = 30_000;

/**
 * Plaud auto-import (#864): a person's pick rules, the recordings those rules
 * picked, and the yes or no on each. API-side only — an import is the
 * person's act, so it happens where their principal exists.
 *
 * Every read and write is the caller's own: rows are matched on `user_id`
 * and the workspace of the request, and anything else is simply not found.
 */
@Injectable()
export class PlaudImportsService {
  private readonly logger = new Logger(PlaudImportsService.name);
  private readonly maxPerDay: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly plaud: PlaudService,
    private readonly memos: MemosService,
    config: ConfigService<Env, true>,
  ) {
    this.maxPerDay = config.get('PLAUD_AUTO_IMPORT_MAX_PER_DAY', { infer: true });
  }

  async settings(userId: string, workspaceId: string): Promise<PlaudSettingsResponse> {
    const link = await this.prisma.plaudLink.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    return this.toSettings(link, userId, workspaceId);
  }

  /** `projectId: null` switches auto-import off here and keeps the rules. */
  async saveSettings(userId: string, workspaceId: string, input: { projectId: string | null; rules: PlaudRules }): Promise<PlaudSettingsResponse> {
    if (input.projectId) {
      const project = await this.prisma.project.findFirst({ where: { id: input.projectId, workspaceId }, select: { id: true } });
      if (!project) throw new BadRequestException(t('error.project.notFound', { id: input.projectId }));
    }
    const data = { projectId: input.projectId, rules: clean(input.rules) as Prisma.InputJsonValue, locale: currentLocale() };
    const link = await this.prisma.plaudLink.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, ...data },
      update: data,
    });
    return this.toSettings(link, userId, workspaceId);
  }

  /** The row the sweeper keeps the sign-in alive through, from the moment of linking; settings already saved are left alone. */
  async ensure(userId: string, workspaceId: string): Promise<void> {
    await this.prisma.plaudLink.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, locale: currentLocale() },
      update: {},
    });
  }

  async list(userId: string, workspaceId: string, status?: PlaudImportStatus): Promise<PlaudImportEntry[]> {
    const rows = await this.prisma.plaudImport.findMany({
      where: { workspaceId, userId, ...(status ? { status } : {}) },
      orderBy: [{ startAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return rows.map(toEntry);
  }

  /**
   * Yes to these recordings. A transcribed one is imported now; one Plaud has
   * not transcribed is marked `confirmed` and imported by the sweeper when it
   * has. Ids that are not the caller's open rows are ignored.
   */
  async confirm(principal: Principal, workspaceId: string, ids: string[]): Promise<PlaudImportEntry[]> {
    const rows = await this.prisma.plaudImport.findMany({
      where: { id: { in: ids }, workspaceId, userId: principal.userId, status: { in: OPEN } },
      include: { link: true },
    });
    const out: PlaudImportEntry[] = [];
    for (const row of rows) out.push(toEntry(await this.import(principal, row.link, row, 'confirmed')));
    return out;
  }

  /**
   * "Transcribe here" for one recording Plaud has not transcribed: the
   * person's explicit yes to our own speech-to-text, never taken by the
   * sweeper. A refusal (allowance, budget, length, transcription off) goes
   * back to the person as it is and leaves the row where it was.
   */
  async transcribe(principal: Principal, workspaceId: string, id: string): Promise<PlaudImportEntry> {
    const row = await this.prisma.plaudImport.findFirst({
      where: { id, workspaceId, userId: principal.userId, status: { in: ['waiting', 'confirmed', 'failed'] } },
      include: { link: true },
    });
    if (!row) throw new NotFoundException(t('error.memo.plaudImportNotFound'));
    if (!row.link.projectId) throw new ConflictException(t('error.memo.plaudNoProject'));
    const memo = await this.memos.transcribePlaud(principal, { workspaceId, projectId: row.link.projectId, fileId: row.externalId });
    return toEntry(await this.prisma.plaudImport.update({ where: { id: row.id }, data: { status: 'imported', memoId: memo.memoId, error: null } }));
  }

  /**
   * "Check now" (#873): the caller's own pass, without waiting for the
   * sweeper's turn. It takes the link through the same `checked_at` claim, so
   * it never runs beside a sweep and cannot be used to hammer Plaud; inside
   * the floor it only answers the list as it stands. Nobody is notified: the
   * person is looking at the queue.
   */
  async refresh(principal: Principal, workspaceId: string, now = new Date()): Promise<PlaudImportEntry[]> {
    const userId = principal.userId;
    const floor = new Date(now.getTime() - REFRESH_FLOOR_MS);
    const claimed = await this.prisma.plaudLink.updateMany({
      where: { workspaceId, userId, OR: [{ checkedAt: null }, { checkedAt: { lt: floor } }] },
      data: { checkedAt: now },
    });
    const link = claimed.count ? await this.prisma.plaudLink.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } }) : null;
    if (link) {
      await this.sweepLink(principal, link, now).catch((err: unknown) => this.logger.warn(`Plaud link ${link.id} was not refreshed: ${(err as Error).message}`));
    }
    return this.list(userId, workspaceId);
  }

  /** No to these recordings, for good: a skipped recording is never offered again. */
  async skip(userId: string, workspaceId: string, ids: string[]): Promise<PlaudImportEntry[]> {
    await this.prisma.plaudImport.updateMany({
      where: { id: { in: ids }, workspaceId, userId, status: { in: OPEN } },
      data: { status: 'skipped', error: null },
    });
    return (await this.prisma.plaudImport.findMany({ where: { id: { in: ids }, workspaceId, userId } })).map(toEntry);
  }

  /** Everything of the person's, in every workspace: called when they unlink. */
  async forget(userId: string): Promise<void> {
    await this.prisma.plaudLink.deleteMany({ where: { userId } });
  }

  /**
   * One pass over one person's settings, as that person (#864): find
   * recordings the rules pick, then move the ones Plaud has transcribed
   * forward. Returns how many newly wait for a yes, for the one notification.
   *
   * Nothing of a recording is read here beyond its listing and whether it has
   * a transcript; the transcript itself is fetched by the import.
   */
  async sweepLink(principal: Principal, link: PlaudLink, now = new Date()): Promise<{ pending: number; linked: boolean }> {
    if (!link.projectId) return { pending: 0, linked: true };
    const rules = effectiveRules(link.rules as PlaudRules, link.createdAt);
    const recordings = await this.plaud.list(link.userId, listFrom(rules, now));
    if (recordings === null) return { pending: 0, linked: false };

    const picked = recordings.filter((r) => picks(rules, r));
    if (picked.length) {
      // The unique index decides: a recording already known — skipped ones included — is left alone.
      await this.prisma.plaudImport.createMany({
        skipDuplicates: true,
        data: picked.map((r) => ({
          linkId: link.id,
          workspaceId: link.workspaceId,
          userId: link.userId,
          externalId: r.id,
          name: r.name.slice(0, 300),
          startAt: parsed(r.startAt),
          durationSeconds: r.durationSeconds,
        })),
      });
    }

    const due = await this.prisma.plaudImport.findMany({
      where: { linkId: link.id, status: { in: ['waiting', 'confirmed'] } },
      orderBy: { updatedAt: 'asc' },
      take: CHECK_BATCH,
    });
    let pending = 0;
    let imported = await this.importedToday(link, now);
    for (const row of due) {
      const ready = await this.plaud.transcribed(link.userId, row.externalId);
      if (ready === null) return { pending, linked: false };
      if (!ready) {
        // Touched, so the next pass asks about the ones it did not reach.
        await this.prisma.plaudImport.update({ where: { id: row.id }, data: { updatedAt: now } });
        continue;
      }
      if (row.status === 'waiting' && rules.confirm === 'ask') {
        const moved = await this.prisma.plaudImport.updateMany({ where: { id: row.id, status: 'waiting' }, data: { status: 'pending' } });
        pending += moved.count;
        continue;
      }
      // Auto mode stops at the day's cap; a recording the person confirmed is their own yes and still goes through.
      if (row.status === 'waiting' && imported >= this.maxPerDay) continue;
      const done = await this.import(principal, link, row, row.status as 'waiting' | 'confirmed');
      if (done.status === 'imported') imported += 1;
    }
    return { pending, linked: true };
  }

  /**
   * Imports one row as the person. `plaud-not-transcribed` is not a failure:
   * the row goes (back) to `unready`. Anything else is recorded on the row in
   * the person's language and can be confirmed again.
   */
  private async import(principal: Principal, link: PlaudLink, row: PlaudImport, unready: 'waiting' | 'confirmed'): Promise<PlaudImport> {
    let data: Prisma.PlaudImportUpdateInput;
    try {
      if (!link.projectId) throw new ConflictException(t('error.memo.plaudNoProject'));
      const memo = await this.memos.importPlaud(principal, { workspaceId: link.workspaceId, projectId: link.projectId, fileId: row.externalId });
      data = { status: 'imported', memoId: memo.memoId, error: null };
    } catch (err) {
      const reason = err instanceof HttpException ? (err.getResponse() as { reason?: string }).reason : undefined;
      if (reason === 'plaud-not-transcribed') data = { status: unready, error: null };
      else {
        if (!(err instanceof HttpException)) this.logger.warn(`Plaud import ${row.id} failed: ${(err as Error).message}`);
        // An HttpException's message is ours and translated; anything else is not shown.
        data = { status: 'failed', error: (err instanceof HttpException ? err.message : t('error.memo.plaudFailed')).slice(0, 500) };
      }
    }
    return this.prisma.plaudImport.update({ where: { id: row.id }, data });
  }

  /** Read from the rows that exist, not a counter: this person's Plaud imports of the last day, confirmed ones included. */
  private async importedToday(link: PlaudLink, now: Date): Promise<number> {
    return this.prisma.plaudImport.count({
      where: { linkId: link.id, status: 'imported', updatedAt: { gte: new Date(now.getTime() - DAY_MS) } },
    });
  }

  private async toSettings(link: PlaudLink | null, userId: string, workspaceId: string): Promise<PlaudSettingsResponse> {
    const rules = (link?.rules ?? {}) as PlaudRules;
    const { since, minSeconds, confirm } = effectiveRules(rules, link?.createdAt ?? new Date());
    return {
      projectId: link?.projectId ?? null,
      rules,
      effective: { since, minSeconds, confirm },
      maxPerDay: this.maxPerDay,
      transcribe: await this.memos.plaudTranscribeAllowance(userId, workspaceId),
    };
  }
}

/** Sparse on the way in: an empty string is "no rule", not a rule that matches nothing. */
function clean(rules: PlaudRules): PlaudRules {
  return Object.fromEntries(Object.entries(rules).filter(([, v]) => v !== undefined && v !== null && v !== '')) as PlaudRules;
}

function parsed(iso: string | null): Date | null {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function toEntry(row: PlaudImport): PlaudImportEntry {
  return {
    id: row.id,
    name: row.name,
    startAt: row.startAt?.toISOString() ?? null,
    durationSeconds: row.durationSeconds,
    status: row.status as PlaudImportStatus,
    memoId: row.memoId,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}
