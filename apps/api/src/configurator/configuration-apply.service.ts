import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DRIFT_CHECK_CONFIG_KEY, type ConfigurationChange, type ConfigurationProposal } from '@knowledge/contracts';
import { ReadCache, READ_CACHE_FAMILIES } from '../cache/read-cache.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../auth/access.service.js';
import type { Principal } from '../auth/principal.js';
import { ActivityService } from '../activity/activity.service.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AiAgentsService } from '../ai/ai-agents.service.js';
import { AgentTriggersService } from '../ai/agent-triggers.service.js';
import { ConnectorsService } from '../connectors/connectors.service.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { VerificationPolicyService } from '../verification/verification-policy.service.js';
import { ApiSettingsService } from '../api-specs/api-settings.service.js';
import { LintChecksService } from '../documents/lint/lint-checks.service.js';
import { WorkItemRulesService } from '../connectors/handoff/work-item-rules.service.js';
import { lockSubject } from '../common/subject-lock.js';
import { t } from '../i18n/t.js';
import { ConfiguratorService, changesOf, requiresFor, toProposal } from './configurator.service.js';

/**
 * Applying a configuration proposal (#1250) — a person's act, never the model's.
 *
 * Every rule here is the one the change's own settings screen already applies,
 * because the change goes through that screen's service: `AiAgentsService.update`,
 * `AgentTriggersService.create`, `ConnectorsService.update`, `WorkflowsService.create`,
 * `TemplatesService.create`, and for a project setting its route's service
 * (`VerificationPolicyService`, `WorkItemRulesService`, `ApiSettingsService`,
 * `LintChecksService`), recorded with the activity action their route records
 * (workflows and templates record their own, as their routes rely on; of the
 * project settings only the lint route records one). On top of that, two checks on execution:
 *
 *   1. the role each picked change requires, for the caller, before anything is
 *      written — an editor who drafted a proposal cannot apply a workspace-level
 *      change from it, nor a project setting of a project they do not maintain
 *      (403, nothing written);
 *   2. each change assessed again against the workspace as it is now, so one
 *      somebody configured by hand since the proposal was written lands as
 *      `unavailable`, not as a duplicate.
 *
 * All or nothing: the picked changes apply in one transaction under the
 * proposal's lock, so a refusal on the third change leaves the first two
 * unwritten, and two admins pressing Apply together apply once.
 */
