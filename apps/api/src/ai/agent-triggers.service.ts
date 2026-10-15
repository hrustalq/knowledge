import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentTrigger, Prisma } from '@prisma/client';
import {
  AGENT_TRIGGER_FILTER_FIELDS,
  agentTriggerEventsFor,
  type AgentTriggerEvent,
  type AgentTriggerFilter,
  type AgentTriggerSummary,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { RUNNABLE_AGENTS } from '../agents/agent.executor.js';
import { filterOf } from '../agents/agent-trigger.service.js';
import type { CreateAgentTriggerDto, UpdateAgentTriggerDto } from './ai.dto.js';

/**
 * Agent trigger configuration (#70) — the admin side. Firing lives in
 * `AgentTriggerService`; this only writes the rows it reads.
 *
 * The owner is never a field: it is whoever turns the trigger on, the
 * `AiAgent.scheduleOwner` rule, so an admin cannot point unattended runs at
 * somebody else's identity and budget.
 */
@Injectable()
export class AgentTriggersService {
  private readonly defaultCooldown: number;
  readonly listening: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AgentRegistryService,
    config: ConfigService<Env, true>,
  ) {
    this.defaultCooldown = Number(config.get('AGENT_TRIGGER_COOLDOWN_MINUTES', { infer: true }) ?? 60);
    this.listening = config.get('AGENT_TRIGGERS_ENABLED', { infer: true }) === true;
  }

  async list(workspaceId: string): Promise<AgentTriggerSummary[]> {
    const rows = await this.prisma.agentTrigger.findMany({
      where: { workspaceId },
      orderBy: [{ agentKey: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toTriggerSummary);
  }

  async create(agentKey: string, dto: CreateAgentTriggerDto, userId: string): Promise<AgentTriggerSummary> {
    await this.assertTriggerable(dto.workspaceId, agentKey, dto.event);
    const fields = await this.fieldsFrom(dto.workspaceId, dto.event, dto, null);
    const row = await this.prisma.agentTrigger.create({
      data: {
        workspaceId: dto.workspaceId,
        agentKey,
        event: dto.event,
        cooldownMinutes: this.defaultCooldown,
        ...fields,
        enabled: dto.enabled === true,
        ownerId: dto.enabled === true ? userId : null,
        createdBy: userId,
      },
    });
    return toTriggerSummary(row);
  }

  async update(id: string, dto: UpdateAgentTriggerDto, userId: string): Promise<AgentTriggerSummary> {
    const existing = await this.require(id);
    const fields = await this.fieldsFrom(existing.workspaceId, existing.event as AgentTriggerEvent, dto, existing);
    const row = await this.prisma.agentTrigger.update({
      where: { id },
      data: {
        ...fields,
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        // Whoever turns it on owns what it starts.
        ...(dto.enabled === true ? { ownerId: userId } : {}),
      },
    });
    return toTriggerSummary(row);
  }

  async remove(id: string): Promise<AgentTrigger> {
    const existing = await this.require(id);
    await this.prisma.agentTrigger.delete({ where: { id } });
    return existing;
  }

  private async require(id: string): Promise<AgentTrigger> {
    const row = await this.prisma.agentTrigger.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(t('error.ai.agentTriggerNotFound', { id }));
    return row;
  }

  /**
   * Refused here, where an admin can be told, rather than skipped on every
   * event: a trigger on an agent with no executor, or a repository reader on
   * an event that names no repository, would never start anything.
   */
  private async assertTriggerable(workspaceId: string, agentKey: string, event: AgentTriggerEvent): Promise<void> {
    const agent = await this.registry.resolve(workspaceId, agentKey).catch(() => null);
    if (!agent) throw new NotFoundException(t('error.ai.agentNotFound', { key: agentKey }));
    if (!agent.surfaces.includes('background') || !RUNNABLE_AGENTS.has(agentKey)) {
      throw new BadRequestException(t('error.ai.agentNotBackground', { key: agentKey }));
    }
    if (!agentTriggerEventsFor(agentKey).includes(event)) {
      throw new BadRequestException(t('error.ai.agentTriggerNeedsRepository', { key: agentKey }));
    }
  }

  /** The columns a create or update writes, validated against this workspace. */
  private async fieldsFrom(
    workspaceId: string,
    event: AgentTriggerEvent,
    dto: UpdateAgentTriggerDto,
    existing: AgentTrigger | null,
  ): Promise<{ projectId?: string | null; filter?: Prisma.InputJsonValue; cooldownMinutes?: number; note?: string | null }> {
    if (dto.projectId) {
      const project = await this.prisma.project.findUnique({ where: { id: dto.projectId }, select: { workspaceId: true } });
      if (project?.workspaceId !== workspaceId) {
        throw new BadRequestException(t('error.ai.agentTriggerProjectInvalid', { id: dto.projectId }));
      }
    }
    if (dto.connectorIds?.length) {
      const ids = [...new Set(dto.connectorIds)];
      const found = await this.prisma.connector.count({ where: { id: { in: ids }, workspaceId } });
      if (found !== ids.length) {
        throw new BadRequestException(t('error.ai.agentTriggerConnectorInvalid', { ids: ids.join(', ') }));
      }
    }

    const touchesFilter = dto.categories !== undefined || dto.connectorIds !== undefined || dto.branch !== undefined;
    const filter = touchesFilter ? mergeFilter(event, filterOf(existing?.filter), dto) : undefined;
    return {
      ...(dto.projectId !== undefined ? { projectId: dto.projectId } : {}),
      ...(filter ? { filter: filter as Prisma.InputJsonValue } : {}),
      ...(dto.cooldownMinutes !== undefined ? { cooldownMinutes: dto.cooldownMinutes } : {}),
      ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
    };
  }
}

/** An update's filter fields over the stored ones: absent keeps, null clears. */
export function mergeFilter(
  event: AgentTriggerEvent,
  stored: AgentTriggerFilter,
  dto: Pick<UpdateAgentTriggerDto, 'categories' | 'connectorIds' | 'branch'>,
): AgentTriggerFilter {
  const pick = <K extends keyof AgentTriggerFilter>(key: K): AgentTriggerFilter[K] | undefined => {
    const sent = dto[key];
    return sent === undefined ? stored[key] : ((sent ?? undefined) as AgentTriggerFilter[K] | undefined);
  };
  const categories = [...new Set((pick('categories') ?? []).map((c) => c.trim()).filter(Boolean))];
  const connectorIds = [...new Set(pick('connectorIds') ?? [])];
  const branch = pick('branch')?.trim();
  const merged: AgentTriggerFilter = {
    ...(categories.length ? { categories } : {}),
    ...(connectorIds.length ? { connectorIds } : {}),
    ...(branch ? { branch } : {}),
  };
  const allowed = AGENT_TRIGGER_FILTER_FIELDS[event];
  return Object.fromEntries(
    Object.entries(merged).filter(([key]) => allowed.includes(key as keyof AgentTriggerFilter)),
  ) as AgentTriggerFilter;
}

export function toTriggerSummary(row: AgentTrigger): AgentTriggerSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    agentKey: row.agentKey,
    event: row.event as AgentTriggerEvent,
    filter: filterOf(row.filter),
    enabled: row.enabled,
    ownerId: row.ownerId,
    cooldownMinutes: row.cooldownMinutes,
    note: row.note,
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
