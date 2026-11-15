import { Injectable, Logger } from '@nestjs/common';
import type { Locale } from '@knowledge/contracts';
import { AccessService } from '../auth/access.service.js';
import { FeaturesService } from '../auth/features.service.js';
import type { Principal } from '../auth/principal.js';
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
  const project: MemoryTarget | null = input.projectId
    ? {
        kind: 'project',
        bankId: projectMemoryBankId(input.projectId),
        projectId: input.projectId,
        agentKey: null,
        ownerId: null,
        name: 'Project memory',
        mission:
          'Remember durable requirements, constraints, decisions and lessons learned by agents working in this project. Keep personal preferences out.',
      }
    : null;
  return project ? [personal, project] : [personal];
}

@Injectable()
export class MemoryRuntimeService {
  private readonly logger = new Logger(MemoryRuntimeService.name);

  constructor(
    private readonly auth: AccessService,
    private readonly features: FeaturesService,
    private readonly permissions: PermissionService,
    private readonly access: MemoryAccessService,
    private readonly banks: MemoryBanksService,
    private readonly recall: MemoryRecallService,
    private readonly retain: MemoryRetainService,
  ) {}

  /** Recall both scopes as untrusted grounding. Empty means memory is off, empty, or unavailable; the agent run still proceeds. */
  async ground(
    input: AgentMemoryInput & { query: string; userId: string },
  ): Promise<string> {
    try {
      const caller = await this.caller(input, 'viewer');
      if (!caller || !input.query.trim()) return '';
      const targets = memoryTargets(input);
      const visible = await this.access.visible(caller.scope, targets);
      const blocks = await Promise.all(
        visible.map(async (target) => {
          try {
            const bank = await this.access.find(caller, target.bankId);
            if (!bank) return '';
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
              },
              'agent-memory',
            );
            if (!results.length) return '';
            const label =
              target.kind === 'personal'
                ? 'Your earlier work with this user:'
                : 'Earlier agent work in this project:';
            return `${label}\n${text}`;
          } catch (error) {
            this.logger.warn({
              msg: 'agent memory recall skipped',
              workspaceId: input.workspaceId,
              bankId: target.bankId,
              error: String(error),
            });
            return '';
          }
        }),
      );
      return blocks.filter(Boolean).join('\n\n');
    } catch (error) {
      this.logger.warn({
        msg: 'agent memory grounding skipped',
        workspaceId: input.workspaceId,
        error: String(error),
      });
      return '';
    }
  }

  /** Retain one turn/run independently in each scope. The source id makes a retry replace its own facts instead of duplicating them. */
  async remember(
    input: AgentMemoryInput & {
      userId: string;
      locale: Locale;
      sourceId: string;
      sourceKind: 'assistant-turn' | 'agent-run';
      question: string;
      answer: string;
    },
  ): Promise<void> {
    const caller = await this.caller(input, 'editor');
    if (!caller) return;
    const question = input.question.trim().slice(0, INPUT_CHARS);
    const answer = input.answer.trim().slice(0, INPUT_CHARS);
    if (!question || !answer) return;
    const targets = await this.access.visible(
      caller.scope,
      memoryTargets(input),
    );
    for (const target of targets) {
      try {
        const bank = await this.banks.ensure(caller, target.bankId, target);
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
          locale: input.locale,
          items: [item],
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
  }

  /** Runtime memory is best-effort. In particular a viewer recalls but does not retain, matching the public memory API. */
  private async caller(
    input: AgentMemoryInput,
    role: MemoryRole,
  ): Promise<MemoryCaller | null> {
    try {
      if (this.features.unavailable().includes('memory')) return null;
      await this.auth.requireRole(input.principal, input.workspaceId, role);
      await this.features.require(input.workspaceId, 'memory');
      return {
        principal: input.principal,
        workspaceId: input.workspaceId,
        scope: await this.permissions.scopeFor(
          input.principal,
          input.workspaceId,
        ),
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
