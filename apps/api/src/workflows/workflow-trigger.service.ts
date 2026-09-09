import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { KnowledgeEvent, WorkflowGraph, WorkflowTrigger } from '@knowledge/contracts';
import { applyRunEvent, compileDefinition, initialRunSnapshot } from '@knowledge/workflow';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsSubscriber } from '../events/events.subscriber.js';
import { ActivityService } from '../activity/activity.service.js';
import type { Env } from '../config/env.js';
import { WorkflowProducer } from './workflow.producer.js';

/**
 * Starts runs from document events (docs/features/17).
 *
 * The failure mode of an always-on trigger is an LLM avalanche: one edit to a
 * widely-referenced page fanning out into dozens of model calls, repeatedly,
 * across a whole workspace. So every guard here is deliberate and none of them
 * is optional:
 *
 *   - `trigger.autoStart` is false on new definitions, so nothing fires until
 *     someone turns it on;
 *   - the page's category must be in `trigger.categories`;
 *   - a definition with a non-terminal run for that page is skipped, so editing
 *     a page five times does not open five runs;
 *   - `WORKFLOW_AUTOSTART_MAX_ACTIVE` caps how many auto-started runs a single
 *     workspace can have in flight at once;
 *   - and the definition must have an author, because that is the identity the
 *     run executes and bills as. A definition without one is skipped rather
 *     than started under nobody — the `AiAgent.scheduleOwner` rule
 *     (docs/features/20), which exists because this service is what it was
 *     written against: an ownerless run billed its model calls as the literal
 *     string 'workflow', an insert that failed silently, so auto-triggered
 *     spend never showed up anywhere.
 *
 * It runs in the worker, where the model calls happen, rather than in the API.
 */
@Injectable()
export class WorkflowTriggerService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowTriggerService.name);
  private readonly maxActive: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsSubscriber,
    private readonly activity: ActivityService,
    private readonly producer: WorkflowProducer,
    config: ConfigService<Env, true>,
    ) {
    this.maxActive = Number(config.get('WORKFLOW_AUTOSTART_MAX_ACTIVE', { infer: true }) ?? 5);
  }

  onModuleInit(): void {
    this.events.all().subscribe((event) => {
      void this.handle(event).catch((e: Error) =>
        this.logger.warn(`Workflow trigger failed (non-fatal): ${e.message}`),
      );
    });
  }

  private async handle(event: KnowledgeEvent): Promise<void> {
    if (!event.documentId) return;
    // A run's own output re-triggering the workflow that produced it is the
    // avalanche in its purest form.
    if (event.type.startsWith('workflow')) return;

    const document = await this.prisma.document.findUnique({
      where: { id: event.documentId },
      select: { id: true, workspaceId: true, projectId: true, category: true },
    });
    if (!document || document.workspaceId !== event.workspaceId) return;

    const definitions = await this.prisma.workflowDefinition.findMany({
      where: {
        workspaceId: document.workspaceId,
        enabled: true,
        OR: [{ projectId: document.projectId }, { projectId: null }],
      },
    });

    for (const definition of definitions) {
      const trigger = (definition.trigger ?? {}) as Partial<WorkflowTrigger>;
      if (!trigger.autoStart) continue;
      // Nobody to run as. Skipping is the whole point: this will not invent an
      // identity to keep a trigger alive.
      if (!definition.createdBy) {
        this.logger.warn(
          `Auto-start skipped for "${definition.name}": the definition has no author to run as`,
        );
        continue;
      }
      if (!trigger.events?.includes(event.type)) continue;
      if (trigger.categories?.length && !trigger.categories.includes(document.category as never)) continue;

      // Never start a second run for a page this definition is already working
      // on — two runs would race to create the same pages.
      const inFlight = await this.prisma.workflowRun.count({
        where: {
          definitionId: definition.id,
          rootDocumentId: document.id,
          status: { notIn: ['completed', 'cancelled'] },
        },
      });
      if (inFlight > 0) continue;

      // A page this workflow already produced pages for should not silently
      // grow a second set; re-running is a deliberate act.
      const previous = await this.prisma.workflowRun.count({
        where: { definitionId: definition.id, rootDocumentId: document.id },
      });
      if (previous > 0) continue;

      const active = await this.prisma.workflowRun.count({
        where: {
          workspaceId: document.workspaceId,
          startedBy: 'trigger',
          status: { in: ['pending', 'running', 'awaiting-review'] },
        },
      });
      if (active >= this.maxActive) {
        this.logger.warn(
          `Auto-start skipped for "${definition.name}": workspace already has ${active} triggered runs in flight`,
        );
        continue;
      }

      await this.start(
        // Spelled out rather than passed whole: `createdBy` is narrowed to a
        // string by the guard above, and the Prisma row's type is not.
        {
          id: definition.id,
          name: definition.name,
          graph: definition.graph,
          createdBy: definition.createdBy,
        },
        document,
        event.type,
      );
    }
  }

  private async start(
    definition: { id: string; name: string; graph: Prisma.JsonValue; createdBy: string },
    document: { id: string; workspaceId: string; projectId: string },
    eventType: string,
  ): Promise<void> {
    const { id: definitionId, name } = definition;
    const graph = definition.graph as unknown as WorkflowGraph;
    let entry;
    try {
      ({ entry } = compileDefinition(graph));
    } catch (e) {
      this.logger.warn(`Auto-start skipped for "${name}": ${(e as Error).message}`);
      return;
    }

    const started = applyRunEvent('pending', { type: 'START' }, { snapshot: initialRunSnapshot() });
    const run = await this.prisma.workflowRun.create({
      data: {
        workspaceId: document.workspaceId,
        projectId: document.projectId,
        definitionId,
        definitionSnapshot: graph as unknown as Prisma.InputJsonValue,
        rootDocumentId: document.id,
        status: started.status,
        snapshot: started.snapshot as unknown as Prisma.InputJsonValue,
        startedBy: 'trigger',
        // The author who turned auto-start on owns what it produces.
        createdBy: definition.createdBy,
        startedAt: new Date(),
      },
    });
    await this.prisma.workflowRunNode.createMany({
      data: entry.map((step) => ({
        runId: run.id,
        stepId: step.id,
        status: 'pending',
        input: { rootDocumentId: document.id, trigger: eventType } as Prisma.InputJsonValue,
      })),
    });

    const nodes = await this.prisma.workflowRunNode.findMany({
      where: { runId: run.id },
      select: { id: true },
    });
    for (const node of nodes) await this.producer.enqueue(node.id);

    void this.activity.record({
      workspaceId: run.workspaceId,
      actor: definition.createdBy,
      action: 'workflow-run.started',
      documentId: document.id,
      subjectId: run.id,
      metadata: { title: name, startedBy: 'trigger', trigger: eventType },
    });
    this.logger.log(`Auto-started "${name}" for document ${document.id} on ${eventType}`);
  }
}
