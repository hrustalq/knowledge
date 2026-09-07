import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateProjectResponse,
  ListProjectsResponse,
  ProjectSummary,
} from '@knowledge/contracts';
import type { Project } from '@prisma/client';
import { ActivityService } from '../activity/activity.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateProjectDto, UpdateProjectDto } from './projects.dto.js';

/**
 * Projects are the organizational layer between a workspace and its documents
 * (Workspace > Project > Document). They carry no ACLs of their own — role
 * checks happen in AclGuard via @Access(role, 'project' | 'body' | 'query').
 * What lives here are the invariants ACLs cannot express: a project holding
 * documents cannot be deleted, and a workspace always keeps at least one
 * project so there is somewhere to put a page.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  async list(workspaceId: string): Promise<ListProjectsResponse> {
    const projects = await this.prisma.project.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { documents: true } } },
    });
    return { projects: projects.map((p) => toSummary(p, p._count.documents)) };
  }

  async get(projectId: string): Promise<ProjectSummary> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { _count: { select: { documents: true } } },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return toSummary(project, project._count.documents);
  }

  async create(dto: CreateProjectDto, actorId?: string): Promise<CreateProjectResponse> {
    const project = await this.prisma.project.create({
      data: {
        workspaceId: dto.workspaceId,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
      },
    });
    await this.activity.record({
      workspaceId: project.workspaceId,
      actor: actorId,
      action: 'project.created',
      subjectId: project.id,
      metadata: { name: project.name },
    });
    return { project: toSummary(project, 0) };
  }

  async update(projectId: string, dto: UpdateProjectDto, actorId?: string): Promise<ProjectSummary> {
    const project = await this.requireProject(projectId);

    const data: { name?: string; description?: string | null } = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (Object.keys(data).length === 0) throw new BadRequestException('Nothing to update');

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data,
      include: { _count: { select: { documents: true } } },
    });
    await this.activity.record({
      workspaceId: project.workspaceId,
      actor: actorId,
      action: 'project.updated',
      subjectId: projectId,
      metadata: { name: updated.name, changes: Object.keys(data) },
      patch: data,
    });
    return toSummary(updated, updated._count.documents);
  }

  async remove(projectId: string, actorId?: string): Promise<{ deleted: true }> {
    const project = await this.requireProject(projectId);

    const documentCount = await this.prisma.document.count({ where: { projectId } });
    if (documentCount > 0) {
      throw new ConflictException({
        statusCode: 409,
        message: `Project still holds ${documentCount} document(s) — move or delete them first`,
        reason: 'not-empty',
        documentCount,
      });
    }
    const siblings = await this.prisma.project.count({
      where: { workspaceId: project.workspaceId, id: { not: projectId } },
    });
    if (siblings === 0) {
      throw new BadRequestException('Cannot delete the last project of the workspace');
    }

    await this.prisma.project.delete({ where: { id: projectId } });
    await this.activity.record({
      workspaceId: project.workspaceId,
      actor: actorId,
      action: 'project.deleted',
      subjectId: projectId,
      metadata: { name: project.name },
    });
    return { deleted: true };
  }

  /**
   * Shared guard for the documents module: a document's project must exist and
   * live in the same workspace, otherwise a project id from another tenant
   * would silently re-parent the page.
   */
  async requireProjectInWorkspace(projectId: string, workspaceId: string): Promise<Project> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.workspaceId !== workspaceId) {
      throw new BadRequestException(`Project ${projectId} not found in this workspace`);
    }
    return project;
  }

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return project;
  }
}

function toSummary(project: Project, documentCount: number): ProjectSummary {
  return {
    projectId: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    description: project.description,
    documentCount,
    createdAt: project.createdAt.toISOString(),
  };
}
