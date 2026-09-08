import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, WorkflowDefinition, WorkflowRun, WorkflowRunNode } from '@prisma/client';
import type {
  DocumentWorkflowRunsResponse,
  ListWorkflowRunsResponse,
  ListWorkflowsResponse,
  WorkflowDefinitionInfo,
  WorkflowGraph,
  WorkflowNodeDraft,
  WorkflowRunInfo,
  WorkflowRunNodeInfo,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowTrigger,
  WorkflowValidationIssue,
} from '@knowledge/contracts';
import { WORKFLOW_RUN_STATUSES } from '@knowledge/contracts';
import {
  applyRunEvent,
  compileDefinition,
  initialRunSnapshot,
  nextNodeStatus,
  stepById,
  validateGraph,
  WorkflowDefinitionError,
  WorkflowTransitionError,
} from '@knowledge/workflow';
import { PrismaService } from '../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { WorkflowProducer } from './workflow.producer.js';
import { WorkflowRunnerService } from './workflow-runner.service.js';
import type {
  CreateWorkflowDto,
  ListWorkflowRunsQueryDto,
  ListWorkflowsQueryDto,
  UpdateWorkflowDto,
} from './workflows.dto.js';

const DEFAULT_TRIGGER: WorkflowTrigger = {
  manual: true,
  // Off by default. The failure mode of an always-on trigger is one edit
  // fanning out into dozens of model calls across a whole workspace.
  autoStart: false,
  events: ['revision.indexed'],
  categories: [],
};

/**
 * Dynamic document workflows (docs/features/17).
 *
 * The service owns definitions, runs, and the review gate. Generation happens
 * in the worker; materialisation happens here, in the request that approves a
 * draft, because `DocumentsModule` is controller-bearing and cannot be loaded
 * into the worker process. That constraint produced a clean rule: **the worker
 * generates, the API writes to the page tree.**
 */
