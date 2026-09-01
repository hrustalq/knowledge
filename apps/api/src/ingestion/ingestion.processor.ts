import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import matter from 'gray-matter';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { GraphService } from '../graph/graph.service.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { INGESTION_QUEUE } from './ingestion.constants.js';
import { chunkSections, splitMarkdown } from './markdown.js';
import { extractFrontmatterFacts } from './relations.js';
import { RELATION_EXTRACTOR, type RelationExtractor } from '../extraction/relation-extractor.provider.js';

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
    @Inject(RELATION_EXTRACTOR) private readonly extractor: RelationExtractor,
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

      // 5. Embed
      const embeddingsOut: number[][] = [];
      for (let i = 0; i < drafts.length; i += 32) {
        const batch = drafts.slice(i, i + 32);
        embeddingsOut.push(...(await this.embeddings.embedBatch(batch.map((c) => c.text))));
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
        const inferred = this.extractor.enabled
          ? await this.extractor.extract({
              documentTitle: revision.document.title,
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
          data: { status: 'indexed' },
        }),
      ]);
      this.logger.log(`Indexed revision ${revision.id} (${drafts.length} chunks)`);
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
      throw e; // let BullMQ retry with backoff
    }
  }
}
