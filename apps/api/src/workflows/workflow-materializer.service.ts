import { Injectable, Logger } from '@nestjs/common';
import type { WorkflowRun, WorkflowRunNode } from '@prisma/client';
import type { RelationInput, WorkflowNodeDraft, WorkflowStep } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentsService } from '../documents/documents.service.js';

/**
 * Turns an approved draft into a real page (docs/features/17).
 *
 * This lives on the API side rather than in the worker because
 * `DocumentsModule` is controller-bearing and cannot be loaded into the worker
 * process. That is not a workaround — it produced the rule the whole feature
 * rests on: **the worker generates, the API writes to the page tree**, so
 * nothing a model produced can reach the knowledge base except through a
 * request a person made.
 */
@Injectable()
export class WorkflowMaterializerService {
  private readonly logger = new Logger(WorkflowMaterializerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
  ) {}

  /**
   * Create + finalize a page from the node's draft. Returns the new document
   * id, or null when the step produces nothing (a pure review gate).
   *
   * Idempotent: a node that already carries a documentId is returned as-is, so
   * a retried approval cannot create the page twice.
   */
  async materialize(
    node: WorkflowRunNode,
    run: WorkflowRun,
    step: WorkflowStep,
    userId?: string,
  ): Promise<string | null> {
    if (node.documentId) return node.documentId;
    if (!step.produces) return null;

    const draft = node.draft as unknown as WorkflowNodeDraft | null;
    if (!draft?.title?.trim()) {
      throw new Error('This step has no draft to publish');
    }

    // The parent page: the node's parent if it was itself materialised,
    // otherwise the run's source page. That is what makes the chain
    // entity → use-case → endpoint nest correctly rather than flattening.
    const parent = await this.parentDocumentOf(node, run);

    // `doc:<id>` is the graph's convention for a page-as-entity; the name is
    // carried so the resulting vertex is legible in the graph view rather than
    // being a bare uuid.
    const relations: RelationInput[] = [
      ...(draft.relations ?? []),
      ...(parent
        ? [
            {
              type: step.produces.relationToParent,
              target: { type: 'doc', key: `doc:${parent.id}`, name: parent.title },
            },
          ]
        : []),
    ];
    const parentDocumentId = parent?.id ?? null;

    const created = await this.documents.createDocument(
      {
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        title: draft.title.trim(),
        content: { mode: 'inline', format: 'markdown', text: this.withFrontmatter(draft) },
        category: step.produces.category,
        ...(step.produces.nestUnderParent !== false && parentDocumentId
          ? { parentId: parentDocumentId }
          : {}),
        relations,
      },
      userId,
    );

    // Drafts arrive complete, so there is nothing to upload — finalize straight
    // away and let the normal ingestion pipeline index it.
    await this.documents.finalizeRevision(created.documentId, created.revisionId);
    this.logger.log(`Workflow run ${run.id} materialised node ${node.id} as ${created.documentId}`);
    return created.documentId;
  }

  private async parentDocumentOf(
    node: WorkflowRunNode,
    run: WorkflowRun,
  ): Promise<{ id: string; title: string } | null> {
    let parentId = run.rootDocumentId;
    if (node.parentId) {
      const parentNode = await this.prisma.workflowRunNode.findUnique({
        where: { id: node.parentId },
        select: { documentId: true },
      });
      // A parent that produced no page of its own (a search or review step) is
      // transparent: its child hangs off the run's source page instead.
      parentId = parentNode?.documentId ?? run.rootDocumentId;
    }
    const document = await this.prisma.document.findUnique({
      where: { id: parentId },
      select: { id: true, title: true },
    });
    return document ?? null;
  }

  /**
   * Frontmatter is written back into the markdown rather than stored beside it:
   * the ingestion worker reads relations and tags out of frontmatter, so this
   * is what makes a generated page's relations deterministic facts (plan.md §5)
   * instead of something only the workflow knows.
   */
  private withFrontmatter(draft: WorkflowNodeDraft): string {
    const fm = draft.frontmatter;
    if (!fm || Object.keys(fm).length === 0) return draft.markdown;
    if (draft.markdown.startsWith('---')) return draft.markdown;

    const lines = Object.entries(fm).map(([key, value]) => {
      if (Array.isArray(value)) return `${key}:\n${value.map((v) => `  - ${String(v)}`).join('\n')}`;
      return `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
    });
    return `---\n${lines.join('\n')}\n---\n\n${draft.markdown}`;
  }
}
