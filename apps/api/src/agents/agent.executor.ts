import { Injectable } from '@nestjs/common';
import type { AgentRun } from '@prisma/client';
import { t } from '../i18n/t.js';
import { withAgentRun } from '../ai/agent-run-context.js';
import { projectOfRun } from '../ai/run-project.js';
import { isPrivateRun } from '../ai/run-privacy.js';
import type { Principal } from '../auth/principal.js';
import { WORKSPACE_AUDIENCE } from '../permissions/access-scope.js';
import type { ResolvedAgent } from './agent-registry.service.js';
import {
  AgentServices,
  runBrief,
  type AgentReporter,
  type AgentRunResult,
} from './agent-services.js';
import { AGENT_RUNNERS } from './agent-runners.js';

/**
 * Runs a background agent (docs/features/20).
 *
 * The division of labour is the same one the rest of this codebase draws
 * between deterministic and inferred facts: what the database already knows —
 * which pages exist, which have no relations, when each last changed — is
 * gathered by query, and the model is spent only on the part that is genuinely
 * judgement. That keeps a run cheap, keeps its orphan findings exactly right,
 * and means a workspace with no model configured still gets the half of the
 * answer that never needed one.
 *
 * Each agent is a runner in `runners/` (#823); this class only opens the run's
 * context, looks the runner up, and stamps the run. The collaborators and the
 * shared helpers live on `AgentServices`.
 */
@Injectable()
export class AgentExecutor extends AgentServices {
  /**
   * `principal` is the run's rehydrated owner, already authorised by the
   * processor. It is passed down rather than re-derived so a runner that
   * calls an API-shaped service (the glossarist calls the same `suggest` the
   * settings page calls) bills and authorises as that same person.
   */
  async run(
    run: AgentRun,
    agent: ResolvedAgent,
    principal: Principal,
    report: AgentReporter,
  ): Promise<AgentRunResult> {
    // Every model call below is billed to this run (#305), and the run is
    // stamped with what produced it whether it succeeds or fails.
    const projectId = await this.attribute(run);
    return withAgentRun(
      { agentKey: agent.key, agentRunId: run.id, projectId },
      async () => {
        try {
          // Memory recall needs a real request to search on: a run with no brief
          // (no note, no webhook body) would only recall on its description.
          const brief = runBrief(run.input);
          const memory = this.memory;
          if (brief && memory)
            this.setMemoryGrounding(run.id, async () => {
              // A run's summary and findings are listed to the workspace, so it
              // recalls only project banks every member could read — never the
              // owner's personal bank, never a restricted project's.
              const grounding = await memory.ground({
                principal,
                workspaceId: run.workspaceId,
                agentKey: agent.key,
                projectId,
                userId: principal.userId,
                query: brief,
                audience: WORKSPACE_AUDIENCE,
              });
              return grounding.text;
            });
          const result = await this.dispatch(run, agent, principal, report);
          // Fire-and-forget, like an assistant turn: retention never fails or
          // delays a run that finished. Same audience as the recall; a private
          // run (a memo's, a restricted project's drift check) is its owner's
          // alone, so it is not copied into a shared bank.
          void memory
            ?.remember({
              principal,
              workspaceId: run.workspaceId,
              agentKey: agent.key,
              projectId,
              userId: principal.userId,
              locale: principal.locale,
              sourceId: run.id,
              sourceKind: 'agent-run',
              question:
                brief || run.subjectKey || agent.description || agent.name,
              answer: [
                result.summary,
                ...result.findings.map((finding) => JSON.stringify(finding)),
              ].join('\n\n'),
              audience: WORKSPACE_AUDIENCE,
              shareWithProject: !isPrivateRun(run),
            })
            .catch((error: unknown) =>
              this.logger.warn(
                `Agent run ${run.id} memory retention failed: ${String(error)}`,
              ),
            );
          return result;
        } finally {
          this.clearMemoryGrounding(run.id);
          await this.stamp(run, agent);
        }
      },
    );
  }

  /**
   * The project this run is about (#927), stamped on the row the first time it
   * starts. Attribution is bookkeeping: a failed lookup leaves the run
   * unattributed and never stops it.
   */
  private async attribute(run: AgentRun): Promise<string | null> {
    if (run.projectId) return run.projectId;
    try {
      const projectId = await projectOfRun(this.prisma, run);
      if (projectId)
        await this.prisma.agentRun.updateMany({
          where: { id: run.id, projectId: null },
          data: { projectId },
        });
      return projectId;
    } catch (error) {
      this.logger.warn(
        `Agent run ${run.id} could not be attributed to a project: ${String(error)}`,
      );
      return null;
    }
  }

  private async dispatch(
    run: AgentRun,
    agent: ResolvedAgent,
    principal: Principal,
    report: AgentReporter,
  ): Promise<AgentRunResult> {
    const runner = AGENT_RUNNERS.get(agent.key);
    // The API refuses an agent with no runner before queueing it (RUNNABLE_AGENTS);
    // anything reaching here got past that, so failing loudly beats running an
    // agent as if it had done something.
    if (!runner)
      throw new Error(t('error.ai.agentNoExecutor', { key: agent.key }));
    return runner.run(this, run, agent, principal, report);
  }
}
