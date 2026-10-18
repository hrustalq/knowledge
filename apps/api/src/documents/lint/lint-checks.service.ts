import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AgentFinding,
  LintGateState,
  LintPolicy,
  LintPolicySettings,
  ListMergeRequestChecksResponse,
  MergeRequestCheckCounts,
  MergeRequestCheckInfo,
  MergeRequestCheckKind,
  MergeRequestCheckReason,
  MergeRequestCheckStatus,
} from '@knowledge/contracts';
import type { Env } from '../../config/env.js';
import { AgentRegistryService } from '../../agents/agent-registry.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { t } from '../../i18n/t.js';
import { LINT_AGENT_KEY, errorRuleIds, lintGate, resolveLintPolicy } from './lint-check.js';

/**
 * The read side of merge request checks (#74) and the lint policy every part
 * of it obeys. Controller-free and worker-safe, so the trigger, the settings
 * routes and the merge gate read one resolution of the policy — and the
 * merge gate and the widget one reading of the gate.
 */
@Injectable()
export class LintChecksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AgentRegistryService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  get ceiling(): LintPolicy {
    return this.config.get('STYLE_LINT_POLICY', { infer: true });
  }

  /** The policy of the workspace (projectId null) or of one of its projects. */
  async policyFor(workspaceId: string, projectId: string | null): Promise<LintPolicySettings> {
    const [workspace, project, linter] = await Promise.all([
      this.prisma.workspaceSettings.findUnique({ where: { workspaceId }, select: { lintPolicy: true } }),
      projectId
        ? this.prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { lintPolicy: true } })
        : Promise.resolve(null),
      this.registry.resolve(workspaceId, LINT_AGENT_KEY),
    ]);
    if (projectId && !project) throw new NotFoundException(t('error.project.notInWorkspace', { id: projectId }));
    return resolveLintPolicy({
      workspaceId,
      projectId,
      ceiling: this.ceiling,
      workspacePolicy: workspace?.lintPolicy,
      projectPolicy: project?.lintPolicy,
      linterEnabled: linter.enabled,
    });
  }

  /** Set one scope's own policy; null goes back to inheriting. */
  async setPolicy(
    workspaceId: string,
    projectId: string | null,
    policy: LintPolicy | null,
    actorId?: string,
  ): Promise<LintPolicySettings> {
    if (projectId) {
      const updated = await this.prisma.project.updateMany({ where: { id: projectId, workspaceId }, data: { lintPolicy: policy } });
      if (updated.count === 0) throw new NotFoundException(t('error.project.notInWorkspace', { id: projectId }));
    } else {
      await this.prisma.workspaceSettings.upsert({
        where: { workspaceId },
        create: { workspaceId, lintPolicy: policy, updatedBy: actorId ?? null },
        update: { lintPolicy: policy, updatedBy: actorId ?? null },
      });
    }
    return this.policyFor(workspaceId, projectId);
  }

  /**
   * Every check of a merge request, newest first, with the policy of its page
   * and what the gate says about its current head. `enforced` is whether the
   * gate applies to the caller (see `lintGate`).
   */
  async list(mergeRequestId: string, enforced: boolean): Promise<ListMergeRequestChecksResponse> {
    const mr = await this.prisma.mergeRequest.findUnique({
      where: { id: mergeRequestId },
      include: { sourceBranch: { select: { headRevisionId: true } }, document: { select: { workspaceId: true, projectId: true } } },
    });
    if (!mr) throw new NotFoundException(t('error.mergeRequest.notFound', { id: mergeRequestId }));

    const rows = await this.prisma.mergeRequestCheck.findMany({
      where: { mergeRequestId },
      orderBy: { createdAt: 'desc' },
    });
    const head = mr.sourceBranch.headRevisionId;
    const currentRow = rows.find((r) => r.kind === 'lint' && r.headRevisionId === head) ?? null;
    const runIds = rows.map((r) => r.agentRunId).filter((id): id is string => !!id);
    const [runs, open, policy, blockingCount] = await Promise.all([
      runIds.length
        ? this.prisma.agentRun.findMany({ where: { id: { in: runIds } }, select: { id: true, status: true } })
        : Promise.resolve([]),
      this.prisma.mergeRequestThread.groupBy({
        by: ['checkId'],
        where: { mergeRequestId, checkId: { not: null }, resolvable: true, resolved: false },
        _count: { _all: true },
      }),
      this.policyFor(mr.document.workspaceId, mr.document.projectId),
      currentRow?.status === 'failed' ? this.blockingCount(currentRow.id, currentRow.agentRunId) : Promise.resolve(0),
    ]);
    const runStatus = new Map(runs.map((r) => [r.id, r.status]));
    const unresolved = new Map(open.map((g) => [g.checkId!, g._count._all]));

    const checks = rows.map(
      (row): MergeRequestCheckInfo => ({
        checkId: row.id,
        mergeRequestId: row.mergeRequestId,
        kind: row.kind as MergeRequestCheckKind,
        headRevisionId: row.headRevisionId,
        current: row.headRevisionId === head,
        // `running` is the run's state, not the check's: derived, never stored.
        status:
          row.status === 'pending' && row.agentRunId && runStatus.get(row.agentRunId) === 'running'
            ? 'running'
            : (row.status as MergeRequestCheckStatus),
        reason: (row.reason as MergeRequestCheckReason | null) ?? null,
        styleguideId: row.styleguideId,
        agentRunId: row.agentRunId,
        counts: (row.counts as MergeRequestCheckCounts | null) ?? null,
        unresolved: unresolved.get(row.id) ?? 0,
        override:
          row.overriddenAt && row.overriddenBy
            ? { by: row.overriddenBy, at: row.overriddenAt.toISOString(), reason: row.overrideReason ?? '' }
            : null,
        createdAt: row.createdAt.toISOString(),
        publishedAt: row.publishedAt?.toISOString() ?? null,
      }),
    );
    const current = currentRow ? checks.find((c) => c.checkId === currentRow.id)! : null;
    const gate = lintGate({
      policy: policy.effective,
      enforced,
      check: current ? { id: current.checkId, status: current.status, overridden: !!current.override } : null,
      blockingCount,
    });
    return { mergeRequestId, policy, gate, checks };
  }

  /** The gate alone — what `MergeRequestsService.merge` asks. */
  async gate(mergeRequestId: string, enforced: boolean): Promise<LintGateState> {
    return (await this.list(mergeRequestId, enforced)).gate;
  }

  /**
   * Open lint threads of a check that cite an error-severity rule. A standing
   * violation's thread is re-pointed at the newest check when it publishes, so
   * the current check's threads are every violation the head still has.
   */
  private async blockingCount(checkId: string, agentRunId: string | null): Promise<number> {
    if (!agentRunId) return 0;
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId }, select: { findings: true } });
    const rules = errorRuleIds(Array.isArray(run?.findings) ? (run.findings as unknown as AgentFinding[]) : []);
    if (rules.size === 0) return 0;
    return this.prisma.mergeRequestThread.count({
      where: { checkId, resolvable: true, resolved: false, ruleId: { in: [...rules] } },
    });
  }
}
