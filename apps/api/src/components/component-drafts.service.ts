import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  COMPONENT_DRAFT_MAX_PATHS,
  type AgentFinding,
  type AgentRunInput,
  type DraftComponentRequest,
  type DraftComponentResponse,
} from '@knowledge/contracts';
import { AgentProducer } from '../agents/agent.producer.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import type { Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';
import { visibilityWhere } from '../permissions/access-scope.js';
import { PermissionService } from '../permissions/permission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { componentNameFor, draftablePath, resolveDeclaration } from './component-match.js';
import { ComponentsService } from './components.service.js';

/** The agent that drafts a component page: the one that already reads code to propose pages (docs/features/31). */
export const COMPONENT_DRAFT_AGENT_KEY = 'archaeologist';
/** Component drafts one workspace may have queued at once — each is a model run somebody pays for. */
const MAX_PENDING_DRAFTS = 5;
/** `ComponentDraftSweeper`'s window: a finished run older than this is never opened, so it blocks nothing. */
export const COMPONENT_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * "Document this component" (#236, phase 5): the request half.
 *
 * Everything that can be told to the person pressing the button is settled
 * here — which repository, which files, what the page is called, where it
 * goes, whether a page or a draft already exists — and the run is queued with
 * the answer frozen in `input.component`. The worker drafts; `ComponentDraftSweeper`
 * opens the merge request. Controller-free, so the MCP tool shares it.
 *
 * Duplicates are refused rather than drafted twice: a page that already
 * declares one of the files (one the caller can open — a hidden one is not
 * named), a run still drafting the same files, or a draft of them still open
 * as a merge request. All three are keyed on `subjectKey`, the in-flight key
 * every agent run has.
 */
@Injectable()
export class ComponentDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AgentRegistryService,
    private readonly usage: AiUsageService,
    private readonly producer: AgentProducer,
    private readonly components: ComponentsService,
    private readonly permissions: PermissionService,
  ) {}

  async start(principal: Principal, request: DraftComponentRequest): Promise<DraftComponentResponse> {
    const workspaceId = request.workspaceId;
    const paths = this.paths(request.paths);
    const connectorId = await this.connector(workspaceId, request.connectorId);
    const symbols = [...new Set((request.symbols ?? []).map((s) => s.trim()).filter(Boolean))];
    const name = request.name?.trim() || componentNameFor(paths[0]);

    const scope = await this.permissions.scopeFor(principal, workspaceId);
    const place = await this.place(workspaceId, request, visibilityWhere(scope));

    const documented = await this.prisma.componentDeclaration.findMany({
      where: { workspaceId, connectorId, paths: { hasSome: paths }, document: { archivedAt: null, ...visibilityWhere(scope) } },
      select: { documentId: true, paths: true },
      take: 5,
    });
    if (documented.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.component.draftDocumented', { path: paths.find((p) => documented.some((d) => d.paths.includes(p))) }),
        reason: 'already-documented',
        documentIds: documented.map((d) => d.documentId),
      });
    }

    const subjectKey = `component:${connectorId}:${[...paths].sort().join(',')}`;
    await this.refuseDuplicate(workspaceId, subjectKey);

    const agent = await this.registry.resolve(workspaceId, COMPONENT_DRAFT_AGENT_KEY);
    if (!agent.enabled || !agent.config.enabled || agent.missing.some((c) => c !== 'tools')) {
      throw new BadRequestException(t('error.component.draftNoModel'));
    }
    await this.usage.assertWithinBudget(workspaceId, principal.userId);
    const pending = await this.prisma.agentRun.count({
      where: { workspaceId, agentKey: COMPONENT_DRAFT_AGENT_KEY, status: 'pending', subjectKey: { startsWith: 'component:' } },
    });
    if (pending >= MAX_PENDING_DRAFTS) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.component.draftQueueFull', { n: pending }),
        reason: 'queue-full',
      });
    }

    const override = await this.prisma.aiAgent.findUnique({
      where: { workspaceId_key: { workspaceId, key: COMPONENT_DRAFT_AGENT_KEY } },
      select: { id: true },
    });
    const input: AgentRunInput = {
      connectorId,
      component: { name, paths, ...(symbols.length ? { symbols } : {}), ...place },
    };
    const run = await this.prisma.agentRun.create({
      data: {
        workspaceId,
        agentKey: COMPONENT_DRAFT_AGENT_KEY,
        agentId: override?.id ?? null,
        trigger: 'manual',
        subjectKey,
        createdBy: principal.userId,
        locale: principal.locale,
        input: input as unknown as Prisma.InputJsonValue,
      },
    });
    await this.producer.enqueue(run.id);
    return { runId: run.id, connectorId, title: name, paths };
  }

  private paths(raw: string[]): string[] {
    const paths: string[] = [];
    for (const value of raw) {
      const path = draftablePath(value);
      if (!path) throw new BadRequestException(t('error.component.draftPath', { path: value }));
      if (!paths.includes(path)) paths.push(path);
    }
    if (paths.length === 0) throw new BadRequestException(t('error.component.draftPath', { path: '' }));
    if (paths.length > COMPONENT_DRAFT_MAX_PATHS) {
      throw new BadRequestException(t('error.component.draftTooMany', { max: COMPONENT_DRAFT_MAX_PATHS }));
    }
    return paths;
  }

  /** The codebase connector named, or the workspace's only one — the rule a declaration's `repository` follows. */
  private async connector(workspaceId: string, requested?: string): Promise<string> {
    const connectors = await this.components.codeConnectors(workspaceId);
    if (requested) {
      if (!connectors.some((c) => c.id === requested)) {
        throw new BadRequestException(t('error.component.draftConnector', { id: requested }));
      }
      return requested;
    }
    const { connectorId, warning } = resolveDeclaration({ repository: null, paths: ['-'] }, connectors);
    if (connectorId) return connectorId;
    throw new BadRequestException(
      t(warning === 'no-connector' ? 'error.component.draftNoConnector' : 'error.component.draftAmbiguous'),
    );
  }

  /**
   * Where the page goes once merged. Checked now, while somebody can be told:
   * a project of this workspace, and a parent the caller can open in it.
   * Neither given, the sweeper uses the connector's destination.
   */
  private async place(
    workspaceId: string,
    request: DraftComponentRequest,
    visible: Prisma.DocumentWhereInput,
  ): Promise<{ projectId?: string; parentId?: string }> {
    let projectId = request.projectId;
    if (request.parentId) {
      const parent = await this.prisma.document.findFirst({
        where: { id: request.parentId, workspaceId, ...visible, ...(projectId ? { projectId } : {}) },
        select: { projectId: true },
      });
      if (!parent) throw new BadRequestException(t('error.component.draftPlace'));
      projectId = parent.projectId;
    } else if (projectId) {
      const project = await this.prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { id: true } });
      if (!project) throw new BadRequestException(t('error.component.draftPlace'));
    }
    return { ...(projectId ? { projectId } : {}), ...(request.parentId ? { parentId: request.parentId } : {}) };
  }

  /**
   * A run of the same files still drafting, finished but not yet opened, or
   * opened and still waiting for review: each is the answer a second press
   * would produce again.
   */
  private async refuseDuplicate(workspaceId: string, subjectKey: string): Promise<void> {
    const prior = await this.prisma.agentRun.findMany({
      where: { workspaceId, agentKey: COMPONENT_DRAFT_AGENT_KEY, subjectKey, status: { in: ['pending', 'running', 'succeeded'] } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, status: true, input: true, findings: true, finishedAt: true },
    });
    const stale = Date.now() - COMPONENT_DRAFT_MAX_AGE_MS;
    for (const run of prior) {
      const published = !!(run.input as AgentRunInput | null)?.publishedAt;
      if (run.status === 'succeeded' && !published && (run.finishedAt?.getTime() ?? 0) < stale) continue;
      if (run.status !== 'succeeded' || !published) {
        throw new ConflictException({
          statusCode: 409,
          message: t('error.component.draftInFlight'),
          reason: 'in-flight',
          runId: run.id,
        });
      }
      const mergeRequestId = ((run.findings ?? []) as unknown as AgentFinding[]).find((f) => f.mergeRequestId)?.mergeRequestId;
      if (!mergeRequestId) continue;
      const open = await this.prisma.mergeRequest.count({ where: { id: mergeRequestId, status: 'open' } });
      if (open > 0) {
        throw new ConflictException({
          statusCode: 409,
          message: t('error.component.draftProposed'),
          reason: 'already-proposed',
          mergeRequestId,
        });
      }
    }
  }
}