@Injectable()
export class ConfigurationApplyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
    private readonly registry: AgentRegistryService,
    private readonly agents: AiAgentsService,
    private readonly triggers: AgentTriggersService,
    private readonly connectors: ConnectorsService,
    private readonly workflows: WorkflowsService,
    private readonly templates: TemplatesService,
    private readonly configurator: ConfiguratorService,
    private readonly permissions: PermissionService,
    private readonly verification: VerificationPolicyService,
    private readonly apiSettings: ApiSettingsService,
    private readonly lint: LintChecksService,
    private readonly workItems: WorkItemRulesService,
    private readonly cache: ReadCache,
  ) {}

  async apply(id: string, workspaceId: string, changeIds: string[], principal: Principal): Promise<ConfigurationProposal> {
    const seen = await this.configurator.require(id, workspaceId, principal);
    const wanted = new Set(changeIds);
    const picked = changesOf(seen).filter((c) => wanted.has(c.id) && c.state === 'pending');
    if (!picked.length) throw new BadRequestException(t('error.configurator.nothingToApply'));
    // From the spec, as the change's own route would decide it, not the stored `requires`.
    const asked = new Map<string, () => Promise<unknown>>();
    for (const { spec } of picked) {
      const role = requiresFor(spec);
      if (role === 'maintainer' && spec.kind === 'project-setting') {
        asked.set(`project:${spec.projectId}`, () => this.permissions.requireProjectManage(principal, spec.projectId));
      } else if (role !== 'maintainer') {
        asked.set(role, () => this.access.requireRole(principal, workspaceId, role));
      }
    }
    for (const check of asked.values()) await check();

    return this.prisma.withTransaction(
      async () => {
        await lockSubject(this.prisma, `configuration-proposal:${id}`);
        // Re-read under the lock: a concurrent apply may have taken some already.
        const row = await this.prisma.configurationProposal.findUniqueOrThrow({ where: { id } });
        const now = new Date().toISOString();
        const changes: ConfigurationChange[] = [];
        for (const change of changesOf(row)) {
          if (!wanted.has(change.id) || change.state !== 'pending') {
            changes.push(change);
            continue;
          }
          const [fresh] = await this.configurator.assess(workspaceId, [{ spec: change.spec, reason: change.reason }]);
          if (fresh!.unavailable) {
            changes.push({ ...change, diff: fresh!.diff, state: 'unavailable', unavailable: fresh!.unavailable });
            continue;
          }
          const resultId = await this.applyOne(change, workspaceId, principal, id).catch((error: unknown) => {
            // Which change was refused, beside the service's own message (flat extras).
            if (error instanceof HttpException) {
              throw new HttpException({ statusCode: error.getStatus(), message: error.message, changeId: change.id }, error.getStatus());
            }
            throw error;
          });
          changes.push({ ...change, spec: fresh!.spec, state: 'applied', appliedAt: now, appliedBy: principal.userId, resultId });
        }
        const updated = await this.prisma.configurationProposal.update({
          where: { id },
          data: { changes: changes as unknown as Prisma.InputJsonValue },
        });
        return toProposal(updated);
      },
      { timeout: 20_000 },
    );
  }

  /** One change through its own writer. Returns the id of what it wrote. */
  private async applyOne(change: ConfigurationChange, workspaceId: string, principal: Principal, proposalId: string): Promise<string> {
    const { spec } = change;
    const actor = principal.userId;
    const via = { proposalId, changeId: change.id };
    switch (spec.kind) {
      case 'agent-schedule': {
        // Shape and note only, never `scheduleEnabled`: a new schedule stays off,
        // and whoever turns it on becomes the owner its runs execute as.
        const agent = await this.agents.update(
          workspaceId,
          spec.agentKey,
          {
            workspaceId,
            scheduleKind: spec.scheduleKind,
            scheduleMinutes: spec.scheduleMinutes,
            scheduleTime: spec.scheduleTime,
            scheduleWeekdays: spec.scheduleWeekdays,
            scheduleTimezone: spec.scheduleTimezone,
            ...(spec.scheduleNote === null ? {} : { scheduleNote: spec.scheduleNote }),
          },
          actor,
        );
        this.afterCommit(workspaceId, actor, 'ai.agent.updated', agent.id ?? undefined, { key: agent.key, ...via });
        return agent.id ?? spec.agentKey;
      }
      case 'agent-trigger': {
        const trigger = await this.triggers.create(
          spec.agentKey,
          { workspaceId, event: spec.event, projectId: spec.projectId, ...spec.filter, note: spec.note, enabled: false },
          actor,
        );
        this.afterCommit(workspaceId, actor, 'ai.agent.trigger.created', trigger.id, {
          key: trigger.agentKey,
          event: trigger.event,
          enabled: false,
          ...via,
        });
        return trigger.id;
      }
      case 'connector-drift-check': {
        const row = await this.connectors.require(spec.connectorId);
        const config = { ...(row.config as Record<string, string>), [DRIFT_CHECK_CONFIG_KEY]: spec.mode };
        // No installation reach: the config keeps the installation it has, which needs none.
        const connector = await this.connectors.update(spec.connectorId, { config });
        this.afterCommit(workspaceId, actor, 'connector.updated', connector.id, { title: connector.name, fields: ['config'], ...via });
        return connector.id;
      }
      case 'workflow-draft': {
        // Disabled: enabling it is a person's act in the builder, out of this proposal's reach.
        const { name, description, projectId, graph, trigger } = spec;
        const workflow = await this.workflows.create({ workspaceId, projectId, name, description, graph, trigger, enabled: false }, actor);
        return workflow.id;
      }
      case 'page-template': {
        const { name, description, projectId, source } = spec;
        const template = await this.templates.create({ workspaceId, projectId, name, description, source }, actor);
        return template.id ?? template.ref;
      }
      case 'project-setting': {
        const { projectId } = spec;
        switch (spec.setting) {
          case 'verification':
            await this.verification.updateProject(projectId, spec.values);
            // Its own invalidation ran inside this transaction; a read before the commit may have cached the old rows.
            this.prisma.onCommit(() => this.cache.invalidate(workspaceId, READ_CACHE_FAMILIES.projectHealthSettings.key()));
            break;
          case 'workItems':
            await this.workItems.setProject(projectId, spec.values);
            break;
          case 'breakingChanges':
            await this.apiSettings.setProjectBreakingChanges(projectId, spec.values.policy);
            break;
          case 'lintPolicy': {
            const settings = await this.lint.setPolicy(workspaceId, projectId, spec.values.policy, actor);
            this.afterCommit(workspaceId, actor, 'ai.lint-policy.updated', undefined, {
              projectId,
              policy: spec.values.policy,
              effective: settings.effective,
              ...via,
            });
            break;
          }
        }
        return projectId;
      }
    }
  }

  /**
   * Activity and the agent cache move only once the writes commit: a record
   * fired inside the transaction would race its end, and an invalidation before
   * the commit lets a reader cache the old rows again.
   */
  private afterCommit(workspaceId: string, actor: string, action: string, subjectId: string | undefined, metadata: Record<string, unknown>): void {
    this.prisma.onCommit(async () => {
      this.registry.invalidate(workspaceId);
      await this.activity.record({ workspaceId, actor, action, subjectId, metadata });
    });
  }
}
