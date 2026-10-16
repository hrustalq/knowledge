import { BadRequestException } from '@nestjs/common';
import type { MergeRequestProvenance } from '@knowledge/contracts';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StorageService } from '../storage/storage.service.js';
import type { DocumentsService } from './documents.service.js';
import type { MergeRequestsService } from './merge-requests.service.js';
import { t } from '../i18n/t.js';

/** The services a draft needs to become a merge request. Passed in, not injected: this is a function, not a provider. */
export interface DraftMergeRequestDeps {
  prisma: PrismaService;
  storage: StorageService;
  documents: DocumentsService;
  mergeRequests: MergeRequestsService;
}

export interface DraftMergeRequestInput {
  documentId: string;
  /** The branch the draft lands on. Unique per draft — `agent/<key>-<ts>`, `report/<issueId8>-<ts>`. */
  branch: string;
  title: string;
  description: string;
  /** The COMPLETE new file — frontmatter included. Callers compose it; nothing here puts it back. */
  markdown: string;
  /** Who the branch, revision and merge request are attributed to. */
  userId: string;
  /**
   * Runs inside the transaction once the merge request exists, for a caller
   * that must record the id in the same commit — a finding's `mergeRequestId`,
   * an issue's `merge_request_id`. A failure here rolls the whole draft back.
   */
  onCreated?: (mergeRequestId: string) => Promise<void>;
  /** Who opened it when a person did not (issue #73): `agent` for a finding, `captured` for a capture or a chat save. */
  provenance?: MergeRequestProvenance;
  /** The `knowledge_captures` row, for a capture's merge request. */
  captureId?: string;
  /**
   * The page was created head-less for this draft and is nothing until it
   * merges (#73, Option A): mark it so every list leaves it out until then.
   */
  newPage?: boolean;
}

/**
 * A body that already exists becomes a merge request: branch, revision, bytes,
 * finalize, open — in one transaction, as one person (docs/features/20, 35, 38).
 *
 * Written once because two callers need exactly this and nothing else: the
 * Propose button's path through `AgentFindingsService` (a finding's draft) and
 * a knowledge issue filed with a corrected page (an editor's draft). Neither
 * calls a model; the worker or the reporter already wrote the body, and this is
 * the API publishing it — feature 17's rule.
 *
 * Everything commits together. The merge request id used to be written back
 * after `mergeRequests.create` had committed, so a failure in between left a
 * claimed finding beside an orphaned merge request nothing pointed at. The
 * model call (where a caller makes one) stays OUTSIDE: it routinely takes tens
 * of seconds, and no Postgres transaction should be held open across it.
 */
export async function openDraftMergeRequest(deps: DraftMergeRequestDeps, input: DraftMergeRequestInput): Promise<string> {
  return deps.prisma.withTransaction(
    async () => {
      await deps.documents.createBranch(input.documentId, { name: input.branch });
      const revision = await deps.documents.createRevision(
        input.documentId,
        { branch: input.branch, message: input.title, contentType: 'text/markdown' },
        undefined,
        input.userId,
      );
      const row = await deps.prisma.documentRevision.findUnique({ where: { id: revision.revisionId } });
      if (!row) throw new BadRequestException(t('error.ai.draftRevisionGone'));
      await deps.storage.putObjectText(row.s3Key, input.markdown, 'text/markdown');
      await deps.documents.finalizeRevision(input.documentId, revision.revisionId);

      const mr = await deps.mergeRequests.create(
        input.documentId,
        { sourceBranch: input.branch, title: input.title, description: input.description.slice(0, 4_000) },
        input.userId,
        { provenance: input.provenance, captureId: input.captureId },
      );
      const mergeRequestId = mr.mergeRequest.mergeRequestId;
      if (input.newPage) {
        await deps.prisma.document.update({ where: { id: input.documentId }, data: { pendingMergeRequestId: mergeRequestId } });
      }
      if (input.onCreated) await input.onCreated(mergeRequestId);
      return mergeRequestId;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}
