import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma, WorkflowRun, WorkflowRunNode } from '@prisma/client';
import type { WorkflowGraph, WorkflowRunStatus, WorkflowStep } from '@knowledge/contracts';
import { applyRunEvent, stepById } from '@knowledge/workflow';
import { PrismaService } from '../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { WorkflowProducer } from './workflow.producer.js';
import { t } from '../i18n/t.js';

/**
 * Run progression (docs/features/17) — the part of the workflow engine that
 * both processes need.
 *
 * It lives apart from `WorkflowsService` because the worker cannot load that
 * one: `WorkflowsModule` is controller-bearing. Everything here is Prisma,
 * activity and the queue — no HTTP, no auth, no documents — which is what makes
 * `WorkflowCoreModule` importable from `WorkerModule`.
 */
@Injectable()
export class WorkflowRunnerService {
  private readonly logger = new Logger(WorkflowRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly producer: WorkflowProducer,
  ) {}

  async loadNode(nodeId: string): Promise<{ node: WorkflowRunNode; run: WorkflowRun; step: WorkflowStep } | null> {
    const node = await this.prisma.workflowRunNode.findUnique({
      where: { id: nodeId },
      include: { run: true },
    });
    if (!node) return null;
    const graph = node.run.definitionSnapshot as unknown as WorkflowGraph;
    const step = stepById(graph, node.stepId);
    if (!step) return null;
    return { node, run: node.run, step };
  }

  /**
   * Claim a node for execution. The guarded `updateMany` is the claim: two
   * workers racing on the same job both call this and only one sees a row
   * change, so the model is never asked the same question twice.
   */
  async claim(nodeId: string): Promise<boolean> {
    const claimed = await this.prisma.workflowRunNode.updateMany({
      where: { id: nodeId, status: 'pending' },
      data: { status: 'running' },
    });
    return claimed.count === 1;
  }

  async writeDraft(nodeId: string, draft: unknown, output?: unknown): Promise<WorkflowRunNode> {
    return this.prisma.workflowRunNode.update({
      where: { id: nodeId },
      data: {
        draft: (draft ?? undefined) as Prisma.InputJsonValue,
        ...(output !== undefined ? { output: output as Prisma.InputJsonValue } : {}),
      },
    });
  }

  async setStatus(nodeId: string, status: string, extra: Prisma.WorkflowRunNodeUpdateInput = {}) {
    return this.prisma.workflowRunNode.update({ where: { id: nodeId }, data: { status, ...extra } });
  }

  async failNode(nodeId: string, error: string): Promise<void> {
    await this.prisma.workflowRunNode.update({
      where: { id: nodeId },
      data: { status: 'failed', error: error.slice(0, 2000) },
    });
  }

  /**
   * Create children for a fan-out step: one node per produced item, all against
   * the *same* next step. This is the "one use-case → many endpoints" edge.
   */
  async fanOut(
    run: WorkflowRun,
    parent: WorkflowRunNode,
    step: WorkflowStep,
    items: Array<{ title: string; summary?: string }>,
  ): Promise<void> {
    const graph = run.definitionSnapshot as unknown as WorkflowGraph;
    const next = step.next.map((id) => stepById(graph, id)).filter((s): s is WorkflowStep => Boolean(s));

    // Each produced item becomes a node of *this* step, holding the draft a
    // reviewer sees. Their own children open when they are approved.
    const existing = await this.prisma.workflowRunNode.count({ where: { parentId: parent.id } });
    if (existing > 0) return; // idempotent under a re-delivered job

    await this.prisma.workflowRunNode.createMany({
      data: items.map((item) => ({
        runId: run.id,
        parentId: parent.id,
        stepId: step.id,
        status: 'awaiting-review',
        input: { parentNodeId: parent.id, note: run.note } as Prisma.InputJsonValue,
        draft: {
          title: item.title,
          markdown: item.summary ?? '',
          summary: item.summary,
        } as Prisma.InputJsonValue,
      })),
    });

    if (next.length === 0 && items.length === 0) {
      this.logger.warn(`Fan-out step ${step.id} of run ${run.id} produced nothing`);
    }
  }

