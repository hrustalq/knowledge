import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AccessService } from '../auth/access.service.js';
import { FeaturesService } from '../auth/features.service.js';
import type { Principal } from '../auth/principal.js';
import type { Env } from '../config/env.js';
import type { Audience } from '../permissions/access-scope.js';
import { PermissionService } from '../permissions/permission.service.js';
import {
  MemoryAccessService,
  type MemoryCaller,
  type MemoryRole,
} from './memory-access.service.js';
import { MemoryBanksService } from './memory-banks.service.js';
import type { RetainItem } from './memory-facts.js';
import { MemoryRecallService } from './memory-recall.service.js';
import { MemoryRetainService } from './memory-retain.service.js';
import type { RecallResult } from './memory-wire.js';

export const personalMemoryBankId = (
  agentKey: string,
  userId: string,
): string => `agent:${agentKey}:user:${userId}`;
export const projectMemoryBankId = (projectId: string): string =>
  `project:${projectId}`;

interface MemoryTarget {
  kind: 'personal' | 'project';
  bankId: string;
  projectId: string | null;
  agentKey: string | null;
  ownerId: string | null;
  name: string;
  mission: string;
}

export interface AgentMemoryInput {
  principal: Principal;
  workspaceId: string;
  agentKey: string;
  projectId?: string | null;
  /**
   * Set when the output is read by more people than the principal — a background run's summary
   * and findings are listed to the workspace. Personal memory is then neither recalled nor retained,
   * and project banks are only those visible under the scope clamped to this audience.
   */
  audience?: Audience;
}

/** What a recall handed the model, and whether any of it came from the person's own bank. */
export interface MemoryGrounding {
  text: string;
  personal: boolean;
}

const PERSONAL_RECALL_TOKENS = 1024;
const PROJECT_RECALL_TOKENS = 2048;
const INPUT_CHARS = 12_000;

/** The two banks a run reads and writes. Personal context never becomes project context by being recalled together. */
export function memoryTargets(
  input: Pick<AgentMemoryInput, 'agentKey' | 'projectId'> & { userId: string },
): MemoryTarget[] {
  const personal: MemoryTarget = {
    kind: 'personal',
    bankId: personalMemoryBankId(input.agentKey, input.userId),
    projectId: null,
    agentKey: input.agentKey,
    ownerId: input.userId,
    name: `${input.agentKey} · personal`,
    mission:
      'Remember this user’s durable preferences, decisions and working context for this agent. These are not shared project requirements.',
  };
  return input.projectId ? [personal, projectTarget(input.projectId)] : [personal];
}

function projectTarget(projectId: string): MemoryTarget {
  return {
    kind: 'project',
    bankId: projectMemoryBankId(projectId),
    projectId,
    agentKey: null,
    ownerId: null,
    name: 'Project memory',
    mission:
      'Remember durable requirements, constraints, decisions and lessons learned by agents working in this project. Keep personal preferences out.',
  };
}

/** One memory a project bank handed back for ticket context (#1194), with the bank it came from. */
export interface ProjectRecall {
  bankId: string;
  result: RecallResult;
}

@Injectable()
export class MemoryRuntimeService {
  private readonly logger = new Logger(MemoryRuntimeService.name);

  constructor(
    private readonly auth: AccessService,
    private readonly features: FeaturesService,
    private readonly permissions: PermissionService,
    private readonly access: MemoryAccessService,
    private readonly agents: AgentRegistryService,
    private readonly banks: MemoryBanksService,
    private readonly recall: MemoryRecallService,
    private readonly retain: MemoryRetainService,
    config: ConfigService<Env, true>,
  ) {
    this.minSemantic = config.get('MEMORY_RUNTIME_MIN_SEMANTIC', { infer: true });
  }

  /**
   * Cosine below which a recalled memory is not relevant to the turn (#1187). Without it the vector leg hands back the
   * bank's nearest rows for any question, so a non-empty personal bank marked every turn personal and kept the thread
   * out of project memory. Keyword matches are kept: a shared word is relevance the floor cannot see.
   */
  private readonly minSemantic: number;

