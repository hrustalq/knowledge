import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AgentFinding,
  Locale,
  ProposeAgentFindingResponse,
  ProposeRelationsResponse,
} from '@knowledge/contracts';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { DocumentRelationsService } from '../documents/document-relations.service.js';
import { MergeRequestsService } from '../documents/merge-requests.service.js';
import { AgentRegistryService, type ResolvedAgent } from '../agents/agent-registry.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { AiUsageService } from './ai-usage.service.js';
import type { Principal } from '../auth/principal.js';

/** How much of a cited page the drafter is shown. The workflow executor's cap. */
const MAX_DOC_CHARS = 24_000;
/** Cited pages read into one proposal. A finding about twelve pages is a report, not an edit. */
const MAX_CITED = 3;

/**
 * Turning a Curator finding into a merge request (docs/features/20).
 *
 * This is the API half of feature 17's rule — *the worker generates, the API
 * publishes*. The Curator runs in the worker and can only ever propose; the act
 * of opening a merge request happens here, on an authenticated request, and is
 * attributed to the caller who pressed the button rather than to the run's
 * owner. Merging is the caller's act, so the authorship must be theirs.
 *
 * `MergeRequestsService` deliberately stays out of the worker even though
 * `AuthCoreModule` would now let it load there.
 */
@Injectable()
export class AgentFindingsService {
  private readonly logger = new Logger(AgentFindingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly documents: DocumentsService,
    private readonly relations: DocumentRelationsService,
    private readonly mergeRequests: MergeRequestsService,
    private readonly registry: AgentRegistryService,
    private readonly client: AssistantClient,
    private readonly usage: AiUsageService,
  ) {}

  async propose(
    workspaceId: string,
    runId: string,
    index: number,
    principal: Principal,
  ): Promise<ProposeAgentFindingResponse> {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.workspaceId !== workspaceId) throw new NotFoundException(t('error.ai.agentRunNotFound', { id: runId }));

