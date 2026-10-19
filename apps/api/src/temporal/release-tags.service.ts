import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ReleaseTag } from '@prisma/client';
import type { GraphTimelineResponse, ReleaseTagDto } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { GraphService } from '../graph/graph.service.js';
import { factChangeDays } from '../graph/temporal.js';
import { visibilityWhere, type AccessScope } from '../permissions/access-scope.js';
import { PermissionService } from '../permissions/permission.service.js';
import { t } from '../i18n/t.js';

const DAY = 86_400_000;
/** The timeline's default window when `from` is absent. */
const DEFAULT_WINDOW_DAYS = 90;

/** Release tags (#81): named instants on the graph's valid-time axis, and the timeline they mark. */
@Injectable()
export class ReleaseTagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    private readonly permissions: PermissionService,
  ) {}

  /** Workspace-wide tags plus, with a project, that project's; every tag without one. */
  async list(workspaceId: string, projectId?: string): Promise<ReleaseTagDto[]> {
    const rows = await this.prisma.releaseTag.findMany({
      where: { workspaceId, ...(projectId ? { OR: [{ projectId: null }, { projectId }] } : {}) },
      orderBy: { at: 'asc' },
    });
    return rows.map(toDto);
  }

  async create(
    input: { workspaceId: string; projectId?: string; name: string; at?: string; note?: string },
    actor: string,
  ): Promise<ReleaseTagDto> {
    if (input.projectId) {
      const project = await this.prisma.project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId }, select: { id: true } });
      if (!project) throw new BadRequestException(t('error.project.notInWorkspace', { id: input.projectId }));
    }
    try {
      const row = await this.prisma.releaseTag.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId ?? null,
          name: input.name,
          at: input.at ? new Date(input.at) : new Date(),
          note: input.note ?? null,
          createdBy: actor,
        },
      });
      return toDto(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ statusCode: 409, message: t('error.releaseTag.duplicate', { name: input.name }), reason: 'release-tag-duplicate', name: input.name });
      }
      throw e;
    }
  }

  async delete(id: string): Promise<void> {
    const { count } = await this.prisma.releaseTag.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException(t('error.releaseTag.notFound', { id }));
  }

  /**
   * The slider's markers: tags in the window and per-day fact changes,
   * counted per request from the edges themselves — no stored aggregate.
   * Under the caller's scope, and with a project, its pages only.
   */
  async timeline(scope: AccessScope, opts: { projectId?: string; from?: string; to?: string }): Promise<GraphTimelineResponse> {
    const to = opts.to ? Date.parse(opts.to) : Date.now();
    const from = opts.from ? Date.parse(opts.from) : to - DEFAULT_WINDOW_DAYS * DAY;
    if (Number.isNaN(from) || Number.isNaN(to) || from >= to) {
      throw new BadRequestException(t('error.temporal.badWindow'));
    }
    let rows = await this.graph.factIntervals(scope.workspaceId, await this.permissions.documentFilterFor(scope), from, to);
    if (opts.projectId) {
      const docs = await this.prisma.document.findMany({
        where: { workspaceId: scope.workspaceId, projectId: opts.projectId, AND: [visibilityWhere(scope)] },
        select: { id: true },
      });
      const inProject = new Set(docs.map((d) => d.id));
      rows = rows.filter((r) => inProject.has(r.documentId));
    }
    const tags = (await this.list(scope.workspaceId, opts.projectId)).filter((tag) => {
      const at = Date.parse(tag.at);
      return at >= from && at < to;
    });
    return {
      workspaceId: scope.workspaceId,
      projectId: opts.projectId ?? null,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      tags,
      days: factChangeDays(rows, from, to),
    };
  }
}

function toDto(row: ReleaseTag): ReleaseTagDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    name: row.name,
    at: row.at.toISOString(),
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}
