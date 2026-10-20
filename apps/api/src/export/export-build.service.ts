import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExportJob } from '@prisma/client';
import matter from 'gray-matter';
import { PANEL_TYPES, type PanelType } from '@knowledge/editor-schema/nodes';
import type { ExportErrorCode, ExportFormat, ExportRenderRequest, ExportScope, ExportStage, Locale } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { asLocale } from '../i18n/locale.js';
import { t, withLocale } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { planSiteBuild, type ResolvedRevision } from '../publishing/site-build.plan.js';
import { StorageService } from '../storage/storage.service.js';
import { exportObjectPrefix } from './export.constants.js';
import { EXPORT_CONTENT_TYPE, exportFilename } from './export.service.js';
import { writeDocx } from './export-docx.js';
import {
  archiveRoot,
  attachmentArchivePath,
  buildManifest,
  htmlAssetPath,
  pageHtmlPath,
  pageSourcePath,
  pdfAssetName,
  zipArchive,
  type PackagedAttachment,
  type PackagedPage,
} from './export-package.js';
import { ExportRenderClient } from './export-render.client.js';
import { ExportScopeService } from './export-scope.service.js';
import { GotenbergClient } from './gotenberg.client.js';

/** A failure the row can name: its code is what the web translates. */
class ExportFailure extends Error {
  constructor(
    readonly code: ExportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** An attachment as collected: where its bytes are, beside what the archive says about it. */
type CollectedAttachment = PackagedAttachment & { s3Key: string };

/** Parallel S3 reads while collecting sources and attachments. */
const READ_CONCURRENCY = 8;

const TEXT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

/**
 * Builds one export (docs/features/45), in the worker: resolves the scope
 * again, reads every page's source and attachments, has the web render HTML
 * where the format needs it, packages, writes the file and says so.
 *
 * It creates no page and attributes no act to anyone, so it completes itself:
 * the row it finishes is the person's own request, and the notification goes
 * to them through the event's run-owner rule.
 */
@Injectable()
export class ExportBuildService {
  private readonly logger = new Logger(ExportBuildService.name);
  private readonly maxPages: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly scope: ExportScopeService,
    private readonly renderer: ExportRenderClient,
    private readonly gotenberg: GotenbergClient,
    private readonly events: EventsPublisher,
    config: ConfigService<Env, true>,
  ) {
    this.maxPages = config.get('EXPORT_MAX_PAGES', { infer: true });
    this.maxBytes = config.get('EXPORT_MAX_BYTES', { infer: true });
    this.ttlMs = config.get('EXPORT_TTL_HOURS', { infer: true }) * 3_600_000;
    this.timeoutMs = config.get('EXPORT_TIMEOUT_MS', { infer: true });
  }

  async build(exportId: string): Promise<void> {
    // The claim: a row that is already finished — or was failed by the
    // sweeper — is never rebuilt by a redelivered job. `running` is allowed
    // back in for the one redelivery BullMQ makes after a worker died mid-job.
    const claimed = await this.prisma.exportJob.updateMany({
      where: { id: exportId, status: { in: ['queued', 'running'] } },
      data: { status: 'running', stage: 'collecting', startedAt: new Date() },
    });
    if (claimed.count === 0) return;
    const row = await this.prisma.exportJob.findUnique({ where: { id: exportId } });
    if (!row) return;
    // The contents page and its dates are in the language the export was
    // asked for in; there is no request out here to read one from.
    await withLocale(asLocale(row.locale), () => this.run(row));
  }

  private async run(row: ExportJob): Promise<void> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const { pages, attachments } = await this.collect(row);
      const format = row.format as ExportFormat;
      const bytes =
        format === 'zip'
          ? await this.zip(row, pages, attachments)
          : format === 'html'
            ? await this.html(row, pages, attachments, signal)
            : format === 'docx'
              ? await this.docx(row, pages, attachments)
              : await this.pdf(row, pages, attachments, signal);
      if (bytes.byteLength > this.maxBytes) throw this.tooLarge();

      await this.stage(row.id, 'packaging');
      const filename = exportFilename(row.title, format);
      const key = `${exportObjectPrefix(row.workspaceId, row.id)}${filename}`;
      await this.storage.putObjectBytes(key, bytes, EXPORT_CONTENT_TYPE[format]);

      const now = new Date();
      const done = await this.prisma.exportJob.updateMany({
        where: { id: row.id, status: 'running' },
        data: {
          status: 'completed',
          stage: null,
          s3Key: key,
          sizeBytes: bytes.byteLength,
          pageCount: pages.length,
          completedAt: now,
          expiresAt: new Date(now.getTime() + this.ttlMs),
        },
      });
      // The sweeper gave up on it while it ran: the file is not anyone's now.
      if (done.count === 0) {
        await this.storage.purgeObjectVersions(key).catch(() => undefined);
        return;
      }
      this.logger.log(`export ${row.id} completed: ${row.format}, ${pages.length} pages, ${bytes.byteLength} bytes`);
      await this.announce(row, 'export.completed');
    } catch (e) {
      const failure =
        e instanceof ExportFailure
          ? e
          : signal.aborted
            ? new ExportFailure('timedOut', t('error.export.timedOut'))
            : new ExportFailure('failed', t('error.export.failed', { detail: (e as Error).message }));
      this.logger.warn(`export ${row.id} failed (${failure.code}): ${failure.message}`);
      await this.prisma.exportJob
        .updateMany({
          where: { id: row.id, status: 'running' },
          data: {
            status: 'failed',
            stage: null,
            completedAt: new Date(),
            error: { code: failure.code, message: failure.message.slice(0, 1000) },
          },
        })
        .catch(() => undefined);
      await this.announce(row, 'export.failed');
      // Swallowed on purpose: the row carries the failure, and a retry would
      // reach the same one.
    }
  }

  /** The pages in reading order with their sources, and every ready attachment of theirs. */
  private async collect(row: ExportJob): Promise<{ pages: PackagedPage[]; attachments: CollectedAttachment[] }> {
    const documents = await this.scope.documents({
      workspaceId: row.workspaceId,
      scope: row.scope as ExportScope,
      documentId: row.documentId,
      projectId: row.projectId,
      // A share link's job holds what the link shows, not what its creator can open (#161).
      requester: row.shareLinkId ? { shareLinkId: row.shareLinkId } : { userId: row.requestedBy, locale: row.locale as Locale },
    });
    const revisions = await this.scope.revisions(
      documents.map((d) => d.id),
      row.branch,
    );
    const resolved = new Map<string, ResolvedRevision>(
      documents.map((d) => {
        const r = revisions.get(d.id);
        return [d.id, r ? { revisionId: r.revisionId, headIndexed: true } : { revisionId: null }];
      }),
    );
    // The site planner's walk, so an export's order, nesting and file names
    // are the ones a published site of the same pages would have.
    const plan = planSiteBuild({
      documents,
      revisions: resolved,
      rootDocumentId: null,
      reservedTopSegments: new Set(),
      maxPages: this.maxPages,
    });
    if (plan.warnings.some((w) => w.code === 'pageLimit')) {
      throw new ExportFailure('tooLarge', t('error.export.tooManyPages', { count: documents.length, max: this.maxPages }));
    }
    if (plan.pages.length === 0) throw new ExportFailure('failed', t('error.export.nothingToExport'));

    const documentIds = plan.pages.map((p) => p.documentId);
    const attachments = await this.prisma.attachment.findMany({
      where: { documentId: { in: documentIds }, status: 'ready' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, documentId: true, filename: true, contentType: true, sizeBytes: true, s3Key: true },
    });
    const revisionRows = await this.prisma.documentRevision.findMany({
      where: { id: { in: plan.pages.map((p) => p.revisionId) } },
      select: { id: true, s3Key: true },
    });
    // Attachments are what makes an export large; the sources are checked
    // with the finished file.
    if (attachments.reduce((n, a) => n + a.sizeBytes, 0) > this.maxBytes) throw this.tooLarge();

    const keyOf = new Map(revisionRows.map((r) => [r.id, r.s3Key]));
    const docOf = new Map(documents.map((d) => [d.id, d]));
    const sources = await mapLimit(plan.pages, READ_CONCURRENCY, (p) => this.storage.getObjectText(keyOf.get(p.revisionId)!));
    const pages = plan.pages.map((p, i): PackagedPage => {
      const source = sources[i];
      return {
        documentId: p.documentId,
        title: p.title,
        category: docOf.get(p.documentId)?.category ?? 'other',
        parentId: p.parentId,
        position: p.position,
        depth: p.depth,
        slugPath: p.slugPath,
        revisionId: p.revisionId,
        branch: revisions.get(p.documentId)!.branch,
        source,
        markdown: matter(source).content,
      };
    });
    return { pages, attachments };
  }

  private readAttachments(attachments: CollectedAttachment[]): Promise<Uint8Array[]> {
    return mapLimit(attachments, READ_CONCURRENCY, (a) => this.storage.getObjectBytes(a.s3Key));
  }

  /** Markdown sources with frontmatter, attachments and manifest.json — the shape an import can read back. */
  private async zip(row: ExportJob, pages: PackagedPage[], attachments: CollectedAttachment[]): Promise<Uint8Array> {
    await this.stage(row.id, 'packaging');
    const bytes = await this.readAttachments(attachments);
    const manifest = buildManifest({
      workspaceId: row.workspaceId,
      scope: row.scope as ExportScope,
      rootDocumentId: row.documentId,
      projectId: row.projectId,
      branch: row.branch,
      title: row.title,
      exportedAt: new Date(),
      pages,
      attachments,
    });
    const encoder = new TextEncoder();
    return zipArchive(archiveRoot(row.title), [
      { path: 'manifest.json', bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
      ...pages.map((p) => ({ path: pageSourcePath(p), bytes: encoder.encode(p.source) })),
      ...attachments.map((a, i) => ({ path: attachmentArchivePath(a), bytes: bytes[i] })),
    ]);
  }

  /** An offline site: index.html, one file per page, every attachment under assets/. */
  private async html(
    row: ExportJob,
    pages: PackagedPage[],
    attachments: CollectedAttachment[],
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const assets = Object.fromEntries(attachments.map((a) => [a.id, htmlAssetPath(a)]));
    const rendered = await this.render(row, 'html', pages, assets, signal);
    await this.stage(row.id, 'packaging');
    const bytes = await this.readAttachments(attachments);
    const encoder = new TextEncoder();
    return zipArchive(archiveRoot(row.title), [
      ...rendered.files.map((f) => ({ path: f.path, bytes: encoder.encode(f.content) })),
      ...attachments.map((a, i) => ({ path: htmlAssetPath(a), bytes: bytes[i] })),
    ]);
  }

  /**
   * One printed document. Only images go to Gotenberg: a PDF cannot link to a
   * file beside it, so other attachments are shown by name only.
   */
  private async pdf(
    row: ExportJob,
    pages: PackagedPage[],
    attachments: CollectedAttachment[],
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (!this.gotenberg.configured) throw new ExportFailure('formatUnavailable', t('error.export.formatUnavailable'));
    const images = attachments.filter((a) => a.contentType.startsWith('image/'));
    const assets = Object.fromEntries(images.map((a) => [a.id, pdfAssetName(a)]));
    const rendered = await this.render(row, 'pdf', pages, assets, signal);
    const bytes = await this.readAttachments(images);
    await this.stage(row.id, 'converting');
    const encoder = new TextEncoder();
    try {
      return await this.gotenberg.htmlToPdf(
        [
          ...rendered.files.map((f) => ({
            name: f.path,
            bytes: encoder.encode(f.content),
            contentType: TEXT_TYPES[f.path.slice(f.path.lastIndexOf('.'))] ?? 'text/plain',
          })),
          ...images.map((a, i) => ({ name: pdfAssetName(a), bytes: bytes[i], contentType: a.contentType })),
        ],
        signal,
      );
    } catch (e) {
      if (signal.aborted) throw e;
      throw new ExportFailure('convertFailed', t('error.export.convertFailed', { detail: (e as Error).message }));
    }
  }

  /**
   * One Word document, written here from the parser's tokens (export-docx.ts)
   * rather than by the web: the worker holds the image bytes it embeds, and
   * it needs no Gotenberg. Only images are read; other attachments are named.
   */
  private async docx(row: ExportJob, pages: PackagedPage[], attachments: CollectedAttachment[]): Promise<Uint8Array> {
    await this.stage(row.id, 'rendering');
    const images = attachments.filter((a) => a.contentType.startsWith('image/'));
    const bytes = await this.readAttachments(images);
    const locale = row.locale as Locale;
    const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date());
    try {
      return await writeDocx({
        title: row.title,
        pages: pages.map((p) => ({ documentId: p.documentId, title: p.title, depth: p.depth, markdown: p.markdown })),
        images: new Map(images.map((a, i) => [a.id, { bytes: bytes[i], filename: a.filename }])),
        labels: {
          contents: t('export.docx.contents'),
          meta: `${t('export.docx.exportedOn', { date })} · ${t('export.docx.pageCount', { count: pages.length })}`,
          onThisPage: t('export.docx.onThisPage'),
          noHeadings: t('export.docx.noHeadings'),
          diagramSource: t('export.docx.diagramSource'),
          drawing: t('export.docx.drawing'),
          // The writer fills the name in, per file.
          attachment: t('export.docx.attachment', { name: '{name}' }),
          panel: Object.fromEntries(PANEL_TYPES.map((k) => [k, t(`export.docx.panel.${k}`)])) as Record<PanelType, string>,
        },
      });
    } catch (e) {
      throw new ExportFailure('renderFailed', t('error.export.renderFailed', { detail: (e as Error).message }));
    }
  }

  private async render(
    row: ExportJob,
    format: ExportRenderRequest['format'],
    pages: PackagedPage[],
    assets: Record<string, string>,
    signal: AbortSignal,
  ) {
    await this.stage(row.id, 'rendering');
    try {
      return await this.renderer.render(
        {
          format,
          locale: row.locale as Locale,
          title: row.title,
          exportedAt: new Date().toISOString(),
          pages: pages.map((p) => ({
            documentId: p.documentId,
            title: p.title,
            depth: p.depth,
            path: pageHtmlPath(p),
            markdown: p.markdown,
          })),
          assets,
        },
        signal,
      );
    } catch (e) {
      if (signal.aborted) throw e;
      throw new ExportFailure('renderFailed', t('error.export.renderFailed', { detail: (e as Error).message }));
    }
  }

  private tooLarge(): ExportFailure {
    return new ExportFailure('tooLarge', t('error.export.tooLarge', { max: `${Math.round(this.maxBytes / 1_048_576)} MB` }));
  }

  private async stage(id: string, stage: ExportStage): Promise<void> {
    await this.prisma.exportJob.updateMany({ where: { id, status: 'running' }, data: { stage } }).catch(() => undefined);
  }

  /**
   * To the person who asked, and only them: who exported what is not the
   * workspace's news. A share link's reader has no inbox, and the link's
   * creator did not ask, so their job says nothing — the reader polls (#161).
   */
  private async announce(row: ExportJob, type: 'export.completed' | 'export.failed'): Promise<void> {
    if (row.shareLinkId) return;
    await this.events.publish({ workspaceId: row.workspaceId, userId: row.requestedBy, type, subjectId: row.id, title: row.title });
  }
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