    const findings = Array.isArray(run.findings) ? (run.findings as unknown as AgentFinding[]) : [];
    const finding = findings[index];
    if (!finding) throw new NotFoundException(t('error.ai.findingNotFound', { runId, index }));
    if (finding.mergeRequestId) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.ai.findingAlreadyProposed'),
        reason: 'already-proposed',
        mergeRequestId: finding.mergeRequestId,
      });
    }

    // A finding always cites the pages it came from (plan.md §12.7); the first
    // is the one being changed. An orphan finding cites a page but has nothing
    // to rewrite in it — the fix is a relation, not prose — so it is refused
    // here rather than sent to a model that would invent an edit.
    const documentId = finding.documentIds[0];
    if (!documentId) throw new BadRequestException(t('error.ai.findingNoDocument'));
    if (finding.kind === 'orphan') {
      throw new BadRequestException(t('error.ai.findingOrphan'));
    }

    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || document.workspaceId !== workspaceId) {
      throw new BadRequestException(t('error.ai.findingDocumentGone', { documentId }));
    }

    // Claim the slot before the model is called, in one statement Postgres
    // settles: two presses race here, and the loser sees the 409 above on its
    // next read rather than opening a second merge request. `jsonb_set` is
    // guarded on the claim still being absent, so exactly one caller proceeds.
    if (!(await this.claim(runId, index))) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.ai.findingInFlight'),
        reason: 'in-flight',
      });
    }

    try {
      const drafter = await this.registry.resolve(workspaceId, 'drafter');
      if (!drafter.enabled || !drafter.config.enabled) {
        throw new BadRequestException(t('error.ai.assistantDisabled'));
      }
      if (drafter.missing.length > 0) {
        throw new BadRequestException(
          t('error.ai.drafterCannot', { capabilities: drafter.missing.join(', ') }),
        );
      }
      await this.usage.assertWithinBudget(workspaceId, principal.userId);

      const markdown = await this.draft(finding, document, drafter, principal, run.locale as Locale);
      const title = `${finding.title.slice(0, 200)}`;
      const branch = `agent/${run.agentKey}-${Date.now()}`;

      // Everything the proposal writes commits together. The finding's
      // `mergeRequestId` used to be written after `mergeRequests.create` had
      // committed, so a failure in between left the finding claimed forever
      // (409 `in-flight`) beside an orphaned merge request nothing pointed at.
      //
      // The model call above is deliberately OUTSIDE: it routinely takes tens of
      // seconds, and no Postgres transaction should be held open across it. So
      // is the claim — it guards the LLM window, which is the part that
      // actually takes time, and a claim invisible until commit would guard
      // almost nothing.
      const mergeRequestId = await this.prisma.withTransaction(
        async () => {
          await this.documents.createBranch(documentId, { name: branch });
          const revision = await this.documents.createRevision(
            documentId,
            { branch, message: title, contentType: 'text/markdown' },
            undefined,
            principal.userId,
          );
          const row = await this.prisma.documentRevision.findUnique({ where: { id: revision.revisionId } });
          if (!row) throw new BadRequestException(t('error.ai.draftRevisionGone'));
          await this.storage.putObjectText(row.s3Key, markdown, 'text/markdown');
          await this.documents.finalizeRevision(documentId, revision.revisionId);

          const mr = await this.mergeRequests.create(
            documentId,
            {
              sourceBranch: branch,
              title,
              description:
                `Proposed from a ${run.agentKey} run.\n\n**${finding.kind}** — ${finding.detail}`.slice(0, 4_000),
            },
            principal.userId,
          );
          await this.writeBack(runId, index, mr.mergeRequest.mergeRequestId);
          return mr.mergeRequest.mergeRequestId;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );

      return { mergeRequestId, documentId, documentTitle: document.title, branch, title };
    } catch (error) {
      // Release the claim, or a failed proposal would make the finding
      // permanently unproposable. Nothing is left behind either way now: a
      // failure before the boundary had written nothing yet, and one inside it
      // rolled the branch, revision and merge request back.
      //
      // This MUST stay outside the boundary. It runs after the rollback, with
      // the ambient scope already gone, so it reaches the base client and
      // commits on its own — move it inside and the release rolls back with
      // everything else, which is precisely the stuck-at-409 bug being fixed.
      await this.release(runId, index).catch(() => {
        this.logger.warn(`Could not release the proposal claim on run ${runId} finding ${index}`);
      });
      throw error;
    }
  }

  /**
   * Apply a relation finding as a frontmatter change (docs/features/28).
   *
   * The sibling of `propose`, and deliberately not a branch inside it. That one
   * hands a page to the drafter and asks for a complete new body; a relation fix
   * must leave every byte outside `relations:`/`tags:` exactly as it was, which
   * is a structural edit and not a rewrite. It is also why no model is called
   * here at all — the relations were decided when the finding was made.
   *
   * The claim/write-back/release trio is reused verbatim: it is real concurrency
   * control, and two presses of Apply must not open two merge requests.
   */
  async applyRelations(
    workspaceId: string,
    runId: string,
    index: number,
    principal: Principal,
  ): Promise<ProposeRelationsResponse> {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.workspaceId !== workspaceId) {
      throw new NotFoundException(t('error.ai.agentRunNotFound', { id: runId }));
    }

    const findings = Array.isArray(run.findings) ? (run.findings as unknown as AgentFinding[]) : [];
    const finding = findings[index];
    if (!finding) throw new NotFoundException(t('error.ai.findingNotFound', { runId, index }));
    if (finding.mergeRequestId) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.ai.findingAlreadyProposed'),
        reason: 'already-proposed',
        mergeRequestId: finding.mergeRequestId,
      });
    }

    const documentId = finding.documentIds[0];
    if (!documentId) throw new BadRequestException(t('error.ai.findingNoDocument'));
    // The mirror of `propose`'s orphan refusal: that path rejects a finding whose
    // fix is a relation, so this one rejects a finding that carries none.
    if (!finding.relations?.length) throw new BadRequestException(t('error.ai.findingNoRelations'));

    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || document.workspaceId !== workspaceId) {
      throw new BadRequestException(t('error.ai.findingDocumentGone', { documentId }));
    }

    if (!(await this.claim(runId, index))) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.ai.findingInFlight'),
        reason: 'in-flight',
      });
    }

    try {
      const result = await this.relations.propose(
        documentId,
        {
          add: finding.relations,
          title: finding.title.slice(0, 200),
          description: `Proposed from a ${run.agentKey} run.\n\n**${finding.kind}** — ${finding.detail}`.slice(
            0,
            2_000,
          ),
        },
        principal,
      );

      // The page already declared everything the finding proposed — someone got
      // there first. Nothing was opened, so the claim must come off again or the
      // finding is stuck at 409 forever.
      if (!result.changed || !result.mergeRequestId) {
        await this.release(runId, index);
        return result;
      }

      await this.writeBack(runId, index, result.mergeRequestId);
      return result;
    } catch (error) {
      await this.release(runId, index).catch(() => {
        this.logger.warn(`Could not release the proposal claim on run ${runId} finding ${index}`);
      });
      throw error;
    }
  }

  /** The replacement page body, grounded in what the page says now. */
  private async draft(
    finding: AgentFinding,
    document: { id: string; title: string; workspaceId: string },
    drafter: ResolvedAgent,
    principal: Principal,
    locale: Locale,
  ): Promise<string> {
    const current = await this.documents.getContent(document.id).catch(() => null);
    if (!current) {
      throw new BadRequestException(t('error.ai.noReadableContent', { title: document.title }));
    }

    // Other cited pages are context, never targets: a finding about a
    // duplicate needs to see both pages to merge one into the other, but only
    // the first is edited.
    const others: string[] = [];
    for (const id of finding.documentIds.slice(1, MAX_CITED)) {
      const doc = await this.prisma.document.findUnique({ where: { id } });
      if (!doc || doc.workspaceId !== document.workspaceId || doc.id === document.id) continue;
      const content = await this.documents.getContent(id).catch(() => null);
      if (!content) continue;
      others.push(
        `<page title=${JSON.stringify(doc.title)} documentId="${doc.id}">\n${content.markdown.slice(0, MAX_DOC_CHARS)}\n</page>`,
      );
    }

    const raw = await this.client.chat(
      {
        config: drafter.config,
        userId: principal.userId,
        operation: 'agent',
        locale,
      },
      [
        {
          role: 'system',
          content:
            `${drafter.instructions}\n\n` +
            'You are addressing one finding from a documentation review. Return the COMPLETE new body of the ' +
            'page, not a patch and not an excerpt — what you return replaces the page. Keep everything the ' +
            'finding does not concern exactly as it is; a review fix is not a rewrite. Never invent facts the ' +
            'pages below do not support: where the fix needs information nobody wrote down, leave the existing ' +
            'text and say what is missing in prose. Other pages are shown as context only — do not copy them ' +
            'wholesale, and do not address them.',
        },
        {
          role: 'user',
          content:
            `Finding (${finding.kind}): ${finding.title}\n${finding.detail}\n\n` +
            `--- PAGE TO REWRITE: "${document.title}" ---\n${current.markdown.slice(0, MAX_DOC_CHARS)}` +
            (others.length ? `\n\n--- CONTEXT, DO NOT EDIT ---\n${others.join('\n\n')}` : ''),
        },
      ],
    );

    const markdown = raw
      .trim()
      .replace(/^```(?:markdown|md)?\s*\n/i, '')
      .replace(/\n```\s*$/, '')
      .trim();
    if (!markdown) throw new BadRequestException(t('error.ai.emptyPage'));
    return markdown;
  }

  /**
   * Set `proposedAt` only if it is not already set. One statement, so the
   * check and the write cannot be interleaved — `updateMany` cannot express a
   * condition on a value inside a Json column.
   */
  private async claim(runId: string, index: number): Promise<boolean> {
    // Every index is cast explicitly: `jsonb -> ?` needs an int, and a driver
    // that sends a JS number as numeric would fail to find the operator.
    const affected = await this.prisma.$executeRaw`
      UPDATE agent_runs
         SET findings = jsonb_set(
               findings,
               ARRAY[${String(index)}::text, 'proposedAt'],
               to_jsonb(${new Date().toISOString()}::text),
               true
             )
       WHERE id = ${runId}::uuid
         AND findings -> ${index}::int IS NOT NULL
         AND COALESCE(findings -> ${index}::int ->> 'proposedAt', '') = ''
         AND COALESCE(findings -> ${index}::int ->> 'mergeRequestId', '') = ''
    `;
    return affected > 0;
  }

  private async writeBack(runId: string, index: number, mergeRequestId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE agent_runs
         SET findings = jsonb_set(
               findings,
               ARRAY[${String(index)}::text, 'mergeRequestId'],
               to_jsonb(${mergeRequestId}::text),
               true
             )
       WHERE id = ${runId}::uuid
    `;
  }

  /**
   * The exact inverse of `claim`, which guards on BOTH keys.
   *
   * Clearing only `proposedAt` left any failure that happened after `writeBack`
   * with `mergeRequestId` still set — and both the 409 in `propose` and
   * `claim`'s own predicate read that key, so the finding was permanently
   * unproposable while pointing at a merge request that may have rolled back.
   *
   * Set to JSON `null` rather than removing the key, matching what this method
   * already did: `->>` on a JSON null yields SQL NULL, so `claim`'s
   * `COALESCE(…, '') = ''` passes unchanged.
   */
  private async release(runId: string, index: number): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE agent_runs
         SET findings = jsonb_set(
               jsonb_set(findings, ARRAY[${String(index)}::text, 'proposedAt'], 'null'::jsonb, true),
               ARRAY[${String(index)}::text, 'mergeRequestId'],
               'null'::jsonb,
               true
             )
       WHERE id = ${runId}::uuid
    `;
  }
}
