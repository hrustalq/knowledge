import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { agentTriggerEventFor, type AgentTriggerEvent, type KnowledgeEvent } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsSubscriber } from '../events/events.subscriber.js';
import { REPO_CONNECTOR_KINDS } from '../connectors/code-research/repo-snapshot.service.js';
import { AgentTriggerService, type TriggerFacts } from './agent-trigger.service.js';

/**
 * Hears the bus for agent triggers (#70) and hands each matching event to
 * `AgentTriggerService.fire`. Worker-only, like WorkflowTriggerService: the
 * model calls happen here, and the API process must not start consuming.
 *
 * Unlike WorkflowTriggerService it does not return early for an event without
 * a `documentId`: a connector sync is about a connector, and its subject is
 * `connector:<id>`.
 *
 * Redis pub/sub is lossy — an event published while the worker is down is not
 * redelivered. That is acceptable for a trigger, which is news rather than a
 * queue; the run it would have started is one somebody can start by hand.
 */
@Injectable()
export class AgentTriggerListener implements OnModuleInit {
  private readonly logger = new Logger(AgentTriggerListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsSubscriber,
    private readonly triggers: AgentTriggerService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('AGENT_TRIGGERS_ENABLED', { infer: true })) {
      this.logger.log('Agent triggers disabled (AGENT_TRIGGERS_ENABLED=false)');
      return;
    }
    this.events.all().subscribe((event) => {
      void this.handle(event).catch((e: Error) =>
        this.logger.warn(`Agent trigger failed (non-fatal): ${e.message}`),
      );
    });
  }

  async handle(event: KnowledgeEvent): Promise<void> {
    const kind = agentTriggerEventFor(event.type);
    if (!kind) return;
    const triggers = await this.prisma.agentTrigger.findMany({
      where: { workspaceId: event.workspaceId, event: kind, enabled: true },
      orderBy: { createdAt: 'asc' },
    });
    if (triggers.length === 0) return;

    const facts = await this.factsFor(kind, event);
    if (!facts) return;
    for (const trigger of triggers) {
      // One trigger failing must not keep the event from the rest.
      await this.triggers
        .fire(trigger, facts)
        .catch((e: Error) => this.logger.warn(`Trigger ${trigger.id} failed (non-fatal): ${e.message}`));
    }
  }

  /** Null for an event that names nothing in this workspace any more. */
  private async factsFor(kind: AgentTriggerEvent, event: KnowledgeEvent): Promise<TriggerFacts | null> {
    const base = { source: event.type, subjectId: event.subjectId };

    if (kind === 'connector.synced') {
      if (!event.subjectId) return null;
      const connector = await this.connector(event.workspaceId, event.subjectId);
      if (!connector) return null;
      return {
        workspaceId: event.workspaceId,
        event: { type: kind, source: event.type, subjectId: connector.id },
        subjectKey: `connector:${connector.id}`,
        projectId: connector.projectId,
        connectorId: connector.id,
        repoConnector: REPO_CONNECTOR_KINDS.has(connector.kind),
      };
    }

    // A pull request on a connected repository: the subject is its work item,
    // and the page it is attached to, if any, lends it a project and category.
    if (event.type === 'repo.pull-request.opened') {
      if (!event.subjectId) return null;
      const item = await this.prisma.connectorWorkItem.findUnique({
        where: { id: event.subjectId },
        select: { id: true, connectorId: true, documentId: true },
      });
      if (!item) return null;
      const connector = await this.connector(event.workspaceId, item.connectorId);
      if (!connector) return null;
      const page = item.documentId ? await this.page(event.workspaceId, item.documentId) : null;
      return {
        workspaceId: event.workspaceId,
        event: { type: kind, source: event.type, subjectId: item.id, ...(page ? { documentId: page.id } : {}) },
        subjectKey: `mr:${item.id}`,
        projectId: page?.projectId ?? connector.projectId,
        category: page?.category ?? null,
        connectorId: connector.id,
        repoConnector: REPO_CONNECTOR_KINDS.has(connector.kind),
      };
    }

    if (!event.documentId) return null;
    const page = await this.page(event.workspaceId, event.documentId);
    if (!page) return null;
    const pageFacts = { workspaceId: event.workspaceId, projectId: page.projectId, category: page.category };

    if (kind === 'page.indexed') {
      if (!event.revisionId) return null;
      const revision = await this.prisma.documentRevision.findUnique({
        where: { id: event.revisionId },
        select: { documentId: true, createdAt: true, branch: { select: { name: true, headRevisionId: true } } },
      });
      // Only the head of its branch is the page as it now reads; a late index
      // of a superseded revision is not news.
      if (!revision || revision.documentId !== page.id || revision.branch?.headRevisionId !== event.revisionId) {
        return null;
      }
      return {
        ...pageFacts,
        event: { ...base, type: kind, documentId: page.id, revisionId: event.revisionId },
        subjectKey: `doc:${page.id}`,
        branch: revision.branch.name,
        defaultBranch: revision.branch.name === page.defaultBranch,
        occurredAt: revision.createdAt,
      };
    }

    // `page.merged` and an internal merge request opened: both carry the
    // merge request in `subjectId`, and its target is the branch filtered on.
    if (!event.subjectId) return null;
    const mr = await this.prisma.mergeRequest.findUnique({
      where: { id: event.subjectId },
      select: { documentId: true, targetBranch: { select: { name: true } } },
    });
    if (!mr || mr.documentId !== page.id) return null;
    return {
      ...pageFacts,
      event: { ...base, type: kind, documentId: page.id },
      // A merge is news about the page; an opened merge request is news about
      // itself, and a second one on the same page is a second piece of news.
      subjectKey: kind === 'page.merged' ? `doc:${page.id}` : `mr:${event.subjectId}`,
      branch: mr.targetBranch.name,
      defaultBranch: mr.targetBranch.name === page.defaultBranch,
    };
  }

  private async page(workspaceId: string, id: string) {
    const page = await this.prisma.document.findUnique({
      where: { id },
      select: { id: true, workspaceId: true, projectId: true, category: true, defaultBranch: true },
    });
    return page && page.workspaceId === workspaceId ? page : null;
  }

  private async connector(workspaceId: string, id: string) {
    const connector = await this.prisma.connector.findUnique({
      where: { id },
      select: { id: true, workspaceId: true, projectId: true, kind: true },
    });
    return connector && connector.workspaceId === workspaceId ? connector : null;
  }
}
