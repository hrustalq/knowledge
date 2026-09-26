import { Injectable, Logger } from '@nestjs/common';
import type { Connector, Prisma } from '@prisma/client';
import { driftCheckMode, type AgentRunInput } from '@knowledge/contracts';
import { AgentRegistryService } from '../../agents/agent-registry.service.js';
import { AgentProducer } from '../../agents/agent.producer.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { REPO_CONNECTOR_KINDS } from '../code-research/repo-snapshot.service.js';
import type { PullRequestDelivery } from './pull-request-delivery.js';

/** The agent a drift check runs as. */
export const DRIFT_AGENT_KEY = 'sentinel';

/**
 * Waiting checks one workspace may hold. A monorepo with forty open pull
 * requests and a bot rebasing them all would otherwise queue forty model runs
 * in a minute; past this a delivery is dropped, and the next push to that
 * branch asks again.
 */
const MAX_PENDING = 20;

/**
 * Turns a pull or merge request delivery into a sentinel run
 * (docs/features/35).
 *
 * API-side, called inline by both webhook controllers, and bounded the way the
 * App-level hook's other work is: a handful of reads and at most one insert
 * per delivery. The model work is the worker's.
 *
 * Three rules keep a busy repository from turning into a busy bill:
 *
 * - **A head is checked once.** A repository with the App installed *and* a
 *   hook configured by hand delivers every event twice, and GitHub redelivers
 *   on a slow answer. The run's `headSha` is the identity; the same head again
 *   is the same check.
 * - **A queued check absorbs a newer head.** Three pushes in a minute produce
 *   one check of the third, by rewriting the waiting run's input — the
 *   connector sync's coalescing rule, and for its reason: a run that has not
 *   started has not frozen anything yet.
 * - **A workspace holds at most `MAX_PENDING` waiting checks.**
 */
@Injectable()
export class DriftTriggerService {
  private readonly logger = new Logger(DriftTriggerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AgentRegistryService,
    private readonly producer: AgentProducer,
  ) {}

  /** The run that will check this change, or null when nothing was queued. */
  async request(row: Connector, delivery: PullRequestDelivery): Promise<string | null> {
    if (!row.enabled || !REPO_CONNECTOR_KINDS.has(row.kind)) return null;
    if (driftCheckMode(row.config as Record<string, unknown>) === 'off') return null;

    // A run acts as a person: its owner's role caps its tools and its spend is
    // billed to them. A connector nobody owns has nobody to act as — the
    // feature-27 rule, where an ownerless connector gets no model calls.
    if (!row.createdBy) {
      this.logger.warn(`drift check skipped for connector ${row.id}: the connector has no owner`);
      return null;
    }

    const agent = await this.registry.resolve(row.workspaceId, DRIFT_AGENT_KEY);
    if (!agent.enabled) return null;

    const pr = delivery.pullRequest;
    const latest = await this.prisma.agentRun.findFirst({
      where: {
        workspaceId: row.workspaceId,
        agentKey: DRIFT_AGENT_KEY,
        AND: [
          { input: { path: ['connectorId'], equals: row.id } },
          { input: { path: ['pullRequest', 'number'], equals: pr.number } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    const input: AgentRunInput = { connectorId: row.id, pullRequest: pr };

    if (latest) {
      const previous = (latest.input ?? {}) as AgentRunInput;
      const failed = latest.status === 'failed' || latest.status === 'cancelled';
      if (previous.pullRequest?.headSha === pr.headSha && !failed) return null;

      if (latest.status === 'pending') {
        // Guarded on the status still being pending: a run the worker claimed
        // between the read and this write has frozen its input, and the newer
        // head then gets a run of its own below.
        const absorbed = await this.prisma.agentRun.updateMany({
          where: { id: latest.id, status: 'pending' },
          data: { input: input as Prisma.InputJsonValue },
        });
        if (absorbed.count === 1) return latest.id;
      }
    }

    const pending = await this.prisma.agentRun.count({
      where: { workspaceId: row.workspaceId, agentKey: DRIFT_AGENT_KEY, status: 'pending' },
    });
    if (pending >= MAX_PENDING) {
      this.logger.warn(`drift check for ${row.id} #${pr.number} dropped: ${pending} checks already waiting`);
      return null;
    }

    const override = await this.prisma.aiAgent.findUnique({
      where: { workspaceId_key: { workspaceId: row.workspaceId, key: DRIFT_AGENT_KEY } },
      select: { id: true },
    });
    const run = await this.prisma.agentRun.create({
      data: {
        workspaceId: row.workspaceId,
        agentKey: DRIFT_AGENT_KEY,
        agentId: override?.id ?? null,
        trigger: 'webhook',
        createdBy: row.createdBy,
        locale: row.locale,
        input: input as Prisma.InputJsonValue,
      },
    });
    await this.producer.enqueue(run.id);
    return run.id;
  }
}
