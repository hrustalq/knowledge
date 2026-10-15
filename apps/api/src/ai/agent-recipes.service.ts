import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AiAgent } from '@prisma/client';
import {
  AGENT_RECIPES,
  AGENT_RECIPE_KEYS,
  isValidTimezone,
  type AgentRecipeKey,
  type AgentTriggerSummary,
  type ApplyAgentRecipeResponse,
} from '@knowledge/contracts';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiAgentsService } from './ai-agents.service.js';
import { AgentTriggersService } from './agent-triggers.service.js';
import type { ApplyAgentRecipeDto } from './ai.dto.js';

/**
 * The note each recipe seeds, as an i18n key: written in the language of the
 * person applying it, and theirs to edit afterwards like any other note. Null
 * where the agent's own instructions already say everything.
 */
const RECIPE_NOTES: Record<AgentRecipeKey, string | null> = {
  'weekly-digest': null,
  'freshness-sweep': 'agent.recipe.freshnessSweepNote',
  'glossary-suggester': 'agent.recipe.glossarySuggesterNote',
};

/**
 * Applying a recipe (#70, phase 4) — the schedule and the triggers it names,
 * written through `AiAgentsService.update` and `AgentTriggersService.create`,
 * so every default and every validation those apply holds here too.
 *
 * Nothing is enabled. Whoever turns the schedule or a trigger on becomes the
 * owner its runs execute as, which is the rule both already follow; a recipe
 * is not a way round it.
 *
 * Idempotent by keeping, not by overwriting: a schedule the agent already has
 * (any shape, enabled or not) and a trigger it already has for the event stay
 * exactly as an admin left them.
 */
@Injectable()
export class AgentRecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AiAgentsService,
    private readonly triggers: AgentTriggersService,
  ) {}

  async apply(key: string, dto: ApplyAgentRecipeDto, userId: string): Promise<ApplyAgentRecipeResponse> {
    if (!(AGENT_RECIPE_KEYS as readonly string[]).includes(key)) {
      throw new NotFoundException(t('error.ai.agentRecipeNotFound', { key }));
    }
    const recipe = AGENT_RECIPES[key as AgentRecipeKey];
    if (dto.timezone && !isValidTimezone(dto.timezone)) {
      throw new BadRequestException(t('error.ai.agentScheduleBadTimezone', { zone: dto.timezone }));
    }
    const { workspaceId } = dto;
    const noteKey = RECIPE_NOTES[recipe.key];
    const note = noteKey ? t(noteKey) : null;

    let scheduleCreated = false;
    if (recipe.schedule) {
      const row = await this.prisma.aiAgent.findUnique({ where: { workspaceId_key: { workspaceId, key: recipe.agentKey } } });
      if (!hasSchedule(row)) {
        await this.agents.update(
          workspaceId,
          recipe.agentKey,
          {
            workspaceId,
            scheduleEnabled: false,
            scheduleKind: recipe.schedule.kind,
            scheduleTime: recipe.schedule.time,
            scheduleWeekdays: recipe.schedule.weekdays ?? null,
            scheduleTimezone: dto.timezone ?? null,
            scheduleNote: note,
          },
          userId,
        );
        scheduleCreated = true;
      }
    }

    const triggers: AgentTriggerSummary[] = [];
    let triggersCreated = 0;
    if (recipe.trigger) {
      const existing = await this.prisma.agentTrigger.findMany({
        where: { workspaceId, agentKey: recipe.agentKey, event: recipe.trigger.event },
        orderBy: { createdAt: 'asc' },
      });
      if (existing.length) {
        triggers.push(...existing.map((row) => this.triggers.summary(row)));
      } else {
        triggers.push(
          await this.triggers.create(
            recipe.agentKey,
            { workspaceId, event: recipe.trigger.event, note, enabled: false },
            userId,
          ),
        );
        triggersCreated = 1;
      }
    }

    return {
      recipe: recipe.key,
      agent: await this.agents.get(workspaceId, recipe.agentKey),
      triggers,
      created: { schedule: scheduleCreated, triggers: triggersCreated },
    };
  }
}

/** Any schedule shape at all — a recipe never replaces one an admin set. */
function hasSchedule(row: AiAgent | null): boolean {
  return !!row && (row.scheduleKind !== null || row.scheduleMinutes !== null || row.scheduleTime !== null);
}
