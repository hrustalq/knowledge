import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExportJob } from '@prisma/client';
import {
  EXPORT_FORMATS,
  slugifyPath,
  type ExportCapabilitiesResponse,
  type ExportDownloadResponse,
  type ExportErrorCode,
  type ExportFormat,
  type ExportJobSummary,
  type ExportListResponse,
  type ExportScope,
  type ExportStage,
  type ExportStatus,
} from '@knowledge/contracts';
import { AccessService } from '../auth/access.service.js';
import type { Principal } from '../auth/principal.js';
import type { Env } from '../config/env.js';
import { currentLocale } from '../i18n/locale.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ExportProducer } from './export.producer.js';
import { ExportScopeService } from './export-scope.service.js';

export interface CreateExportInput {
  format: ExportFormat;
  /** Null = each page's default branch. */
  branch?: string | null;
}

/** Rows one list returns; the exports page is a recent-history view, not an archive. */
const LIST_LIMIT = 100;

/** The extension a finished export downloads with. An HTML bundle is a folder, so it travels zipped. */
const EXTENSION: Record<ExportFormat, string> = { zip: '.zip', html: '.zip', pdf: '.pdf', docx: '.docx' };
export const EXPORT_CONTENT_TYPE: Record<ExportFormat, string> = {
  zip: 'application/zip',
  html: 'application/zip',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * Exports, API side (docs/features/45): asking for one, listing them and
 * handing the file back. Controller-free so the MCP server's
 * `knowledge_export` / `knowledge_get_export` call the same code as the REST
 * routes; the building is ExportBuildService's, in the worker.
 *
 * Reading is enough to export: a viewer can already read every page an export
 * would hold. Seeing an export is narrower — the person who asked, or an
 * admin — because the row says who exported what.
 */
@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly maxPages: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly storage: StorageService,
    private readonly scope: ExportScopeService,
    private readonly producer: ExportProducer,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.maxPages = config.get('EXPORT_MAX_PAGES', { infer: true });
  }

  capabilities(): ExportCapabilitiesResponse {
    const formats = Object.fromEntries(EXPORT_FORMATS.map((f) => [f, this.formatAvailable(f)])) as Record<ExportFormat, boolean>;
    return { formats, maxPages: this.maxPages, ttlHours: this.config.get('EXPORT_TTL_HOURS', { infer: true }) };
  }

  /** A page, or a page and every page under it. */
  async createForDocument(
    documentId: string,
    input: CreateExportInput & { includeSubtree?: boolean },
    principal: Principal,
  ): Promise<ExportJobSummary> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { workspaceId: true, title: true, archivedAt: true },
    });
    if (!doc) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    return this.create(principal, {
      workspaceId: doc.workspaceId,
      scope: input.includeSubtree ? 'subtree' : 'page',
      documentId,
      projectId: null,
      title: doc.title,
      archived: !!doc.archivedAt,
      ...input,
    });
  }

  /** Every live page of a project, in tree order. */
  async createForProject(projectId: string, input: CreateExportInput, principal: Principal): Promise<ExportJobSummary> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true, name: true } });
    if (!project) throw new NotFoundException(t('error.project.notFound', { id: projectId }));
    return this.create(principal, {
      workspaceId: project.workspaceId,
      scope: 'project',
      documentId: null,
      projectId,
      title: project.name,
      archived: false,
      ...input,
    });
  }

  private async create(
    principal: Principal,
    req: CreateExportInput & {
      workspaceId: string;
      scope: ExportScope;
      documentId: string | null;
      projectId: string | null;
      title: string;
      archived: boolean;
    },
  ): Promise<ExportJobSummary> {
    if (!this.formatAvailable(req.format)) {
      throw new ConflictException({ statusCode: 409, message: t('error.export.formatUnavailable'), reason: 'export.formatUnavailable' });
    }
    // Checked before anything is queued, so a person learns now rather than
    // from a failed row; the worker checks again against what it finds.
    const count = req.archived ? 0 : (await this.scope.documents({ ...req, requester: principal })).length;
    if (count === 0) {
      throw new BadRequestException({ statusCode: 400, message: t('error.export.nothingToExport'), reason: 'export.nothingToExport' });
    }
    if (count > this.maxPages) {
      throw new BadRequestException({
        statusCode: 400,
        message: t('error.export.tooManyPages', { count, max: this.maxPages }),
        reason: 'export.tooManyPages',
        count,
        max: this.maxPages,
      });
    }

    const branch = req.branch?.trim() || null;
    const row = await this.prisma.exportJob.create({
      data: {
        workspaceId: req.workspaceId,
        scope: req.scope,
        documentId: req.documentId,
        projectId: req.projectId,
        branch,
        format: req.format,
        title: req.title.slice(0, 300),
        locale: currentLocale(),
        requestedBy: principal.userId,
      },
    });
    try {
      await this.producer.enqueue(row.id);
    } catch (e) {
      // The row is the truth: a queue that refused the job leaves a failed
      // row the person can see and retry, never a `queued` one forever.
      this.logger.warn(`Export ${row.id} could not be queued: ${(e as Error).message}`);
      const failed = await this.prisma.exportJob.update({
        where: { id: row.id },
        data: { status: 'failed', error: { code: 'failed', message: t('error.export.failed', { detail: 'queue unavailable' }) } },
      });
      return toExportSummary(failed);
    }
    return toExportSummary(row);
  }

  /** The caller's own exports, newest first; an admin sees everyone's. */
  async list(workspaceId: string, principal: Principal): Promise<ExportListResponse> {
    const all = await this.isAdmin(principal, workspaceId);
    const rows = await this.prisma.exportJob.findMany({
      where: { workspaceId, ...(all ? {} : { requestedBy: principal.userId }) },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    return { exports: rows.map(toExportSummary) };
  }

  async get(id: string, principal: Principal): Promise<ExportJobSummary> {
    return toExportSummary(await this.visible(id, principal));
  }

  /** A short-lived URL to the file; 409 while it is being made, 410 once it is gone. */
  async download(id: string, principal: Principal): Promise<ExportDownloadResponse> {
    const row = await this.visible(id, principal);
    if (row.status === 'expired' || (row.status === 'completed' && row.expiresAt && row.expiresAt <= new Date())) {
      throw new GoneException({ statusCode: 410, message: t('error.export.expired'), reason: 'export.expired' });
    }
    if (row.status !== 'completed' || !row.s3Key) {
      throw new ConflictException({ statusCode: 409, message: t('error.export.notReady'), reason: 'export.notReady' });
    }
    const filename = exportFilename(row.title, row.format as ExportFormat);
    const url = await this.storage.presignGet(row.s3Key, {
      filename,
      contentType: EXPORT_CONTENT_TYPE[row.format as ExportFormat] ?? 'application/octet-stream',
      disposition: 'attachment',
      expiresInSeconds: 300,
    });
    return { url, filename };
  }

  private formatAvailable(format: ExportFormat): boolean {
    return format !== 'pdf' || this.config.get('GOTENBERG_URL', { infer: true }).trim() !== '';
  }

  /** The row, if the caller asked for it or is an admin. The guard already checked the workspace. */
  private async visible(id: string, principal: Principal): Promise<ExportJob> {
    const row = await this.prisma.exportJob.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(t('error.export.notFound'));
    if (row.requestedBy !== principal.userId && !(await this.isAdmin(principal, row.workspaceId))) {
      throw new ForbiddenException(t('error.export.notYours'));
    }
    return row;
  }

  private async isAdmin(principal: Principal, workspaceId: string): Promise<boolean> {
    try {
      await this.access.requireRole(principal, workspaceId, 'admin');
      return true;
    } catch {
      return false;
    }
  }
}

/** `install-guide.pdf`; a title with nothing slugifiable in it is `export`. */
export function exportFilename(title: string, format: ExportFormat): string {
  const base = slugifyPath(title).replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'export';
  return `${base}${format === 'html' ? '-html' : ''}${EXTENSION[format]}`;
}

export function toExportSummary(row: ExportJob): ExportJobSummary {
  const error = row.error as { code?: string; message?: string } | null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    scope: row.scope as ExportScope,
    format: row.format as ExportFormat,
    documentId: row.documentId,
    projectId: row.projectId,
    branch: row.branch,
    title: row.title,
    status: row.status as ExportStatus,
    stage: (row.stage as ExportStage | null) ?? null,
    pageCount: row.pageCount,
    sizeBytes: row.sizeBytes,
    error: error ? { code: (error.code ?? 'failed') as ExportErrorCode, message: error.message ?? '' } : null,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}
