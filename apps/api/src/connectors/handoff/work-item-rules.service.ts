import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  issueRankFor,
  issueRuleAdmits,
  OPEN_KNOWLEDGE_ISSUE_STATUSES,
  type WorkItemConflictRule,
  type WorkItemIssueRule,
  type WorkItemRules,
  type WorkItemRulesResponse,
  type WorkItemSourceKind,
  type WorkItemVerificationRule,
} from '@knowledge/contracts';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { WorkItemAnchorsService } from './work-item-anchors.service.js';
import { WorkItemHandoffService } from './work-item-handoff.service.js';

/**
 * Handoff rules (#424): three nullable columns on `workspace_settings`, each
 * null = off, so an empty table hands nothing off — and an env ceiling,
 * `WORK_ITEM_AUTOCREATE_MAX_PER_TICK`, on how many tickets all of them may
 * create per sweeper tick. A rule turned on over a backlog drains it at that
 * pace instead of filing hundreds of tickets at once.
 *
 * A rule hands off only into a project's tracker route. A project without
 * one gets nothing — there is no person to pick a tracker for it.
 */
@Injectable()
export class WorkItemRulesService {
  private readonly logger = new Logger(WorkItemRulesService.name);
  private readonly maxPerTick: number;
  private readonly syncEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly anchors: WorkItemAnchorsService,
    private readonly handoffs: WorkItemHandoffService,
    config: ConfigService<Env, true>,
  ) {
    this.maxPerTick = config.get('WORK_ITEM_AUTOCREATE_MAX_PER_TICK', { infer: true });
    this.syncEnabled = config.get('WORK_ITEM_SYNC_ENABLED', { infer: true });
  }

  async get(workspaceId: string): Promise<WorkItemRulesResponse> {
    const row = await this.prisma.workspaceSettings.findUnique({
      where: { workspaceId },
      select: { workItemIssues: true, workItemConflicts: true, workItemVerification: true },
    });
    return {
      workspaceId,
      requested: {
        issues: (row?.workItemIssues as WorkItemIssueRule | null) ?? null,
        conflicts: (row?.workItemConflicts as WorkItemConflictRule | null) ?? null,
        verification: (row?.workItemVerification as WorkItemVerificationRule | null) ?? null,
      },
      ceiling: { maxPerTick: this.maxPerTick, syncEnabled: this.syncEnabled },
    };
  }

  async set(workspaceId: string, rules: WorkItemRules, actorId: string): Promise<WorkItemRulesResponse> {
    // `off` is stored as null: one spelling of "nothing happens".
    const data = {
      workItemIssues: rules.issues === 'off' ? null : rules.issues,
      workItemConflicts: rules.conflicts === 'off' ? null : rules.conflicts,
      workItemVerification: rules.verification === 'off' ? null : rules.verification,
      updatedBy: actorId,
    };
    await this.prisma.workspaceSettings.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data });
    return this.get(workspaceId);
  }

  /**
   * One tick: the oldest objects every rule admits that have no ticket yet,
   * handed off until the ceiling. Returns how many tickets were created.
   *
   * A candidate whose project has no route, or whose tracker refuses, is
   * skipped and comes back next tick.
   * ponytail: a tracker that keeps refusing costs up to `maxPerTick` failed
   * calls a tick; add a per-anchor backoff if that shows up in the logs.
   */
  async autoCreate(): Promise<number> {
    if (this.maxPerTick <= 0) return 0;
    const workspaces = await this.prisma.workspaceSettings.findMany({
      where: { OR: [{ workItemIssues: { not: null } }, { workItemConflicts: { not: null } }, { workItemVerification: { not: null } }] },
      select: { workspaceId: true, workItemIssues: true, workItemConflicts: true, workItemVerification: true },
    });
    let created = 0;
    for (const ws of workspaces) {
      for (const [kind, id] of await this.candidates(ws, this.maxPerTick - created)) {
        if (created >= this.maxPerTick) return created;
        try {
          const view = await this.anchors.describe(ws.workspaceId, kind, id);
          if (view && (await this.handoffs.handoffByRule(view))) created += 1;
        } catch (err) {
          this.logger.warn(`rule handoff of ${kind} ${id} failed: ${(err as Error).message}`);
        }
      }
    }
    return created;
  }

  /** Oldest first, no ticket on any connector yet, admitted by the workspace's rules. */
  private async candidates(
    ws: { workspaceId: string; workItemIssues: string | null; workItemConflicts: string | null; workItemVerification: string | null },
    budget: number,
  ): Promise<Array<[WorkItemSourceKind, string]>> {
    if (budget <= 0) return [];
    const out: Array<[WorkItemSourceKind, string]> = [];
    const issueRule = ws.workItemIssues as WorkItemIssueRule | null;
    if (issueRule && issueRule !== 'off') {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; kind: string; report_count: number }>>`
        SELECT i.id, i.kind, i.report_count FROM knowledge_issues i
         WHERE i.workspace_id = ${ws.workspaceId}::uuid
           AND i.status = ANY(${[...OPEN_KNOWLEDGE_ISSUE_STATUSES]}::text[])
           AND NOT EXISTS (SELECT 1 FROM connector_work_items w WHERE w.source_kind = 'issue' AND w.source_id = i.id)
         ORDER BY i.created_at ASC
         LIMIT ${budget * 4}`;
      for (const r of rows) {
        if (issueRuleAdmits(issueRule, issueRankFor({ kind: r.kind, reportCount: r.report_count }))) out.push(['issue', r.id]);
      }
    }
    if (ws.workItemConflicts === 'on') {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT c.id FROM knowledge_conflicts c
         WHERE c.workspace_id = ${ws.workspaceId}::uuid AND c.status = 'open'
           AND NOT EXISTS (SELECT 1 FROM connector_work_items w WHERE w.source_kind = 'conflict' AND w.source_id = c.id)
         ORDER BY c.detected_at ASC
         LIMIT ${budget}`;
      out.push(...rows.map((r) => ['conflict', r.id] as [WorkItemSourceKind, string]));
    }
    const flagRule = ws.workItemVerification as WorkItemVerificationRule | null;
    if (flagRule && flagRule !== 'off') {
      const flags = flagRule === 'outdated' ? ['outdated'] : ['outdated', 'requested'];
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT d.id FROM documents d
         WHERE d.workspace_id = ${ws.workspaceId}::uuid AND d.archived_at IS NULL
           AND d.verification_flag = ANY(${flags}::text[])
           AND NOT EXISTS (SELECT 1 FROM connector_work_items w WHERE w.source_kind = 'verification' AND w.source_id = d.id)
         ORDER BY d.last_activity_at ASC
         LIMIT ${budget}`;
      out.push(...rows.map((r) => ['verification', r.id] as [WorkItemSourceKind, string]));
    }
    return out;
  }
}