  /** Recall both scopes as untrusted grounding. Empty means memory is off, empty, or unavailable; the agent run still proceeds. */
  async ground(
    input: AgentMemoryInput & { query: string; userId: string },
  ): Promise<MemoryGrounding> {
    const none: MemoryGrounding = { text: '', personal: false };
    try {
      const caller = await this.caller(input, 'viewer');
      if (!caller || !input.query.trim()) return none;
      const visible = await this.access.visible(caller.scope, this.targetsFor(input));
      const blocks = await Promise.all(
        visible.map(async (target) => {
          try {
            const bank = await this.banks.runtimeBank(caller, target, { create: false });
            if (!bank) return null;
            const { text, results } = await this.recall.recallForModel(
              bank,
              {
                query: input.query,
                maxTokens:
                  target.kind === 'personal'
                    ? PERSONAL_RECALL_TOKENS
                    : PROJECT_RECALL_TOKENS,
                preferObservations: true,
                userId: input.userId,
                minScores: { semantic: this.minSemantic },
              },
              'agent-memory',
            );
            if (!results.length) return null;
            const label =
              target.kind === 'personal'
                ? 'Your earlier work with this user:'
                : 'Earlier agent work in this project:';
            return { kind: target.kind, text: `${label}\n${text}` };
          } catch (error) {
            this.logger.warn({
              msg: 'agent memory recall skipped',
              workspaceId: input.workspaceId,
              bankId: target.bankId,
              error: String(error),
            });
            return null;
          }
        }),
      );
      const recalled = blocks.filter((b) => b !== null);
      return {
        text: recalled.map((b) => b.text).join('\n\n'),
        personal: recalled.some((b) => b.kind === 'personal'),
      };
    } catch (error) {
      this.logger.warn({
        msg: 'agent memory grounding skipped',
        workspaceId: input.workspaceId,
        error: String(error),
      });
      return none;
    }
  }

  /**
   * Ticket context (#1194): the project banks of `projectIds` the caller may read, never a personal one — a CLI caller
   * has no runtime personal bank. Only memories that passed the semantic floor: the keyword leg ORs the query's words,
   * so on a ticket-length query it matches nearly anything, and "nothing relevant" must stay a possible answer.
   * Best first across banks. Empty when memory is off or the caller may not read; never throws.
   */
  async recallProjects(input: { principal: Principal; workspaceId: string; projectIds: string[]; query: string; limit: number }): Promise<ProjectRecall[]> {
    try {
      const caller = await this.caller(input, 'viewer');
      if (!caller || !input.projectIds.length || !input.query.trim()) return [];
      const visible = await this.access.visible(caller.scope, input.projectIds.map(projectTarget));
      const perBank = await Promise.all(
        visible.map(async (target) => {
          const bank = await this.banks.runtimeBank(caller, target, { create: false });
          if (!bank) return [];
          const { results } = await this.recall.recall(bank, {
            query: input.query,
            maxTokens: PROJECT_RECALL_TOKENS,
            preferObservations: true,
            entities: false,
            userId: input.principal.userId,
            minScores: { semantic: this.minSemantic },
          });
          return results.filter((r) => r.scores?.semantic != null).map((result) => ({ bankId: target.bankId, result }));
        }),
      );
      return perBank
        .flat()
        .sort((a, b) => (b.result.scores?.semantic ?? 0) - (a.result.scores?.semantic ?? 0))
        .slice(0, input.limit);
    } catch (error) {
      this.logger.warn({ msg: 'ticket context memory skipped', workspaceId: input.workspaceId, error: String(error) });
      return [];
    }
  }

