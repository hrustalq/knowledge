import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { KnowledgeEvent, WorkflowGraph, WorkflowTrigger } from '@knowledge/contracts';
import { REPO_EVENT_TYPES } from '@knowledge/contracts';
import { applyRunEvent, compileDefinition, initialRunSnapshot } from '@knowledge/workflow';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsSubscriber } from '../events/events.subscriber.js';
import { ActivityService } from '../activity/activity.service.js';
import type { Env } from '../config/env.js';
import { asLocale } from '../i18n/locale.js';
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
  private readonly repoCooldownMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsSubscriber,
    private readonly activity: ActivityService,
    private readonly producer: WorkflowProducer,
    config: ConfigService<Env, true>,
    ) {
    this.maxActive = Number(config.get('WORKFLOW_AUTOSTART_MAX_ACTIVE', { infer: true }) ?? 5);
    this.repoCooldownMs =
      Number(config.get('WORKFLOW_REPO_RETRIGGER_COOLDOWN_MINUTES', { infer: true }) ?? 60) * 60_000;
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
      //
      // Repo events are the exception (docs/features/32), and the reason the
      // guard exists is the reason they are exempt from it: a page event
      // recurs because a run's own output edits pages, so "only ever once" is
      // what stops the chain feeding itself. A repo event is caused by a person
      // on the far side, and an issue that opens, closes and reopens over a
      // month is three separate pieces of news about the same page — under the
      // absolute guard only the first would ever be heard.
      //
      // Exempt is not unbounded: a flow that closes an issue when it finishes
      // makes the far side move, so a cooldown replaces the guard rather than
      // removing it.
      if (isRepoEvent(event.type)) {
        const since = new Date(Date.now() - this.repoCooldownMs);
        const recent = await this.prisma.workflowRun.count({
          where: {
            definitionId: definition.id,
            rootDocumentId: document.id,
            startedBy: 'trigger',
            createdAt: { gte: since },
          },
        });
        if (recent > 0) continue;
      } else {
        const previous = await this.prisma.workflowRun.count({
          where: { definitionId: definition.id, rootDocumentId: document.id },
        });
        if (previous > 0) continue;
      }

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
    // No request here to read a language from, so the run is written in the
    // language of the person it executes and bills as — the same person the
    // pages will be attributed to. Left unset, the column's `"en"` default
    // produced English pages in a Russian workspace on every auto-start.
    const owner = await this.prisma.user.findUnique({
      where: { id: definition.createdBy },
      select: { locale: true },
    });
    const locale = asLocale(owner?.locale);
    // Run + entry nodes commit together, as in WorkflowsService.startRun. This
    // path had the same pair without the transaction: a run created with no
    // nodes enqueues nothing, so reconcileRun never runs and it sits in the list
    // in-flight forever — which also trips the "one live run per (definition,
    // page)" check, refusing every manual start for that page from then on.
    const run = await this.prisma.$transaction(async (tx) => {
      const created = await tx.workflowRun.create({
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
          locale,
          startedAt: new Date(),
        },
      });
      await tx.workflowRunNode.createMany({
        data: entry.map((step) => ({
          runId: created.id,
          stepId: step.id,
          status: 'pending',
          input: { rootDocumentId: document.id, trigger: eventType } as Prisma.InputJsonValue,
        })),
      });
      return created;
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

/**
 * A repo event is one the far side caused (docs/features/32), which is what
 * makes it exempt from the "only ever once per page" guard.
 *
 * Read off the contracts array rather than a `startsWith('repo.')` test: the
 * prefix is a naming convention, and a guard that keys off a convention says
 * yes to the first event somebody names `repo.something` without meaning this.
 */
const REPO_EVENTS = new Set<string>(REPO_EVENT_TYPES);

function isRepoEvent(type: string): boolean {
  return REPO_EVENTS.has(type);
}
