import { Injectable } from '@nestjs/common';
import {
  CONFIGURABLE_PROJECT_SETTINGS,
  type ConfigurableProjectSetting,
  type ConfigurationAppliedValue,
  type ConfigurationDiffRow,
  type ProjectSettingChangeSpec,
  type ScopedSetting,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { VerificationPolicyService } from '../verification/verification-policy.service.js';
import { ApiSettingsService } from '../api-specs/api-settings.service.js';
import { LintChecksService } from '../documents/lint/lint-checks.service.js';
import { resolveLintPolicy } from '../documents/lint/lint-check.js';
import { WorkItemRulesService } from '../connectors/handoff/work-item-rules.service.js';

/**
 * One key of a project setting as it stands (#1313): the project's own value,
 * what it would inherit and from where, and how a value is held once it is
 * asked for (`clamp`) — the setting's own resolver, never a second spelling.
 */
interface Level {
  project: unknown;
  inherited: unknown;
  inheritedSource: 'workspace' | 'default';
  clamp: (value: unknown) => { value: unknown; held: ConfigurationAppliedValue['held'] };
}

const asIs = (value: unknown) => ({ value, held: null });

/**
 * The read side of a `project-setting` change (#1313): each key it sets beside
 * today's `ScopedSetting`, read through the setting's own service — the one
 * its settings route answers with. Writes are `ConfigurationApplyService`'s.
 */
@Injectable()
export class ProjectSettingChanges {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verification: VerificationPolicyService,
    private readonly api: ApiSettingsService,
    private readonly lint: LintChecksService,
    private readonly workItems: WorkItemRulesService,
  ) {}

  /** The diff of one change, and its project's name; null when the project is not in the workspace. */
  async diff(workspaceId: string, spec: ProjectSettingChangeSpec): Promise<{ target: string; diff: ConfigurationDiffRow[] } | null> {
    const project = await this.prisma.project.findFirst({ where: { id: spec.projectId, workspaceId }, select: { name: true } });
    if (!project) return null;
    const levels = await this.levels(workspaceId, spec.projectId, spec.setting);
    const diff = Object.entries(spec.values).map(([field, after]) => {
      const level = levels[field]!;
      return {
        field,
        before: level.project,
        after: after ?? null,
        applies: { before: applied(level.project, level), after: applied(after ?? null, level) },
      };
    });
    return { target: project.name, diff };
  }

  /** Every configurable setting of one project as it stands, for the model's read tool. */
  async snapshot(workspaceId: string, projectId: string): Promise<Record<string, Record<string, ConfigurationAppliedValue & { own: unknown }>>> {
    const out: Record<string, Record<string, ConfigurationAppliedValue & { own: unknown }>> = {};
    for (const setting of CONFIGURABLE_PROJECT_SETTINGS) {
      const levels = await this.levels(workspaceId, projectId, setting);
      out[setting] = Object.fromEntries(
        Object.entries(levels).map(([key, level]) => [key, { own: level.project, ...applied(level.project, level) }]),
      );
    }
    return out;
  }

  private async levels(workspaceId: string, projectId: string, setting: ConfigurableProjectSetting): Promise<Record<string, Level>> {
    switch (setting) {
      case 'verification': {
        const { workspaceId: _w, projectId: _p, ...keys } = await this.verification.projectSettings(projectId);
        return mapScoped(keys);
      }
      case 'workItems': {
        const { issues, conflicts, verification, ceiling } = await this.workItems.getProject(projectId);
        // `autoCreate` returns at once under a zero ceiling: no rule creates anything.
        const clamp = (value: unknown) => (ceiling.maxPerTick <= 0 && value !== 'off' ? { value: 'off', held: 'ceiling' as const } : asIs(value));
        return mapScoped({ issues, conflicts, verification }, clamp);
      }
      case 'breakingChanges':
        return mapScoped({ policy: (await this.api.projectBreakingChanges(projectId)).policy });
      case 'lintPolicy': {
        const [own, workspace] = await Promise.all([this.lint.policyFor(workspaceId, projectId), this.lint.policyFor(workspaceId, null)]);
        // `resolveLintPolicy` with the value as the project's own: the clamp the merge gate applies.
        const clamp = (value: unknown) => {
          const r = resolveLintPolicy({ workspaceId, projectId, ceiling: own.ceiling, workspacePolicy: workspace.requested, projectPolicy: value as string, linterEnabled: own.linterEnabled });
          return { value: r.effective, held: r.source === 'agent-disabled' ? ('agent-off' as const) : r.source === 'ceiling' ? ('ceiling' as const) : null };
        };
        return {
          policy: {
            project: own.requested,
            // The workspace's own ask, not the clamped `inherited`, so a ceiling on it shows as held.
            inherited: workspace.requested ?? own.ceiling,
            inheritedSource: workspace.requested !== null ? 'workspace' : 'default',
            clamp,
          },
        };
      }
    }
  }
}

function mapScoped(keys: Record<string, ScopedSetting<unknown>>, clamp: Level['clamp'] = asIs): Record<string, Level> {
  return Object.fromEntries(
    Object.entries(keys).map(([key, s]) => [
      key,
      { project: s.project, inherited: s.inherited, inheritedSource: s.workspace !== null ? 'workspace' : 'default', clamp },
    ]),
  );
}

/** What applies when the project's own value is `own`: it, or the inherited value, through the setting's clamp. */
function applied(own: unknown, level: Level): ConfigurationAppliedValue {
  return own === null
    ? { ...level.clamp(level.inherited), source: level.inheritedSource }
    : { ...level.clamp(own), source: 'project' };
}
