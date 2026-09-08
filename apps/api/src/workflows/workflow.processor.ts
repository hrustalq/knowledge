import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { nextNodeStatus } from '@knowledge/workflow';
import type { WorkflowNodeDraft, WorkflowNodeStatus } from '@knowledge/contracts';
import { EventsPublisher } from '../events/events.publisher.js';
import { WORKFLOW_QUEUE } from './workflow.constants.js';
import { WorkflowExecutors } from './workflow.executors.js';
import { WorkflowRunnerService } from './workflow-runner.service.js';

/**
 * Runs one workflow node per job (docs/features/17).
 *
 * One node per job, rather than one run per job, is what makes the whole thing
 * interruptible: a run is only ever "in progress" for as long as a single step
 * takes, so killing the worker loses at most that step, and the sweeper picks
 * the node back up. Nothing about a run lives in this process's memory.
 *
 * The state machine, not this class, decides what a finished step means: the
 * processor reports DONE and takes whichever status comes back, so an
 * auto-approved step and a reviewed one differ only in the machine's guard.
 */
@Processor(WORKFLOW_QUEUE)
export class WorkflowProcessor extends WorkerHost {
  private readonly logger = new Logger(WorkflowProcessor.name);

  constructor(
    private readonly runner: WorkflowRunnerService,
    private readonly executors: WorkflowExecutors,
    private readonly events: EventsPublisher,
  ) {
    super();
  }

  async process(job: Job<{ nodeId: string }>): Promise<void> {
    const { nodeId } = job.data;
    const loaded = await this.runner.loadNode(nodeId);
    if (!loaded) {
      this.logger.warn(`Workflow node ${nodeId} no longer exists (or its step was removed)`);
      return;
    }
    const { node, run, step } = loaded;

    // A cancelled or paused run must not keep spending model calls just because
    // its jobs were already on the queue.
    if (!(await this.runner.runIsActive(run.id))) {
      this.logger.log(`Skipping node ${nodeId}: run ${run.id} is no longer active`);
      return;
    }
    // Someone else claimed it — a re-delivered job, or the sweeper racing the
    // original. Only one of them gets to call the model.
    if (!(await this.runner.claim(nodeId))) return;

    try {
      const result = await this.executors.run(step, node, run);

      if (result.kind === 'items') {
        // A fan-out step's own node did its job the moment it produced the
        // list: each item becomes a child node holding a reviewable draft, and
        // *those* carry the chain forward when they are approved. The parent
        // deliberately does NOT open `step.next` — doing so produced a second,
        // parentless copy of every downstream step hanging off the list itself.
        await this.runner.fanOut(run, node, step, result.items);
        await this.runner.setStatus(nodeId, 'approved', { output: { items: result.items } });
      } else {
        const draft = result.kind === 'draft' ? result.draft : null;
        if (draft) await this.runner.writeDraft(nodeId, draft, draft);
        if (result.kind === 'context') await this.runner.writeDraft(nodeId, node.draft, result.context);

        const status = nextNodeStatus(step, 'running' as WorkflowNodeStatus, { type: 'DONE' });
        await this.runner.setStatus(nodeId, status);

        if (status === 'awaiting-review') {
          await this.publish(run.workspaceId, 'workflow-node.awaiting-review', run.id, run.rootDocumentId, draft);
        }
        // `materializing` is deliberately terminal for this process: writing a
        // page needs DocumentsService, which does not load in the worker, so
        // the API-side sweeper finishes the job.
      }

      // A non-fan-out step that needs no review opens its children right away.
      // Fan-out steps are excluded above: their items are the continuation.
      if (result.kind !== 'items') {
        const after = await this.runner.loadNode(nodeId);
        if (after && after.node.status === 'approved') {
          await this.runner.spawnChildren(run, after.node, step);
        }
      }
    } catch (e) {
      const message = (e as Error).message;
      this.logger.warn(`Workflow node ${nodeId} failed: ${message}`);
      await this.runner.failNode(nodeId, message);
      await this.publish(run.workspaceId, 'workflow-node.failed', run.id, run.rootDocumentId, null, message);
    } finally {
      await this.runner.reconcileRun(run.id);
    }
  }

  private async publish(
    workspaceId: string,
    type: string,
    runId: string,
    documentId: string,
    draft?: WorkflowNodeDraft | null,
    error?: string,
  ): Promise<void> {
    await this.events.publish({
      type,
      workspaceId,
      subjectId: runId,
      documentId,
      ...(draft?.title ? { title: draft.title } : {}),
      ...(error ? { patch: { error } } : {}),
    });
  }
}