  /**
   * Retain one turn/run independently in each scope. The source id makes a retry replace its own facts instead of duplicating them.
   * The project bank gets a copy only when `shareWithProject` (the caller vouches the turn used no private input of its own:
   * no personal memory, draft or attachment) and the scope it ran under could read nothing that project's readers cannot.
   * Never throws: a turn or run that finished is never failed or held by its memory.
   */
  async remember(
    input: AgentMemoryInput & {
      userId: string;
      sourceId: string;
      sourceKind: 'assistant-turn' | 'agent-run' | 'mention-reply';
      question: string;
      answer: string;
      shareWithProject: boolean;
    },
  ): Promise<void> {
    try {
      const caller = await this.caller(input, 'editor');
      if (!caller) return;
      const question = input.question.trim().slice(0, INPUT_CHARS);
      const answer = input.answer.trim().slice(0, INPUT_CHARS);
      if (!question || !answer) return;
      const agent = await this.agents.resolve(input.workspaceId, input.agentKey).catch((error: unknown) => {
        this.logger.warn({
          msg: 'agent memory policy unavailable',
          workspaceId: input.workspaceId,
          agentKey: input.agentKey,
          error: String(error),
        });
        return null;
      });
      if (!agent) return;
      const shared =
        input.shareWithProject &&
        !!input.projectId &&
        (await this.access.withinProjectAudience(caller.scope, input.projectId));
      const eligible = this.targetsFor(input).filter(
        (target) => agent.memoryPolicy[target.kind] !== 'off' && (target.kind === 'personal' || shared),
      );
      if (!eligible.length) return;
      const targets = await this.access.visible(caller.scope, eligible);
      for (const target of targets) {
        try {
          const bank = await this.banks.runtimeBank(caller, target, { create: true });
          if (!bank) {
            this.logger.warn({ msg: 'agent memory bank id held by another bank', workspaceId: input.workspaceId, bankId: target.bankId });
            continue;
          }
          const item: RetainItem = {
            content: `Request:\n${question}\n\nOutcome:\n${answer}`,
            context:
              target.kind === 'personal'
                ? `Agent ${input.agentKey} working with this user`
                : `Agent ${input.agentKey} working in this project`,
            timestamp: new Date().toISOString(),
            metadata: {
              agent_key: input.agentKey,
              source_kind: input.sourceKind,
              memory_scope: target.kind,
            },
            documentId: `${input.sourceKind}:${input.sourceId}`,
            entities: [],
            tags: [
              `agent:${input.agentKey}`,
              `runtime:${input.sourceKind}`,
              `scope:${target.kind}`,
            ],
            append: false,
          };
          await this.retain.retain({
            workspaceId: input.workspaceId,
            bank,
            userId: input.userId,
            items: [item],
            durableOnly: agent.memoryPolicy[target.kind] === 'durable',
          });
        } catch (error) {
          this.logger.warn({
            msg: 'agent memory retain skipped',
            workspaceId: input.workspaceId,
            bankId: target.bankId,
            error: String(error),
          });
        }
      }
    } catch (error) {
      this.logger.warn({
        msg: 'agent memory retention skipped',
        workspaceId: input.workspaceId,
        error: String(error),
      });
    }
  }

  /** The banks this call may touch: both, or — for output an audience reads — the project's alone. */
  private targetsFor(input: AgentMemoryInput & { userId: string }): MemoryTarget[] {
    const targets = memoryTargets(input);
    return input.audience ? targets.filter((target) => target.kind === 'project') : targets;
  }

  /** Runtime memory is best-effort. In particular a viewer recalls but does not retain, matching the public memory API. */
  private async caller(
    input: Pick<AgentMemoryInput, 'principal' | 'workspaceId' | 'audience'>,
    role: MemoryRole,
  ): Promise<MemoryCaller | null> {
    try {
      if (this.features.unavailable().includes('memory')) return null;
      await this.auth.requireRole(input.principal, input.workspaceId, role);
      await this.features.require(input.workspaceId, 'memory');
      const scope = await this.permissions.scopeFor(input.principal, input.workspaceId);
      return {
        principal: input.principal,
        workspaceId: input.workspaceId,
        scope: input.audience ? await this.permissions.audienceScope(scope, input.audience) : scope,
      };
    } catch (error) {
      this.logger.debug({
        msg: 'agent memory unavailable',
        workspaceId: input.workspaceId,
        role,
        error: String(error),
      });
      return null;
    }
  }
}
