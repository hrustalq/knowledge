import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HISTORY_AUDIENCES,
  PUBLISH_MODES,
  scopedSetting,
  type EditingPolicyResponse,
  type HistoryAudience,
  type PublishMode,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ttlCache } from '../common/ttl-cache.js';
import { AuditService } from './audit.service.js';

const POLICY_TTL_MS = 30_000;

const SELECT = { publishMode: true, historyAudience: true, requiredApprovals: true } as const;

/** A stored value a later release dropped from its vocabulary reads as unset. */
const known = <T extends string>(list: readonly T[], value: string | null | undefined): T | null =>
  (list as readonly string[]).includes(value ?? '') ? (value as T) : null;

/**
 * How a workspace wants edits to reach a page (#958): publish mode, history
 * audience, required approvals. One resolved answer read at the point of each
 * write, merge and history read, cached as `FeaturesService` caches: a write
 * drops this process's copy, others catch up within POLICY_TTL_MS.
 */
@Injectable()
export class EditingPolicyService {
  private readonly cache = ttlCache<EditingPolicyResponse>(POLICY_TTL_MS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
  ) {}

  policy(workspaceId: string): Promise<EditingPolicyResponse> {
    return this.cache.get(workspaceId, async () => {
      const row = await this.prisma.workspaceSettings.findUnique({ where: { workspaceId }, select: SELECT });
      return {
        workspaceId,
        publishMode: scopedSetting<PublishMode>(null, known(PUBLISH_MODES, row?.publishMode), 'review'),
        historyAudience: scopedSetting<HistoryAudience>(null, known(HISTORY_AUDIENCES, row?.historyAudience), 'everyone'),
        requiredApprovals: scopedSetting(null, row?.requiredApprovals, this.config.get('MR_REQUIRED_APPROVALS', { infer: true })),
      };
    });
  }

  /** A key left out is unchanged; null goes back to inheriting. */
  async set(
    workspaceId: string,
    input: { publishMode?: PublishMode | null; historyAudience?: HistoryAudience | null; requiredApprovals?: number | null },
    actorId: string,
  ): Promise<EditingPolicyResponse> {
    const data = Object.fromEntries(Object.entries(input).filter(([k, v]) => k in SELECT && v !== undefined));
    await this.prisma.workspaceSettings.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data, updatedBy: actorId },
      update: { ...data, updatedBy: actorId },
    });
    this.cache.delete(workspaceId);
    void this.audit.record({ workspaceId, actor: actorId, action: 'workspace.editing_policy_updated', params: data, target: workspaceId, ok: true });
    return this.policy(workspaceId);
  }
}
