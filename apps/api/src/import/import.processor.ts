import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import type { ImportJob } from '@prisma/client';
import type { ImportMeta } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { IMPORT_QUEUE } from './import.constants.js';
import { ParserRegistry } from './parsers/parser.registry.js';
import { extensionFor } from './parsers/docx.parser.js';
import { stripLeadingTitle } from './parsers/parser.types.js';
import type { ParsedImage, ParseResult } from './parsers/parser.types.js';
import { asLocale } from '../i18n/locale.js';
import { withLocale } from '../i18n/t.js';

interface ImportJobData {
  importJobId: string;
}

/** Stage writes are cheap but not free; this is the floor between two of them. */
const STAGE_THROTTLE_MS = 400;

/**
 * The parse half of the import flow.
 *
 * It is a worker job rather than a request handler for one reason: a 300-page
 * PDF takes longer than anyone should hold an HTTP connection, and the person
 * who started it may well close the tab. The row is the truth, the queue is the
 * scheduler, and the wizard is just a view of the row — so navigating away and
 * coming back finds the work exactly where it was left.
 *
 * The markdown lands in object storage rather than in the row: the row is
 * polled once a second, and a megabyte of prose does not belong in a poll.
 */
@Processor(IMPORT_QUEUE)
export class ImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ImportProcessor.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly parsers: ParserRegistry,
    private readonly events: EventsPublisher,
    config: ConfigService<Env, true>,
  ) {
    super();
    this.timeoutMs = config.get('IMPORT_PARSE_TIMEOUT_MS', { infer: true });
  }

  async process(job: Job<ImportJobData>): Promise<void> {
    const { importJobId } = job.data;
    const row = await this.prisma.importJob.findUnique({ where: { id: importJobId } });
    if (!row) {
      this.logger.warn(`Import ${importJobId} not found — skipping`);
      return;
    }
    // Everything below runs in the language the import was started in
    // (docs/features/18): parsers emit their stage labels and lossy-parse
    // warnings through the ambient t(), and out here there is no request to
    // resolve one from. The row's frozen locale is the answer.
    return withLocale(asLocale(row.locale), () => this.parse(job, row));
  }

  private async parse(job: Job<ImportJobData>, row: ImportJob): Promise<void> {
    // Idempotent: a re-delivered job for something already parsed (or already
    // turned into a page) must not overwrite what the reviewer is editing.
    if (row.status === 'parsed' || row.status === 'submitted') return;

    await this.prisma.importJob.update({
      where: { id: row.id },
      data: { status: 'running', startedAt: new Date(), stage: 'Starting', progress: null, error: Prisma.DbNull },
    });

    try {
      const parser = this.parsers.resolve(row.sourceFilename, row.contentType);
      if (!parser) throw new Error(`No parser handles ${row.sourceFilename}`);

      const bytes = await this.storage.getObjectBytes(row.s3Key);

      let lastStageWrite = 0;
      const result = await this.withTimeout(
        parser.parse(bytes, {
          workspaceId: row.workspaceId,
          importId: row.id,
          userId: row.createdBy ?? '',
          filename: row.sourceFilename,
          contentType: row.contentType,
          onStage: async (stage, progress) => {
            const now = Date.now();
            if (now - lastStageWrite < STAGE_THROTTLE_MS) return;
            lastStageWrite = now;
            await this.prisma.importJob
              .update({ where: { id: row.id }, data: { stage, progress: progress ?? null } })
              .catch(() => undefined);
          },
        }),
        row.sourceFilename,
      );

      await this.prisma.importJob.update({
        where: { id: row.id },
        data: { stage: 'Saving the result', progress: 0.95 },
      });

      // Images first: the review step renders them straight from staging, so
      // they have to exist before the markdown that references them is served.
      const images = result.images ?? [];
      for (const image of images) {
        await this.storage.putObjectBytes(
          this.imageKey(row.workspaceId, row.id, image),
          image.bytes,
          image.contentType,
        );
      }

      // The title field carries the document's name; the body should not say it
      // again on its first line.
      const body = stripLeadingTitle(result.markdown, result.title);

      await this.storage.putObjectText(
        this.storage.importObjectKey(row.workspaceId, row.id, 'parsed.md'),
        body,
        'text/markdown',
      );

      const meta: ImportMeta = { ...result.meta, images: images.length || result.meta.images };
      await this.prisma.importJob.update({
        where: { id: row.id },
        data: {
          status: 'parsed',
          parser: parser.id,
          stage: null,
          progress: 1,
          title: result.title?.slice(0, 300) ?? null,
          warnings: result.warnings,
          meta: meta as object,
          completedAt: new Date(),
        },
      });

      await this.events.publish({
        workspaceId: row.workspaceId,
        type: 'import.parsed',
        subjectId: row.id,
        title: row.sourceFilename,
      });
    } catch (e) {
      const message = (e as Error).message ?? 'Import failed';
      this.logger.warn(`Import ${row.id} failed: ${message}`);
      await this.prisma.importJob.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          stage: null,
          progress: null,
          error: { message: message.slice(0, 1000) },
          completedAt: new Date(),
        },
      });
      await this.events.publish({
        workspaceId: row.workspaceId,
        type: 'import.failed',
        subjectId: row.id,
        title: row.sourceFilename,
      });
      // Swallowed on purpose: the row already carries the failure, and letting
      // BullMQ retry would re-run a parse that will fail identically.
    }
  }

  private imageKey(workspaceId: string, importId: string, image: ParsedImage): string {
    return this.storage.importObjectKey(
      workspaceId,
      importId,
      `images/${image.index}${extensionFor(image.contentType)}`,
    );
  }

  /** A pathological file fails on the clock instead of pinning a worker forever. */
  private withTimeout(work: Promise<ParseResult>, filename: string): Promise<ParseResult> {
    return new Promise<ParseResult>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Parsing ${filename} took longer than ${Math.round(this.timeoutMs / 1000)}s and was stopped`)),
        this.timeoutMs,
      );
      work.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
}