@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly projects: ProjectsService,
    private readonly producer: WorkflowProducer,
    private readonly runner: WorkflowRunnerService,
  ) {}

  // ------------------------------------------------------------ definitions

  async list(query: ListWorkflowsQueryDto): Promise<ListWorkflowsResponse> {
    const rows = await this.prisma.workflowDefinition.findMany({
      where: {
        workspaceId: query.workspaceId,
        // A project-scoped listing still includes workspace-wide definitions:
        // they are offered everywhere by construction.
        ...(query.projectId ? { OR: [{ projectId: query.projectId }, { projectId: null }] } : {}),
      },
      orderBy: [{ name: 'asc' }],
    });
    return { workflows: rows.map((row) => this.toDefinitionInfo(row)) };
  }

  async get(id: string): Promise<WorkflowDefinitionInfo> {
    return this.toDefinitionInfo(await this.requireDefinition(id));
  }

  async create(dto: CreateWorkflowDto, userId?: string): Promise<WorkflowDefinitionInfo> {
    if (dto.projectId) await this.projects.requireProjectInWorkspace(dto.projectId, dto.workspaceId);
    this.compileOrThrow(dto.graph);

    const row = await this.prisma.workflowDefinition
      .create({
        data: {
          workspaceId: dto.workspaceId,
          projectId: dto.projectId ?? null,
          name: dto.name.trim(),
          description: dto.description ?? null,
          enabled: dto.enabled ?? true,
          graph: dto.graph as unknown as Prisma.InputJsonValue,
          trigger: { ...DEFAULT_TRIGGER, ...(dto.trigger ?? {}) } as unknown as Prisma.InputJsonValue,
          createdBy: userId ?? null,
        },
      })
      .catch((e: { code?: string }) => {
        if (e.code === 'P2002') {
          throw new ConflictException(`A workflow named "${dto.name}" already exists in this workspace`);
        }
        throw e;
      });

    void this.activity.record({
      workspaceId: row.workspaceId,
      actor: userId,
      action: 'workflow.created',
      subjectId: row.id,
      metadata: { title: row.name },
    });
    return this.toDefinitionInfo(row);
  }

  async update(id: string, dto: UpdateWorkflowDto, userId?: string): Promise<WorkflowDefinitionInfo> {
    const existing = await this.requireDefinition(id);
    if (dto.projectId) await this.projects.requireProjectInWorkspace(dto.projectId, existing.workspaceId);
    if (dto.graph) this.compileOrThrow(dto.graph);

    const row = await this.prisma.workflowDefinition.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.projectId !== undefined ? { projectId: dto.projectId } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.trigger !== undefined
          ? { trigger: { ...DEFAULT_TRIGGER, ...dto.trigger } as unknown as Prisma.InputJsonValue }
          : {}),
        // The version tracks the *graph*, so toggling `enabled` does not make
        // it look as though the chain changed shape.
        ...(dto.graph
          ? { graph: dto.graph as unknown as Prisma.InputJsonValue, version: { increment: 1 } }
          : {}),
      },
    });

    void this.activity.record({
      workspaceId: row.workspaceId,
      actor: userId,
      action: 'workflow.updated',
      subjectId: row.id,
      metadata: { title: row.name },
    });
    return this.toDefinitionInfo(row);
  }

  async remove(id: string, userId?: string): Promise<void> {
    const definition = await this.requireDefinition(id);
    const live = await this.prisma.workflowRun.count({
      where: { definitionId: id, status: { notIn: ['completed', 'cancelled', 'failed'] } },
    });
    // Runs restrict-reference their definition, so deleting one out from under
    // a live run would fail at the database anyway — this turns that into an
    // explanation instead of a 500.
    if (live > 0) {
      throw new ConflictException({
        statusCode: 409,
        message: `${live} run(s) of this workflow are still in flight`,
        reason: 'runs-in-flight',
        runs: live,
      });
    }
    await this.prisma.workflowRun.deleteMany({ where: { definitionId: id } });
    await this.prisma.workflowDefinition.delete({ where: { id } });
    void this.activity.record({
      workspaceId: definition.workspaceId,
      actor: userId,
      action: 'workflow.deleted',
      subjectId: id,
      metadata: { title: definition.name },
    });
  }

  /** The editor's live check — reports issues instead of throwing. */
  async validate(id: string, graph?: WorkflowGraph): Promise<{ valid: boolean; issues: WorkflowValidationIssue[] }> {
    const target = graph ?? ((await this.requireDefinition(id)).graph as unknown as WorkflowGraph);
    const issues = validateGraph(target);
    return { valid: !issues.some((i) => i.severity === 'error'), issues };
  }

  // -------------------------------------------------------------------- runs

  async startRun(
    input: { workspaceId: string; definitionId: string; rootDocumentId: string; note?: string },
    userId?: string,
    startedBy = 'manual',
  ): Promise<WorkflowRunInfo> {
    const definition = await this.requireDefinition(input.definitionId);
    if (definition.workspaceId !== input.workspaceId) {
      throw new NotFoundException(`Workflow ${input.definitionId} not found`);
    }
    if (!definition.enabled) throw new BadRequestException('This workflow is disabled');

    const document = await this.prisma.document.findUnique({
      where: { id: input.rootDocumentId },
      select: { id: true, workspaceId: true, projectId: true, title: true },
    });
    if (!document || document.workspaceId !== input.workspaceId) {
      throw new NotFoundException(`Document ${input.rootDocumentId} not found`);
    }
    if (definition.projectId && definition.projectId !== document.projectId) {
      throw new BadRequestException('This workflow is scoped to a different project');
    }

    const graph = definition.graph as unknown as WorkflowGraph;
    const { entry } = this.compileOrThrow(graph);

    // One live run per (definition, page). Two runs writing the same fan-out
    // would race to create the same pages.
    const existing = await this.prisma.workflowRun.findFirst({
      where: {
        definitionId: definition.id,
        rootDocumentId: document.id,
        status: { notIn: ['completed', 'cancelled'] },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      throw new ConflictException({
        statusCode: 409,
        message: 'A run of this workflow is already in flight for this page',
        reason: 'run-in-flight',
        runId: existing.id,
        runStatus: existing.status,
      });
    }

    const started = applyRunEvent('pending', { type: 'START' }, { snapshot: initialRunSnapshot() });

    const run = await this.prisma.$transaction(async (tx) => {
      const created = await tx.workflowRun.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: document.projectId,
          definitionId: definition.id,
          // Frozen at start: editing the definition afterwards must not change
          // what this run is doing.
          definitionSnapshot: graph as unknown as Prisma.InputJsonValue,
          definitionVersion: definition.version,
          rootDocumentId: document.id,
          note: input.note ?? null,
          status: started.status,
          snapshot: started.snapshot as unknown as Prisma.InputJsonValue,
          startedBy,
          createdBy: userId ?? null,
          startedAt: new Date(),
        },
      });
      await tx.workflowRunNode.createMany({
        data: entry.map((step) => ({
          runId: created.id,
          parentId: null,
          stepId: step.id,
          status: 'pending',
          input: { rootDocumentId: document.id, note: input.note ?? null } as Prisma.InputJsonValue,
        })),
      });
      return created;
    });

    const roots = await this.prisma.workflowRunNode.findMany({ where: { runId: run.id }, select: { id: true } });
    for (const node of roots) await this.producer.enqueue(node.id);

    void this.activity.record({
      workspaceId: run.workspaceId,
      actor: userId,
      action: 'workflow-run.started',
      documentId: document.id,
      subjectId: run.id,
      metadata: { title: definition.name, startedBy },
    });
    return this.toRunInfo(run, definition.name, document.title, await this.statsFor([run.id]));
  }

  async listRuns(query: ListWorkflowRunsQueryDto): Promise<ListWorkflowRunsResponse> {
    const limit = query.limit ?? 25;
    const baseWhere: Prisma.WorkflowRunWhereInput = {
      workspaceId: query.workspaceId,
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.definitionId ? { definitionId: query.definitionId } : {}),
      ...(query.documentId ? { rootDocumentId: query.documentId } : {}),
    };

    const rows = await this.prisma.workflowRun.findMany({
      where: { ...baseWhere, ...(query.status ? { status: query.status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: { definition: { select: { name: true } } },
    });
    const page = rows.slice(0, limit);

    // Counts come from the same `baseWhere` with the status filter dropped, so
    // the tab badges reflect every status under the current search scope.
    const grouped = await this.prisma.workflowRun.groupBy({
      by: ['status'],
      where: baseWhere,
      _count: { _all: true },
    });
    const counts = Object.fromEntries(WORKFLOW_RUN_STATUSES.map((s) => [s, 0])) as Record<
      WorkflowRunStatus,
      number
    >;
    for (const g of grouped) counts[g.status as WorkflowRunStatus] = g._count._all;

    const titles = await this.documentTitles(page.map((r) => r.rootDocumentId));
    const stats = await this.statsFor(page.map((r) => r.id));

    return {
      runs: page.map((row) =>
        this.toRunInfo(row, row.definition.name, titles.get(row.rootDocumentId) ?? null, stats),
      ),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      counts,
    };
  }

  async getRun(id: string): Promise<{ run: WorkflowRunInfo; graph: WorkflowGraph; nodes: WorkflowRunNodeInfo[] }> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id },
      include: { definition: { select: { name: true } }, nodes: { orderBy: { createdAt: 'asc' } } },
    });
    if (!run) throw new NotFoundException(`Workflow run ${id} not found`);

    const titles = await this.documentTitles([run.rootDocumentId]);
    return {
      run: this.toRunInfo(run, run.definition.name, titles.get(run.rootDocumentId) ?? null, {
        [run.id]: this.statsOf(run.nodes),
      }),
      graph: run.definitionSnapshot as unknown as WorkflowGraph,
      nodes: run.nodes.map((n) => this.toNodeInfo(n)),
    };
  }

  async sendRunEvent(id: string, type: 'PAUSE' | 'RESUME' | 'CANCEL', userId?: string): Promise<WorkflowRunInfo> {
    const run = await this.requireRun(id);
    let next;
    try {
      next = applyRunEvent(run.status as WorkflowRunStatus, { type }, { snapshot: run.snapshot ?? undefined });
    } catch (e) {
      if (e instanceof WorkflowTransitionError) throw new ConflictException(e.message);
      throw e;
    }

    const terminal = next.status === 'cancelled' || next.status === 'completed';
    const updated = await this.prisma.workflowRun.update({
      where: { id },
      data: {
        status: next.status,
        snapshot: next.snapshot as unknown as Prisma.InputJsonValue,
        ...(terminal ? { finishedAt: new Date() } : {}),
      },
      include: { definition: { select: { name: true } } },
    });

    // Cancelling has to stop the work, not just relabel it: pending nodes are
    // skipped so the worker has nothing left to pick up.
    if (next.status === 'cancelled') {
      await this.prisma.workflowRunNode.updateMany({
        where: { runId: id, status: { in: ['pending', 'running', 'awaiting-review'] } },
        data: { status: 'skipped' },
      });
    }
    if (type === 'RESUME') await this.runner.enqueueReady(id);

    void this.activity.record({
      workspaceId: updated.workspaceId,
      actor: userId,
      action: `workflow-run.${type === 'PAUSE' ? 'paused' : type === 'RESUME' ? 'resumed' : 'cancelled'}`,
      documentId: updated.rootDocumentId,
      subjectId: updated.id,
      metadata: { title: updated.definition.name },
    });

    const titles = await this.documentTitles([updated.rootDocumentId]);
    return this.toRunInfo(
      updated,
      updated.definition.name,
      titles.get(updated.rootDocumentId) ?? null,
      await this.statsFor([updated.id]),
    );
  }

  // ------------------------------------------------------------------- nodes

  async updateNodeDraft(runId: string, nodeId: string, draft: WorkflowNodeDraft): Promise<WorkflowRunNodeInfo> {
    const node = await this.requireNode(runId, nodeId);
    if (node.status !== 'awaiting-review') {
      throw new ConflictException(`Only a node awaiting review can be edited (this one is ${node.status})`);
    }
    const updated = await this.prisma.workflowRunNode.update({
      where: { id: nodeId },
      data: { draft: draft as unknown as Prisma.InputJsonValue },
    });
    return this.toNodeInfo(updated);
  }

  /**
   * The review gate. Every event is checked against the compiled machine before
   * anything is written, so the buttons the web offers and the transitions the
   * API accepts are the same set by construction.
   */
  async sendNodeEvent(
    runId: string,
    nodeId: string,
    type: 'APPROVE' | 'REJECT' | 'SKIP' | 'RETRY',
    draft: WorkflowNodeDraft | undefined,
    userId: string | undefined,
    materialize: (node: WorkflowRunNode, run: WorkflowRun, step: WorkflowStep) => Promise<string | null>,
  ): Promise<{ node: WorkflowRunNodeInfo; run: WorkflowRunInfo }> {
    const node = await this.requireNode(runId, nodeId);
    const run = await this.requireRun(runId);
    const graph = run.definitionSnapshot as unknown as WorkflowGraph;
    const step = stepById(graph, node.stepId);
    if (!step) throw new BadRequestException(`Step "${node.stepId}" is no longer part of this run`);

    let nextStatus;
    try {
      nextStatus = nextNodeStatus(step, node.status as never, { type });
    } catch (e) {
      if (e instanceof WorkflowTransitionError) throw new ConflictException(e.message);
      throw e;
    }

    // APPROVE may carry a last-moment edit, so reviewing and editing are one
    // action rather than two round trips.
    const finalDraft = draft ?? (node.draft as unknown as WorkflowNodeDraft | null);
    let current = await this.prisma.workflowRunNode.update({
      where: { id: nodeId },
      data: {
        status: nextStatus,
        ...(draft ? { draft: draft as unknown as Prisma.InputJsonValue } : {}),
        ...(type === 'RETRY' ? { attempt: { increment: 1 }, error: null } : {}),
      },
    });

    if (nextStatus === 'materializing') {
      try {
        const documentId = await materialize(current, run, step);
        current = await this.prisma.workflowRunNode.update({
          where: { id: nodeId },
          data: { status: 'materialized', documentId },
        });
        void this.activity.record({
          workspaceId: run.workspaceId,
          actor: userId,
          action: 'workflow-node.materialized',
          documentId: documentId ?? undefined,
          subjectId: run.id,
          metadata: { title: finalDraft?.title, stepId: step.id, nodeId },
        });
      } catch (e) {
        const message = (e as Error).message;
        current = await this.prisma.workflowRunNode.update({
          where: { id: nodeId },
          data: { status: 'failed', error: message },
        });
        this.logger.warn(`Materialising node ${nodeId} failed: ${message}`);
      }
    }

    // A node that finished its life opens the next steps of the graph.
    if (current.status === 'materialized' || current.status === 'approved') {
      await this.runner.spawnChildren(run, current, step);
    }
    // A fresh jobId: the kept failed job blocks reuse of the original, exactly
    // as `StaleSweeper.enqueueRetry` handles a re-queued ingestion job.
    if (type === 'RETRY') await this.producer.enqueueRetry(nodeId, current.attempt);

    const runInfo = await this.reconcileRun(runId);
    return { node: this.toNodeInfo(current), run: runInfo };
  }

  /**
   * Recompute the run after a review action. Progression itself lives in
   * `WorkflowRunnerService` so the worker and the API advance a run through
   * exactly the same code.
   */
  private async reconcileRun(runId: string): Promise<WorkflowRunInfo> {
    await this.runner.reconcileRun(runId);
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { definition: { select: { name: true } } },
    });
    if (!run) throw new NotFoundException(`Workflow run ${runId} not found`);
    const titles = await this.documentTitles([run.rootDocumentId]);
    return this.toRunInfo(
      run,
      run.definition.name,
      titles.get(run.rootDocumentId) ?? null,
      await this.statsFor([run.id]),
    );
  }

  // ------------------------------------------------------ document rail feed

  async runsForDocument(documentId: string): Promise<DocumentWorkflowRunsResponse> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, workspaceId: true, projectId: true },
    });
    if (!document) throw new NotFoundException(`Document ${documentId} not found`);

    const rows = await this.prisma.workflowRun.findMany({
      where: { rootDocumentId: documentId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { definition: { select: { name: true } } },
    });
    const available = await this.prisma.workflowDefinition.findMany({
      where: {
        workspaceId: document.workspaceId,
        enabled: true,
        OR: [{ projectId: document.projectId }, { projectId: null }],
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    const stats = await this.statsFor(rows.map((r) => r.id));
    return {
      documentId,
      runs: rows.map((row) => this.toRunInfo(row, row.definition.name, null, stats)),
      available,
    };
  }

  // ----------------------------------------------------------------- helpers

  private compileOrThrow(graph: WorkflowGraph) {
    try {
      return compileDefinition(graph);
    } catch (e) {
      if (e instanceof WorkflowDefinitionError) {
        throw new BadRequestException({
          statusCode: 400,
          message: 'The workflow graph is not valid',
          reason: 'invalid-graph',
          issues: e.issues,
        });
      }
      throw e;
    }
  }

  private async requireDefinition(id: string): Promise<WorkflowDefinition> {
    const row = await this.prisma.workflowDefinition.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Workflow ${id} not found`);
    return row;
  }

  private async requireRun(id: string): Promise<WorkflowRun> {
    const row = await this.prisma.workflowRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Workflow run ${id} not found`);
    return row;
  }

  private async requireNode(runId: string, nodeId: string): Promise<WorkflowRunNode> {
    const row = await this.prisma.workflowRunNode.findUnique({ where: { id: nodeId } });
    if (!row || row.runId !== runId) throw new NotFoundException(`Workflow node ${nodeId} not found`);
    return row;
  }

  private async documentTitles(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.document.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, title: true },
    });
    return new Map(rows.map((r) => [r.id, r.title]));
  }

  /** One grouped query per response, so a list of runs never N+1s its counts. */
  private async statsFor(runIds: string[]): Promise<Record<string, WorkflowRunInfo['nodeStats']>> {
    if (runIds.length === 0) return {};
    const grouped = await this.prisma.workflowRunNode.groupBy({
      by: ['runId', 'status'],
      where: { runId: { in: runIds } },
      _count: { _all: true },
    });
    const out: Record<string, WorkflowRunInfo['nodeStats']> = {};
    for (const id of runIds) out[id] = { total: 0, awaitingReview: 0, materialized: 0, failed: 0 };
    for (const g of grouped) {
      const bucket = out[g.runId];
      if (!bucket) continue;
      bucket.total += g._count._all;
      if (g.status === 'awaiting-review') bucket.awaitingReview += g._count._all;
      if (g.status === 'materialized') bucket.materialized += g._count._all;
      if (g.status === 'failed') bucket.failed += g._count._all;
    }
    return out;
  }

  private statsOf(nodes: WorkflowRunNode[]): WorkflowRunInfo['nodeStats'] {
    return {
      total: nodes.length,
      awaitingReview: nodes.filter((n) => n.status === 'awaiting-review').length,
      materialized: nodes.filter((n) => n.status === 'materialized').length,
      failed: nodes.filter((n) => n.status === 'failed').length,
    };
  }

  private toDefinitionInfo(row: WorkflowDefinition): WorkflowDefinitionInfo {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      version: row.version,
      graph: row.graph as unknown as WorkflowGraph,
      trigger: { ...DEFAULT_TRIGGER, ...((row.trigger ?? {}) as object) } as WorkflowTrigger,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toRunInfo(
    row: WorkflowRun,
    definitionName: string,
    rootTitle: string | null,
    stats: Record<string, WorkflowRunInfo['nodeStats']>,
  ): WorkflowRunInfo {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      definitionId: row.definitionId,
      definitionName,
      rootDocumentId: row.rootDocumentId,
      rootDocumentTitle: rootTitle,
      status: row.status as WorkflowRunStatus,
      error: row.error,
      startedBy: row.startedBy ?? 'manual',
      createdBy: row.createdBy ?? 'dev',
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      nodeStats: stats[row.id] ?? { total: 0, awaitingReview: 0, materialized: 0, failed: 0 },
    };
  }

  private toNodeInfo(row: WorkflowRunNode): WorkflowRunNodeInfo {
    return {
      id: row.id,
      runId: row.runId,
      parentId: row.parentId,
      stepId: row.stepId,
      status: row.status as WorkflowRunNodeInfo['status'],
      draft: (row.draft ?? null) as WorkflowNodeDraft | null,
      documentId: row.documentId,
      error: row.error,
      attempt: row.attempt,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
