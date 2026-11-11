import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Memo } from '@prisma/client';
import type { MemoSegment, MemoTriage } from '@knowledge/contracts';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { AccessService } from '../auth/access.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { parseModelJson } from '../common/model-json.js';
import { Ticker } from '../common/ticker.js';
import type { Env } from '../config/env.js';
import { asLocale } from '../i18n/locale.js';
import { withLocale } from '../i18n/t.js';
import { PermissionService } from '../permissions/permission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { effectiveMemoTypes } from './memo-types.js';
import { MemosProducer } from './memos.producer.js';
import { speakerLabels } from './speakers.js';
import { readTriage, triageApplies, triageMessages } from './triage.js';

const SWEEP_INTERVAL_MS = 10_000;
const BATCH = 5;
/** A claim older than this was taken by a sweep that died mid-call, and is retaken. */
const CLAIM_LEASE_MS = 5 * 60_000;
const MAX_PROJECTS = 50;
/** What a memo is left with when triage could not run: nothing suggested, so it is analysed as it is. */
const NOTHING: MemoTriage = { type: null, projectId: null, tags: [], newType: null };

/**
 * Sorts a memo before it is analysed (#879, phase 2), API-only. It runs here
 * and not in the worker because the answer depends on who the uploader is:
 * the projects on offer are the ones they may file into now, read under
 * their own scope, and moving a memo into a type's project is their act.
 *
 * A memo with a transcript and no `triage` is claimed by stamping
 * `triaged_at` in one guarded statement (a lease, like `published_at`), then
 * asked about once. If its type is set to auto the suggestion is applied and
 * the memo goes on to the secretary; otherwise it waits in `review` for its
 * owner. Triage is **fail-open**: no model, no budget, a refused call or an
 * unreadable answer all send the memo on unsorted, because a memo stuck
 * behind a sorting step is worse than an unsorted one.
 */
@Injectable()
export class MemoTriageSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoTriageSweeper.name);
  private readonly ticker = new Ticker(this.logger);
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly permissions: PermissionService,
    private readonly agents: AgentRegistryService,
    private readonly client: AssistantClient,
    private readonly usage: AiUsageService,
    private readonly producer: MemosProducer,
    private readonly notifications: NotificationsService,
    private readonly events: EventsPublisher,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('MEMO_TRIAGE_ENABLED', { infer: true });
  }

  onModuleInit(): void {
    if (this.enabled) this.ticker.every(SWEEP_INTERVAL_MS, () => this.sweep());
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  async sweep(now = new Date()): Promise<void> {
    return this.ticker.exclusive(async () => {
      const expired = new Date(now.getTime() - CLAIM_LEASE_MS);
      const waiting = { status: 'transcribed', triage: { equals: Prisma.AnyNull }, OR: [{ triagedAt: null }, { triagedAt: { lt: expired } }] };
      const due = await this.prisma.memo.findMany({ where: waiting, orderBy: { updatedAt: 'asc' }, take: BATCH, select: { id: true } });
      for (const { id } of due) {
        const claimed = await this.prisma.memo.updateMany({ where: { id, ...waiting }, data: { triagedAt: now } });
        if (claimed.count === 0) continue;
        const memo = await this.prisma.memo.findUnique({ where: { id } });
        if (!memo) continue;
        const outcome = await withLocale(asLocale(memo.locale), () => this.triage(memo)).catch((error: unknown) => {
          this.logger.warn(`Memo ${memo.id} was not sorted, analysing it as it is: ${(error as Error).message}`);
          return { triage: NOTHING, apply: true, projectId: memo.projectId };
        });
        await this.settle(memo, outcome);
      }
    });
  }

  /** The suggestion, and whether it is applied without asking. Throws for anything that should fail open. */
  async triage(memo: Memo): Promise<{ triage: MemoTriage; apply: boolean; projectId: string }> {
    const segments = Array.isArray(memo.transcript) ? (memo.transcript as unknown as MemoSegment[]) : [];
    if (!segments.length) return { triage: NOTHING, apply: true, projectId: memo.projectId };
    const principal = await this.access.principalFor(memo.createdBy, asLocale(memo.locale));
    await this.access.requireRole(principal, memo.workspaceId, 'editor');
    const agent = await this.agents.resolve(memo.workspaceId, 'secretary');
    if (!agent.enabled || !agent.config.enabled) return { triage: NOTHING, apply: true, projectId: memo.projectId };
    await this.usage.assertWithinBudget(memo.workspaceId, principal.userId);

    const types = effectiveMemoTypes(await this.prisma.memoType.findMany({ where: { workspaceId: memo.workspaceId } })).filter((t) => !t.hidden);
    // Only projects the uploader may file into, read now and under their own scope.
    const scope = await this.permissions.scopeFor(principal, memo.workspaceId);
    const projects = new Map<string, string>();
    for (const project of await this.prisma.project.findMany({ where: { workspaceId: memo.workspaceId }, select: { id: true, name: true }, take: MAX_PROJECTS })) {
      const allowed = await this.permissions.requireLevel(scope, { type: 'project', id: project.id }, 'view').then(
        () => true,
        () => false,
      );
      if (allowed) projects.set(project.id, project.name);
    }

    // Names only, and only when there is a speaker to put one to (#880).
    const labels = speakerLabels(segments);
    const members = new Map<string, string>();
    if (labels.length) {
      const rows = await this.prisma.workspaceMember.findMany({ where: { workspaceId: memo.workspaceId }, select: { userId: true }, take: 2000 });
      for (const u of await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, displayName: true } })) {
        members.set(u.id, u.displayName);
      }
    }

    const { system, user } = triageMessages(segments, { types, projects, members });
    const raw = await this.client.chat(
      { config: agent.config, userId: principal.userId, operation: 'memo-triage', locale: principal.locale },
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { json: true },
    );
    const triage = readTriage(parseModelJson(raw), { types, projects, members }, labels);
    // An auto type's own project, when the uploader may file there; otherwise the memo stays where it arrived.
    const wanted = types.find((t) => t.key === triage.type)?.projectId;
    return { triage, apply: triageApplies(triage, types), projectId: wanted && projects.has(wanted) ? wanted : memo.projectId };
  }

  /**
   * One guarded write per memo. Applied: the type, the project `triage`
   * resolved and the tags, then on to the secretary. Not applied: the
   * suggestion is kept and the memo waits.
   */
  private async settle(memo: Memo, outcome: { triage: MemoTriage; apply: boolean; projectId: string }): Promise<void> {
    const { triage } = outcome;
    const stored = triage as unknown as Prisma.InputJsonValue;
    if (!outcome.apply) {
      const waiting = await this.prisma.memo.updateMany({ where: { id: memo.id, status: 'transcribed' }, data: { status: 'review', triage: stored } });
      // Said once, to the uploader alone: their memo will not be read until they answer.
      if (waiting.count) {
        const delivered = await this.notifications.notify({
          workspaceId: memo.workspaceId,
          userIds: [memo.createdBy],
          type: 'memo.review',
          reason: 'author',
          actor: null,
          title: memo.title,
          metadata: { memoId: memo.id },
        });
        await this.events.announce(memo.workspaceId, delivered);
      }
      return;
    }
    const moved = await this.prisma.memo.updateMany({
      where: { id: memo.id, status: 'transcribed' },
      data: { triage: stored, type: triage.type, tags: triage.tags, projectId: outcome.projectId },
    });
    if (moved.count) await this.producer.enqueue(memo.id);
  }
}