  /** Open the next steps of the graph below a finished node. */
  async spawnChildren(run: WorkflowRun, node: WorkflowRunNode, step: WorkflowStep): Promise<void> {
    const graph = run.definitionSnapshot as unknown as WorkflowGraph;
    const next = step.next.map((id) => stepById(graph, id)).filter((s): s is WorkflowStep => Boolean(s));
    if (next.length === 0) return;

    // Idempotent: a re-delivered job or a retried approval must not open a
    // second set of children.
    const already = await this.prisma.workflowRunNode.findMany({
      where: { runId: run.id, parentId: node.id },
      select: { stepId: true },
    });
    const have = new Set(already.map((n) => n.stepId));
    const create = next.filter((s) => !have.has(s.id));
    if (create.length === 0) return;

    await this.prisma.workflowRunNode.createMany({
      data: create.map((s) => ({
        runId: run.id,
        parentId: node.id,
        stepId: s.id,
        status: 'pending',
        input: {
          parentNodeId: node.id,
          parentDocumentId: node.documentId,
          parentDraft: node.draft,
          note: run.note,
        } as Prisma.InputJsonValue,
      })),
    });

    const spawned = await this.prisma.workflowRunNode.findMany({
      where: { runId: run.id, parentId: node.id, status: 'pending', stepId: { in: create.map((s) => s.id) } },
      select: { id: true },
    });
    for (const child of spawned) await this.producer.enqueue(child.id);
  }

  /**
   * Recompute a run's state from its nodes. The single place a run's status
   * changes as a consequence of node work: the machine decides whether the
   * transition is legal, the counters only tell it what happened.
   */
  async reconcileRun(runId: string): Promise<WorkflowRunStatus> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { nodes: { select: { status: true } }, definition: { select: { name: true } } },
    });
    if (!run) throw new NotFoundException(t('error.workflow.runNotFound', { id: runId }));

    const status = run.status as WorkflowRunStatus;
    // Paused and cancelled are operator intent; node progress must not undo it.
    if (status === 'paused' || status === 'cancelled' || status === 'completed') return status;

    const live = run.nodes.filter((n) => n.status === 'pending' || n.status === 'running').length;
    const awaiting = run.nodes.filter((n) => n.status === 'awaiting-review').length;
    const failed = run.nodes.filter((n) => n.status === 'failed').length;

    let target: WorkflowRunStatus;
    if (live > 0) target = 'running';
    else if (awaiting > 0) target = 'awaiting-review';
    else if (failed > 0) target = 'failed';
    else target = 'completed';
    if (target === status) return status;

    const event =
      target === 'running'
        ? ({ type: 'RESUME' } as const)
        : target === 'awaiting-review'
          ? ({ type: 'PARK' } as const)
          : target === 'failed'
            ? ({ type: 'FAIL', error: 'One or more steps failed' } as const)
            : ({ type: 'COMPLETE' } as const);

    let applied;
    try {
      applied = applyRunEvent(status, event, { snapshot: run.snapshot ?? undefined });
    } catch {
      // The machine refused: leave the run where it is rather than forcing a
      // status the machine does not believe in.
      return status;
    }

    await this.prisma.workflowRun.update({
      where: { id: runId },
      data: {
        status: applied.status,
        snapshot: applied.snapshot as unknown as Prisma.InputJsonValue,
        ...(applied.status === 'completed' ? { finishedAt: new Date() } : {}),
      },
    });

    if (applied.status === 'completed' || applied.status === 'failed' || applied.status === 'awaiting-review') {
      void this.activity.record({
        workspaceId: run.workspaceId,
        action:
          applied.status === 'awaiting-review'
            ? 'workflow-node.awaiting-review'
            : `workflow-run.${applied.status}`,
        documentId: run.rootDocumentId,
        subjectId: run.id,
        metadata: { title: run.definition.name },
      });
    }
    return applied.status;
  }

  /** Re-enqueue everything a resumed run can act on. */
  async enqueueReady(runId: string): Promise<void> {
    const nodes = await this.prisma.workflowRunNode.findMany({
      where: { runId, status: 'pending' },
      select: { id: true },
    });
    for (const node of nodes) await this.producer.enqueue(node.id);
  }

  /** Is the run still allowed to make progress? Cancelled and paused runs stop. */
  async runIsActive(runId: string): Promise<boolean> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId }, select: { status: true } });
    return run?.status === 'running' || run?.status === 'awaiting-review' || run?.status === 'pending';
  }
}
