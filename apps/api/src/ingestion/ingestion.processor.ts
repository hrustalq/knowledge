import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import matter from 'gray-matter';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { GraphService } from '../graph/graph.service.js';
import { stampWindow } from '../graph/temporal.js';
import { loadRevisionStamps } from '../graph/revision-stamps.js';
import { ConflictsService } from '../conflicts/conflicts.service.js';
import { EMBEDDING_PROVIDER, embeddingSignature, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { FULLTEXT_PROVIDER, type FulltextProvider } from '../fulltext/fulltext.provider.js';
import { INGESTION_QUEUE } from './ingestion.constants.js';
import { chunkEmbedText, chunkSections, splitMarkdown } from './markdown.js';
import { extractFrontmatterFacts } from './relations.js';
import { ExtractorFactory } from '../extraction/extractor-factory.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { IngestionProducer } from './ingestion.producer.js';
import { UNFILTERED } from '../common/document-acl.js';
import { ComponentsService } from '../components/components.service.js';
import { ApiSpecsService, type ApiSpecProjection } from '../api-specs/api-specs.service.js';
import { isApiSpecKind } from '@knowledge/contracts';
import { bindTrace, currentTrace, emitBacktest, startTrace, withTrace } from '@knowledge/observability';

interface IngestionJobData {
  ingestionJobId: string;
}

@Processor(INGESTION_QUEUE)
export class IngestionProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly graph: GraphService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    private readonly extractors: ExtractorFactory,
    @Inject(FULLTEXT_PROVIDER) private readonly fulltext: FulltextProvider,
    private readonly config: ConfigService<Env, true>,
    private readonly events: EventsPublisher,
    private readonly producer: IngestionProducer,
    private readonly components: ComponentsService,
    private readonly apiSpecs: ApiSpecsService,
    private readonly conflicts: ConflictsService,
  ) {
    super();
  }

  async onModuleInit() {
    await this.graph.ensureSchema(this.embeddings.dimension);
  }

  /**
   * Opens the job's correlation scope, then runs the pipeline.
   *
   * The scope has to be opened here because AsyncLocalStorage does not cross the
   * BullMQ boundary — the enqueue happened in another process, under another
   * request, possibly minutes ago. The parent link is recovered from
   * ingestion_jobs.payload, which is already a free-form Json column (it carries
   * `reason` and `triggeredBy`), so joining a job back to the request that
   * queued it cost no migration and no change to the queue's payload type.
   */
  async process(job: Job<IngestionJobData>): Promise<void> {
    return withTrace(
      startTrace('job', { route: INGESTION_QUEUE, jobId: job.data.ingestionJobId }),
      () => this.runJob(job),
    );
  }

  private async runJob(job: Job<IngestionJobData>): Promise<void> {
    const { ingestionJobId } = job.data;
    const jobRow = await this.prisma.ingestionJob.findUnique({ where: { id: ingestionJobId } });
    if (!jobRow) {
      this.logger.warn(`Ingestion job ${ingestionJobId} not found — skipping`);
      return;
    }
    if (jobRow.status === 'completed') return; // idempotent retry guard

    // Known only after the row is read, which is what bindTrace exists for.
    const jobPayload = jobRow.payload as { reason?: string; traceId?: string } | null;
    bindTrace({ workspaceId: jobRow.workspaceId, parentTraceId: jobPayload?.traceId });

    const revision = await this.prisma.documentRevision.findUnique({
      where: { id: jobRow.revisionId },
      include: { document: true },
    });
    if (!revision) throw new Error(`Revision ${jobRow.revisionId} not found`);

    await this.prisma.$transaction([
      this.prisma.ingestionJob.update({
        where: { id: ingestionJobId },
        data: { status: 'running', attempts: { increment: 1 }, startedAt: new Date() },
      }),
      this.prisma.documentRevision.update({
        where: { id: revision.id },
        data: { status: 'indexing' },
      }),
    ]);

    // Declared outside the try so the catch can still report which step the
    // pipeline reached before it failed — that is the single most useful thing
    // to know about a failed ingestion, and it is exactly what is lost when the
    // only record is the final error.
    const steps: Array<{ step: string; ms: number; count?: number; ok: boolean }> = [];
    const pipelineStart = process.hrtime.bigint();
    let stepStart = pipelineStart;
    const mark = (step: string, count?: number): void => {
      const now = process.hrtime.bigint();
      steps.push({ step, ms: Number(now - stepStart) / 1e6, count, ok: true });
      stepStart = now;
    };

    // #83: only the head of the default branch is served by workspace-wide
    // reads. Decided before writing so a branch or superseded revision never
    // enters the live projection, not even between the write and `setLive`.
    const live = (await this.defaultBranchHeadId(revision.documentId)) === revision.id;

    try {
      // 1. Fetch raw bytes
      const raw = await this.storage.getObjectText(revision.s3Key);
      mark('fetch', raw.length);

      // 2. Parse. A spec document (#78) is parsed by its kind, not its content
      //    type, and indexed as its markdown projection, so everything from
      //    step 3 on is the page pipeline unchanged. A spec that will not parse
      //    fails the job with the validator's messages, which finalize would
      //    have refused unless a limit was lowered since.
      const kind = revision.document.kind;
      let spec: ApiSpecProjection | null = null;
      let parsed: { content: string; data: Record<string, unknown> };
      if (isApiSpecKind(kind)) {
        spec = await this.apiSpecs.project({
          workspaceId: revision.document.workspaceId,
          documentId: revision.documentId,
          revisionId: revision.id,
          kind,
          raw,
          live,
        });
        parsed = { content: spec.markdown, data: {} };
      } else {
        if (!revision.contentType.includes('markdown') && !revision.contentType.startsWith('text/')) {
          throw new Error(`Unsupported content type for Phase 1 ingestion: ${revision.contentType}`);
        }
        parsed = matter(raw);
      }

      // 3. Normalize → persist normalized.json next to the source (plan.md §4 layout)
      const sections = splitMarkdown(parsed.content);
      const normalized = {
        frontmatter: parsed.data,
        headings: sections.map((s) => s.headingPath.join(' > ')),
        plainText: parsed.content,
        sections,
        ...(spec
          ? {
              spec: {
                kind,
                specVersion: spec.spec.specVersion,
                title: spec.spec.title,
                version: spec.spec.version,
                slug: spec.slug,
                operations: spec.operations.length,
              },
            }
          : {}),
      };
      const normalizedKey = revision.s3Key.replace(/[^/]+$/, 'normalized.json');
      await this.storage.putObjectJson(normalizedKey, normalized);
      // Body length without frontmatter, so "empty page" is a PG question
      // (docs/features/39). Idempotent with the rest of the step.
      await this.prisma.documentRevision.update({
        where: { id: revision.id },
        data: { bodyChars: parsed.content.trim().length },
      });
      mark('normalize', sections.length);

      // 4. Chunk
      const drafts = chunkSections(sections);
      mark('chunk', drafts.length);

      // 5. Embed — as title + heading breadcrumb + body, never the bare body
      //    (chunkEmbedText). The stored `text` below stays verbatim.
      const embeddingsOut: number[][] = [];
      for (let i = 0; i < drafts.length; i += 32) {
        const batch = drafts.slice(i, i + 32);
        embeddingsOut.push(
          ...(await this.embeddings.embedBatch(
            batch.map((c) => chunkEmbedText(c, revision.document.title)),
          )),
        );
      }
      mark('embed', embeddingsOut.length);

      // 6. Index into graph store (idempotent per revision). The page's
      //    restrictions are read now, not with the job: embedding takes long
      //    enough for one to change, and the stamp should be the latest (#76).
      //    A change after this read bumps acl_version and the re-stamp sweeper
      //    catches up; the stamps only prefilter either way.
      const aclNodes = (
        await this.prisma.document.findUnique({ where: { id: revision.documentId }, select: { restrictedBy: true } })
      )?.restrictedBy ?? revision.document.restrictedBy;
      await this.graph.upsertRevisionChunks({
        workspaceId: revision.document.workspaceId,
        documentId: revision.documentId,
        revisionId: revision.id,
        title: revision.document.title,
        chunks: drafts.map((c, i) => ({
          chunkId: `${revision.id}:${c.index}`,
          index: c.index,
          text: c.text,
          headingPath: c.headingPath,
          embedding: embeddingsOut[i],
        })),
        live,
        aclNodes,
      });
      mark('graph', drafts.length);

      // 6b. Phase 5 optional BM25 layer: mirror the chunks into the fulltext
      //     index (idempotent per revision). Non-fatal — the vector index in
      //     the graph store stays authoritative. A failure stamps the revision
      //     for the stale sweeper to re-mirror (#173); a success clears a stamp
      //     an earlier attempt left.
      try {
        await this.fulltext.indexRevisionChunks(
          revision.document.workspaceId,
          revision.id,
          drafts.map((c) => ({
            chunkId: `${revision.id}:${c.index}`,
            documentId: revision.documentId,
            revisionId: revision.id,
            index: c.index,
            text: c.text,
            headingPath: c.headingPath,
          })),
          { live, aclNodes },
        );
        if (this.fulltext.enabled) await this.markFulltext(revision.id, 'in-step');
      } catch (e) {
        this.logger.warn(
          `Fulltext indexing failed for revision ${revision.id} (non-fatal; the stale sweeper re-mirrors it): ${(e as Error).message}`,
        );
        await this.markFulltext(revision.id, 'stale');
      }
      mark('fulltext');

      // 7. Deterministic relation extraction (plan.md §5 "deterministic" class):
      //    frontmatter `relations:`/`tags:`, and the operations a page's API
      //    blocks mirror (#78) → typed edges with provenance. A spec's body is
      //    its own projection, which declares nothing.
      const facts = extractFrontmatterFacts(parsed.data ?? {}, spec ? '' : parsed.content);
      await this.graph.replaceRevisionFrontmatterFacts({
        workspaceId: revision.document.workspaceId,
        documentId: revision.documentId,
        revisionId: revision.id,
        title: revision.document.title,
        facts: facts.map((f) => ({ ...f, extractor: 'frontmatter' as const, confidence: 1 })),
        live,
      });
      mark('relations', facts.length);

      // 7a. #78: a spec DESCRIBES every operation and channel it defines.
      //     Revision-scoped like frontmatter, so a branch's operations join the
      //     live graph only when the branch merges. Skipped for pages: a kind
      //     never changes, so a page has no spec edges to clear.
      const specFacts = spec ? specDescribes(spec) : [];
      if (spec) {
        await this.graph.replaceRevisionSpecFacts({
          workspaceId: revision.document.workspaceId,
          documentId: revision.documentId,
          revisionId: revision.id,
          title: revision.document.title,
          facts: specFacts,
          live,
        });
      }
      mark('spec', specFacts.length);

      // 7b. #236: a `component:` block on the default-branch head declares the
      //     code the page documents. A branch revision declares nothing until it
      //     merges. Recording may throw (the job retries); the edge rebuild is
      //     non-fatal, because the next codebase pull rebuilds them anyway.
      if (live) {
        const changed = await this.components.record({
          workspaceId: revision.document.workspaceId,
          documentId: revision.documentId,
          revisionId: revision.id,
          title: revision.document.title,
          frontmatter: parsed.data ?? {},
        });
        if (changed) {
          await this.components
            .rebuild(revision.document.workspaceId)
            .catch((e) => this.logger.warn(`Code edge rebuild failed (non-fatal): ${(e as Error).message}`));
        }
      }
      mark('component');

      // 8. Inferred relation extraction (plan.md §11 Phase 4): LLM-derived
      //    edges tagged 'inferred' with confidence + source chunk. Non-fatal —
      //    the revision is already indexed; a flaky LLM must not fail the job.
      //    Runs even when disabled so stale inferred edges are cleared.
      try {
        // Resolved per job: the workspace may route extraction at its own
        // provider profile (docs/features/12), falling back to EXTRACTOR_*.
        const { extractor, tuning, config } = await this.extractors.forWorkspace(
          revision.document.workspaceId,
        );
        const inferred = extractor.enabled
          ? await extractor.extract({
              documentTitle: revision.document.title,
              minConfidence: tuning.minConfidence,
              maxChunks: tuning.maxChunks,
              // Billed to whoever wrote the revision — the worker has no
              // principal, and ai_usage.user_id must be a real uuid.
              config,
              userId: revision.authorId,
              chunks: drafts.map((c) => ({
                chunkId: `${revision.id}:${c.index}`,
                text: c.text,
                headingPath: c.headingPath,
              })),
            })
          : [];
        await this.graph.replaceRevisionInferredFacts({
          workspaceId: revision.document.workspaceId,
          documentId: revision.documentId,
          revisionId: revision.id,
          title: revision.document.title,
          facts: inferred.map((f) => ({ ...f, extractor: 'inferred' as const })),
          live,
        });
        if (inferred.length > 0) {
          this.logger.log(`Inferred ${inferred.length} relation(s) for revision ${revision.id}`);
        }
      } catch (e) {
        this.logger.warn(`Inferred extraction failed for revision ${revision.id} (non-fatal): ${(e as Error).message}`);
      }
      mark('inferred');

      // 9. #83: retire the previous revisions' projection now that this one is
      //    written. Re-reads the head rather than trusting `live` above — the
      //    head may have moved while this job ran. Inside the try on purpose:
      //    a failure here leaves stale rows served, so the job must retry.
      await this.reconcileLive(revision.document.workspaceId, revision.documentId, revision.id);
      mark('live');

      // 9a. #81: stamp valid time on this revision and its default-branch
      //     neighbours, from PG. Inside the try for the same reason as 9.
      await this.stampValidity(revision.document.workspaceId, revision.documentId, revision.id);
      mark('validity');

      await this.prisma.$transaction([
        this.prisma.ingestionJob.update({
          where: { id: ingestionJobId },
          data: { status: 'completed', completedAt: new Date() },
        }),
        this.prisma.documentRevision.update({
          where: { id: revision.id },
          data: {
            status: 'indexed',
            indexedAt: new Date(),
            // Phase 5 stale detection: record the embedding space; drift → reindex.
            embeddingModel: embeddingSignature(this.config),
          },
        }),
      ]);
      this.logger.log(`Indexed revision ${revision.id} (${drafts.length} chunks)`);

      // One event per revision carrying every step, rather than one event per
      // step: nine records that only mean something together are nine records
      // a harness has to reassemble.
      emitBacktest({
        ...(currentTrace() ?? { traceId: 'unscoped', source: 'job' as const }),
        workspaceId: revision.document.workspaceId,
        kind: 'ingest.step',
        ts: new Date().toISOString(),
        durationMs: Number(process.hrtime.bigint() - pipelineStart) / 1e6,
        documentId: revision.documentId,
        revisionId: revision.id,
        ok: true,
        bytes: raw.length,
        chunks: drafts.length,
        embeddingModel: embeddingSignature(this.config),
        steps,
      });

      // Feature 04 (docs/features/04): live event + one level of dependent
      // fan-out. Cascade jobs are marked with payload.reason and never
      // re-cascade — no transitive reindex storms.
      await this.events.publish({
        type: 'revision.indexed',
        workspaceId: revision.document.workspaceId,
        documentId: revision.documentId,
        revisionId: revision.id,
        title: revision.document.title,
      });
      const reason = jobPayload?.reason;
      if (reason !== 'dependent-reindex') {
        await this.reindexDependents(revision.document.workspaceId, revision.documentId).catch((e) =>
          this.logger.warn(`Dependent reindex failed (non-fatal): ${(e as Error).message}`),
        );
      }
    } catch (e) {
      const error = { message: (e as Error).message, stack: (e as Error).stack };
      // `steps` holds everything that completed before the throw, so the failure
      // record says how far the pipeline got — bytes and chunks are absent here
      // because the throw may have preceded them.
      emitBacktest({
        ...(currentTrace() ?? { traceId: 'unscoped', source: 'job' as const }),
        workspaceId: revision.document.workspaceId,
        kind: 'ingest.step',
        ts: new Date().toISOString(),
        durationMs: Number(process.hrtime.bigint() - pipelineStart) / 1e6,
        documentId: revision.documentId,
        revisionId: revision.id,
        ok: false,
        steps,
      });
      await this.prisma.$transaction([
        this.prisma.ingestionJob.update({
          where: { id: ingestionJobId },
          data: { status: 'failed', error },
        }),
        this.prisma.documentRevision.update({
          where: { id: revision.id },
          data: { status: 'failed' },
        }),
      ]);
      await this.events.publish({
        type: 'revision.failed',
        workspaceId: revision.document.workspaceId,
        documentId: revision.documentId,
        revisionId: revision.id,
        title: revision.document.title,
      });
      throw e; // let BullMQ retry with backoff
    }
  }

  private async defaultBranchHeadId(documentId: string): Promise<string | null> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { defaultBranch: true, branches: { select: { name: true, headRevisionId: true } } },
    });
    return doc?.branches.find((b) => b.name === doc.defaultBranch)?.headRevisionId ?? null;
  }

  /**
   * Point the document's live projection (#83) at its default-branch head,
   * once that head is indexed (or is the revision this job just wrote). Until then the previous live revision keeps
   * serving, so a page never drops out of search while its new revision is in
   * flight. Called after every job, so jobs finishing out of order converge on
   * the current head whichever lands last.
   *
   * Graph first, fulltext second, and the fulltext half is non-fatal like
   * every other BM25 write: the vector index stays authoritative.
   */
  private async reconcileLive(workspaceId: string, documentId: string, justWritten: string): Promise<void> {
    const headId = await this.defaultBranchHeadId(documentId);
    if (!headId) return;
    // The revision this job just wrote counts as indexed: its row flips to
    // `indexed` only after this returns.
    if (headId !== justWritten) {
      const head = await this.prisma.documentRevision.findUnique({ where: { id: headId }, select: { status: true } });
      if (head?.status !== 'indexed') return;
    }
    await this.graph.setLiveRevision(workspaceId, documentId, headId);
    // #81: an open conflict quoting an older revision of this page now quotes
    // text the page no longer says. Non-fatal: a missed supersede leaves a
    // stale conflict open until the next index, never a wrong page served.
    await this.conflicts
      .supersedeStale(workspaceId, documentId, headId)
      .catch((e) => this.logger.warn(`Conflict supersede failed for document ${documentId} (non-fatal): ${(e as Error).message}`));
    try {
      await this.fulltext.setLiveRevision(workspaceId, documentId, headId);
    } catch (e) {
      this.logger.warn(
        `Fulltext live update failed for document ${documentId} (non-fatal; the stale sweeper retries it): ${(e as Error).message}`,
      );
      await this.markFulltext(headId, 'stale');
    }
  }

  /**
   * Rewrite the valid-time stamps around `revisionId` (#81). The interval is
   * read from PG every time — `revisionStamps` over the page's finalized
   * revisions — so an out-of-order finish still converges: whichever job runs
   * last stamps its predecessor closed and itself open or closed.
   */
  private async stampValidity(workspaceId: string, documentId: string, revisionId: string): Promise<void> {
    const window = stampWindow(await loadRevisionStamps(this.prisma, documentId), revisionId);
    await this.graph.stampRevisions(workspaceId, documentId, window);
    // The BM25 mirror's copy is non-fatal like every other fulltext write; a
    // re-mirror by the stale sweeper stamps the revision again.
    try {
      await this.fulltext.stampRevisions(workspaceId, documentId, window);
    } catch (e) {
      this.logger.warn(`Fulltext validity stamp failed for document ${documentId} (non-fatal): ${(e as Error).message}`);
      await this.markFulltext(revisionId, 'stale');
    }
  }

  /**
   * The BM25 drift stamp (#173). `stale` restamps with the current time, so a
   * repair already in flight for an older stamp cannot clear this one; never
   * throws, because the write it records was already non-fatal.
   */
  private async markFulltext(revisionId: string, state: 'stale' | 'in-step'): Promise<void> {
    await this.prisma.documentRevision
      .updateMany({
        where: state === 'stale' ? { id: revisionId } : { id: revisionId, fulltextStaleAt: { not: null } },
        data: { fulltextStaleAt: state === 'stale' ? new Date() : null },
      })
      .catch((e: Error) => this.logger.warn(`Could not record fulltext state for revision ${revisionId}: ${e.message}`));
  }

  /**
   * Feature 04 (docs/features/04): re-index documents that depend on entities
   * this document DESCRIBES. One level only (see caller), capped by
   * DEPENDENT_REINDEX_MAX, skipping heads that already have a pending job.
   */
  private async reindexDependents(workspaceId: string, documentId: string): Promise<void> {
    const max = this.config.get('DEPENDENT_REINDEX_MAX', { infer: true });
    if (max <= 0) return;

    // A system read: which pages to re-index is not shown to anyone (#76).
    const g = await this.graph.getWorkspaceRelationGraph(workspaceId, UNFILTERED);
    const described = new Set(
      g.edges.filter((e) => e.documentId === documentId && e.type === 'DESCRIBES').map((e) => e.targetKey),
    );
    if (described.size === 0) return;

    const dependents = [
      ...new Set(
        g.edges
          .filter((e) => e.documentId !== documentId && described.has(e.targetKey))
          .map((e) => e.documentId),
      ),
    ].slice(0, max);

    for (const depId of dependents) {
      const doc = await this.prisma.document.findUnique({ where: { id: depId }, include: { branches: true } });
      if (!doc || doc.workspaceId !== workspaceId) continue;
      const headId = doc.branches.find((b) => b.name === doc.defaultBranch)?.headRevisionId;
      if (!headId) continue;
      const head = await this.prisma.documentRevision.findUnique({ where: { id: headId } });
      if (!head || head.status !== 'indexed') continue;
      const pending = await this.prisma.ingestionJob.findFirst({
        where: { revisionId: headId, status: { in: ['queued', 'running'] } },
      });
      if (pending) continue;

      const job = await this.prisma.ingestionJob.create({
        data: {
          workspaceId,
          revisionId: headId,
          type: 'reindex',
          status: 'queued',
          payload: {
            documentId: depId,
            revisionId: headId,
            s3Key: head.s3Key,
            title: doc.title,
            reason: 'dependent-reindex',
            triggeredBy: documentId,
          },
        },
      });
      await this.producer.enqueue(job.id).catch((err: unknown) => {
        // Still non-fatal: OutboxSweeper re-enqueues anything left `queued`,
        // which is the entire point of the outbox. Logged because "the sweeper
        // will pick it up in a moment" and "every enqueue is failing" are
        // indistinguishable from here — the second presents only as unexplained
        // indexing latency, with nothing to grep for.
        this.logger.warn({
          msg: 'Dependent reindex enqueue failed (outbox sweeper will retry)',
          code: 'JOB_ENQUEUE_FAILED',
          ingestionJobId: job.id,
          documentId: depId,
          err,
        });
      });
      await this.events.publish({
        type: 'revision.dependent-reindex',
        workspaceId,
        documentId: depId,
        revisionId: headId,
        title: doc.title,
      });
      this.logger.log(`Dependent reindex queued for "${doc.title}" (${depId}) after ${documentId}`);
    }
  }
}

/** One `DESCRIBES` per distinct operation entity: an AsyncAPI channel's send and receive are one vertex. */
function specDescribes(spec: ApiSpecProjection) {
  const byKey = new Map<string, ApiSpecProjection['operations'][number]>();
  for (const op of spec.operations) if (!byKey.has(op.entityKey)) byKey.set(op.entityKey, op);
  return [...byKey.values()].map((op) => ({
    type: 'DESCRIBES',
    target: {
      key: op.entityKey,
      type: op.protocol === 'http' ? 'op' : 'channel',
      // The spec's own spelling, so the graph view reads `GET /users/{id}`.
      name: op.protocol === 'http' ? `${op.method} ${op.path}` : op.path,
    },
    extractor: 'spec' as const,
    confidence: 1,
  }));
}

