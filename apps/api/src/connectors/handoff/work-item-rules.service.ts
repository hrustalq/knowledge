import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  issueRankFor,
  issueRuleAdmits,
  OPEN_KNOWLEDGE_ISSUE_STATUSES,
  scopedSetting,
  type ProjectWorkItemRules,
  type UpdateProjectWorkItemRulesRequest,
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
 *
 * A project may carry its own three rules (#923): null inherits the
 * workspace's, and an explicit `off` opts it out. The effective rule of each
 * candidate's project is resolved in the candidate SQL (`COALESCE(p.rule,
 * workspace rule)`), so a project that is off never fills a tick's budget.
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

  /** A project's rules (#923): what the workspace asked for, what the project asked for, what applies. */
  async getProject(projectId: string): Promise<ProjectWorkItemRules> {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { workspaceId: true, workItemIssues: true, workItemConflicts: true, workItemVerification: true, trackerRoute: { select: { id: true } } },
    });
    const { requested, ceiling } = await this.get(project.workspaceId);
    return {
      workspaceId: project.workspaceId,
      projectId,
      issues: scopedSetting(project.workItemIssues as WorkItemIssueRule | null, requested.issues, 'off'),
      conflicts: scopedSetting(project.workItemConflicts as WorkItemConflictRule | null, requested.conflicts, 'off'),
      verification: scopedSetting(project.workItemVerification as WorkItemVerificationRule | null, requested.verification, 'off'),
      routed: project.trackerRoute !== null,
      ceiling,
    };
  }

  /** Unlike the workspace row, a project stores `off` as itself: null there means "inherit". */
  async setProject(projectId: string, patch: UpdateProjectWorkItemRulesRequest): Promise<ProjectWorkItemRules> {
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...(patch.issues !== undefined ? { workItemIssues: patch.issues } : {}),
        ...(patch.conflicts !== undefined ? { workItemConflicts: patch.conflicts } : {}),
        ...(patch.verification !== undefined ? { workItemVerification: patch.verification } : {}),
      },
    });
    return this.getProject(projectId);
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
    const on = { notIn: ['off'] }; // also excludes null: SQL NOT IN never matches it
    const [rows, projects] = await Promise.all([
      this.prisma.workspaceSettings.findMany({
        where: { OR: [{ workItemIssues: { not: null } }, { workItemConflicts: { not: null } }, { workItemVerification: { not: null } }] },
        select: { workspaceId: true, workItemIssues: true, workItemConflicts: true, workItemVerification: true },
      }),
      // A project may turn a rule on under a workspace that has none (#923).
      this.prisma.project.findMany({
        where: { OR: [{ workItemIssues: on }, { workItemConflicts: on }, { workItemVerification: on }] },
        select: { workspaceId: true, workItemIssues: true, workItemConflicts: true, workItemVerification: true },
      }),
    ]);
    const workspaces = new Map<string, RuleScope>();
    for (const row of rows) workspaces.set(row.workspaceId, { ...row, projectIssues: false, projectConflicts: false, projectVerification: false });
    for (const p of projects) {
      const ws = workspaces.get(p.workspaceId) ?? {
        workspaceId: p.workspaceId,
        workItemIssues: null,
        workItemConflicts: null,
        workItemVerification: null,
        projectIssues: false,
        projectConflicts: false,
        projectVerification: false,
      };
      ws.projectIssues ||= isOn(p.workItemIssues);
      ws.projectConflicts ||= isOn(p.workItemConflicts);
      ws.projectVerification ||= isOn(p.workItemVerification);
      workspaces.set(p.workspaceId, ws);
    }
    let created = 0;
    for (const ws of workspaces.values()) {
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

  /**
   * Oldest first, no ticket on any connector yet, admitted by the rule of the
   * object's own project — its override, else the workspace's. A kind is
   * queried only when the workspace or one of its projects turns it on.
   */
  private async candidates(ws: RuleScope, budget: number): Promise<Array<[WorkItemSourceKind, string]>> {
    if (budget <= 0) return [];
    const out: Array<[WorkItemSourceKind, string]> = [];
    if (isOn(ws.workItemIssues) || ws.projectIssues) {
      const rule = Prisma.sql`COALESCE(p.work_item_issues, ${ws.workItemIssues ?? 'off'})`;
      const rows = await this.prisma.$queryRaw<Array<{ id: string; kind: string; report_count: number; rule: WorkItemIssueRule }>>`
        SELECT i.id, i.kind, i.report_count, ${rule} AS rule FROM knowledge_issues i
          JOIN documents d ON d.id = i.document_id
          JOIN projects p ON p.id = d.project_id
         WHERE i.workspace_id = ${ws.workspaceId}::uuid
           AND i.status = ANY(${[...OPEN_KNOWLEDGE_ISSUE_STATUSES]}::text[])
           AND ${rule} <> 'off'
           AND NOT EXISTS (SELECT 1 FROM connector_work_items w WHERE w.source_kind = 'issue' AND w.source_id = i.id)
         ORDER BY i.created_at ASC
         LIMIT ${budget * 4}`;
      for (const r of rows) {
        if (issueRuleAdmits(r.rule, issueRankFor({ kind: r.kind, reportCount: r.report_count }))) out.push(['issue', r.id]);
      }
    }
    if (isOn(ws.workItemConflicts) || ws.projectConflicts) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT c.id FROM knowledge_conflicts c
          JOIN documents d ON d.id = c.a_document_id
          JOIN projects p ON p.id = d.project_id
         WHERE c.workspace_id = ${ws.workspaceId}::uuid AND c.status = 'open'
           AND COALESCE(p.work_item_conflicts, ${ws.workItemConflicts ?? 'off'}) = 'on'
           AND NOT EXISTS (SELECT 1 FROM connector_work_items w WHERE w.source_kind = 'conflict' AND w.source_id = c.id)
         ORDER BY c.detected_at ASC
         LIMIT ${budget}`;
      out.push(...rows.map((r) => ['conflict', r.id] as [WorkItemSourceKind, string]));
    }
    if (isOn(ws.workItemVerification) || ws.projectVerification) {
      // `outdated` hands off outdated pages only; `all` adds the requested ones.
      const rule = Prisma.sql`COALESCE(p.work_item_verification, ${ws.workItemVerification ?? 'off'})`;
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT d.id FROM documents d
          JOIN projects p ON p.id = d.project_id
         WHERE d.workspace_id = ${ws.workspaceId}::uuid AND d.archived_at IS NULL
           AND ((d.verification_flag = 'outdated' AND ${rule} IN ('outdated', 'all'))
             OR (d.verification_flag = 'requested' AND ${rule} = 'all'))
           AND NOT EXISTS (SELECT 1 FROM connector_work_items w WHERE w.source_kind = 'verification' AND w.source_id = d.id)
         ORDER BY d.last_activity_at ASC
         LIMIT ${budget}`;
      out.push(...rows.map((r) => ['verification', r.id] as [WorkItemSourceKind, string]));
    }
    return out;
  }
}

/** A workspace's own rules plus whether any of its projects turns each kind on. */
interface RuleScope {
  workspaceId: string;
  workItemIssues: string | null;
  workItemConflicts: string | null;
  workItemVerification: string | null;
  projectIssues: boolean;
  projectConflicts: boolean;
  projectVerification: boolean;
}

const isOn = (rule: string | null): boolean => rule !== null && rule !== 'off';
