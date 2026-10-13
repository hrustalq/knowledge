import { Injectable, Logger } from '@nestjs/common';
import type { WorkflowRun, WorkflowRunNode } from '@prisma/client';
import type { RelationInput, WorkflowNodeDraft, WorkflowStep } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { writeFrontmatter } from '../common/frontmatter.js';
import { DocumentsService } from '../documents/documents.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { t } from '../i18n/t.js';

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
    private readonly templates: TemplatesService,
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
      throw new Error(t('error.workflow.noDraft'));
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
    const template = await this.provenanceOf(run, draft);

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
        // `content` is present, so this is recorded rather than rendered: the
        // draft already carries the template's structure and defaults.
        ...(template ? { template } : {}),
      },
      userId,
    );

    // Drafts arrive complete, so there is nothing to upload — finalize straight
    // away and let the normal ingestion pipeline index it.
    await this.documents.finalizeRevision(created.documentId, created.revisionId);
    this.logger.log(`Workflow run ${run.id} materialised node ${node.id} as ${created.documentId}`);
    return created.documentId;
  }

  /**
   * The template the draft was written against, if it still resolves at that
   * version. A customised built-in that was reset since drafting has lost its
   * versions; provenance is a label, and losing it must not strand a node a
   * person has already approved in `materializing`.
   */
  private async provenanceOf(
    run: WorkflowRun,
    draft: WorkflowNodeDraft,
  ): Promise<{ ref: string; version: number } | null> {
    if (!draft.templateRef || !draft.templateVersion) return null;
    try {
      const resolved = await this.templates.resolve(run.workspaceId, draft.templateRef, draft.templateVersion);
      return { ref: resolved.ref, version: resolved.version };
    } catch {
      this.logger.warn(
        `Workflow run ${run.id}: template ${draft.templateRef} v${draft.templateVersion} no longer resolves; materialising without provenance`,
      );
      return null;
    }
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
    // This used to hand-roll YAML and, worse, `return draft.markdown` whenever
    // the body already began with `---` — so a draft that carried its own
    // frontmatter had everything the step produced silently dropped. Merging is
    // the fix, and it belongs in one helper rather than here.
    return writeFrontmatter(draft.markdown, fm);
  }
}
