import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import matter from 'gray-matter';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { GraphService } from '../graph/graph.service.js';
import { EMBEDDING_PROVIDER, embeddingSignature, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { FULLTEXT_PROVIDER, type FulltextProvider } from '../fulltext/fulltext.provider.js';
import { INGESTION_QUEUE } from './ingestion.constants.js';
import { chunkEmbedText, chunkSections, splitMarkdown } from './markdown.js';
import { extractFrontmatterFacts } from './relations.js';
import { ExtractorFactory } from '../extraction/extractor-factory.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { IngestionProducer } from './ingestion.producer.js';

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
  ) {
    super();
  }

  async onModuleInit() {
    await this.graph.ensureSchema();
  }

  async process(job: Job<IngestionJobData>): Promise<void> {
    const { ingestionJobId } = job.data;
    const jobRow = await this.prisma.ingestionJob.findUnique({ where: { id: ingestionJobId } });
    if (!jobRow) {
      this.logger.warn(`Ingestion job ${ingestionJobId} not found — skipping`);
      return;
    }
    if (jobRow.status === 'completed') return; // idempotent retry guard

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

    try {
      // 1. Fetch raw bytes
      const raw = await this.storage.getObjectText(revision.s3Key);

      // 2. Parse (markdown only in Phase 1)
      if (!revision.contentType.includes('markdown') && !revision.contentType.startsWith('text/')) {
        throw new Error(`Unsupported content type for Phase 1 ingestion: ${revision.contentType}`);
      }
      const parsed = matter(raw);

      // 3. Normalize → persist normalized.json next to the source (plan.md §4 layout)
      const sections = splitMarkdown(parsed.content);
      const normalized = {
        frontmatter: parsed.data,
        headings: sections.map((s) => s.headingPath.join(' > ')),
        plainText: parsed.content,
        sections,
      };
      const normalizedKey = revision.s3Key.replace(/[^/]+$/, 'normalized.json');
      await this.storage.putObjectJson(normalizedKey, normalized);

      // 4. Chunk
      const drafts = chunkSections(sections);

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

      // 6. Index into graph store (idempotent per revision)
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
      });

      // 6b. Phase 5 optional BM25 layer: mirror the chunks into the fulltext
      //     index (idempotent per revision). Non-fatal — the vector index in
      //     the graph store stays authoritative.
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
        );
      } catch (e) {
        this.logger.warn(`Fulltext indexing failed for revision ${revision.id} (non-fatal): ${(e as Error).message}`);
      }

      // 7. Deterministic relation extraction (plan.md §5 "deterministic" class):
      //    frontmatter `relations:`/`tags:` → typed edges with provenance.
      const facts = extractFrontmatterFacts(parsed.data ?? {});
      await this.graph.replaceRevisionFrontmatterFacts({
        workspaceId: revision.document.workspaceId,
        documentId: revision.documentId,
        revisionId: revision.id,
        title: revision.document.title,
        facts: facts.map((f) => ({ ...f, extractor: 'frontmatter' as const, confidence: 1 })),
      });

      // 8. Inferred relation extraction (plan.md §11 Phase 4): LLM-derived
      //    edges tagged 'inferred' with confidence + source chunk. Non-fatal —
      //    the revision is already indexed; a flaky LLM must not fail the job.
      //    Runs even when disabled so stale inferred edges are cleared.
      try {
        // Resolved per job: the workspace may route extraction at its own
        // provider profile (docs/features/12), falling back to EXTRACTOR_*.
        const { extractor, tuning } = await this.extractors.forWorkspace(revision.document.workspaceId);
        const inferred = extractor.enabled
          ? await extractor.extract({
              documentTitle: revision.document.title,
              minConfidence: tuning.minConfidence,
              maxChunks: tuning.maxChunks,
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
        });
        if (inferred.length > 0) {
          this.logger.log(`Inferred ${inferred.length} relation(s) for revision ${revision.id}`);
        }
      } catch (e) {
        this.logger.warn(`Inferred extraction failed for revision ${revision.id} (non-fatal): ${(e as Error).message}`);
      }

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
      const reason = (jobRow.payload as { reason?: string } | null)?.reason;
      if (reason !== 'dependent-reindex') {
        await this.reindexDependents(revision.document.workspaceId, revision.documentId).catch((e) =>
          this.logger.warn(`Dependent reindex failed (non-fatal): ${(e as Error).message}`),
        );
      }
    } catch (e) {
      const error = { message: (e as Error).message, stack: (e as Error).stack };
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

  /**
   * Feature 04 (docs/features/04): re-index documents that depend on entities
   * this document DESCRIBES. One level only (see caller), capped by
   * DEPENDENT_REINDEX_MAX, skipping heads that already have a pending job.
   */
  private async reindexDependents(workspaceId: string, documentId: string): Promise<void> {
    const max = this.config.get('DEPENDENT_REINDEX_MAX', { infer: true });
    if (max <= 0) return;

    const g = await this.graph.getWorkspaceRelationGraph(workspaceId);
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
      await this.producer.enqueue(job.id).catch(() => {
        /* outbox sweeper re-enqueues */
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
