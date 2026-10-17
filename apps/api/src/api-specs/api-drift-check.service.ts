import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isApiSpecKind, type AgentRunInput, type ApiDriftCheckResponse } from '@knowledge/contracts';
import { AgentProducer } from '../agents/agent.producer.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import type { Principal } from '../auth/principal.js';
import { REPO_CONNECTOR_KINDS } from '../connectors/code-research/repo-snapshot.service.js';
import { specPathOfLink } from '../connectors/adapters/repo-specs.js';
import { DRIFT_AGENT_KEY } from '../connectors/drift/drift-trigger.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * "Check against the code" for one spec (#78, phase 8): the request half of
 * the on-demand drift check. The sentinel compares the spec with its
 * repository's routes in the worker; the answer is that run's findings.
 *
 * Settled here, where the person pressing the button can be told: the
 * document is an OpenAPI spec, a connected repository syncs it, and the
 * sentinel is on. No model is required — the comparison is static analysis —
 * so no budget is asked for. A check of the same spec still waiting or
 * running is returned rather than queued twice.
 */
@Injectable()
export class ApiDriftCheckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AgentRegistryService,
    private readonly producer: AgentProducer,
  ) {}

  async start(principal: Principal, documentId: string): Promise<ApiDriftCheckResponse> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, workspaceId: true, kind: true },
    });
    if (!doc) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    if (!isApiSpecKind(doc.kind)) throw new BadRequestException(t('error.apiSpec.notSpec', { id: documentId }));
    if (doc.kind !== 'openapi') throw new BadRequestException(t('error.apiSpec.driftNotHttp'));

    const links = await this.prisma.connectorLink.findMany({
      where: { documentId, connector: { workspaceId: doc.workspaceId, enabled: true, kind: { in: [...REPO_CONNECTOR_KINDS] } } },
      select: { externalId: true, connector: { select: { id: true, kind: true } } },
    });
    const connectorId = links.find((l) => specPathOfLink(l.connector.kind, l.externalId))?.connector.id;
    if (!connectorId) throw new BadRequestException(t('error.apiSpec.driftNoRepository'));

    const agent = await this.registry.resolve(doc.workspaceId, DRIFT_AGENT_KEY);
    if (!agent.enabled) throw new BadRequestException(t('error.apiSpec.driftDisabled'));

    const subjectKey = `api-drift:${documentId}`;
    const waiting = await this.prisma.agentRun.findFirst({
      where: { workspaceId: doc.workspaceId, agentKey: DRIFT_AGENT_KEY, subjectKey, status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    if (waiting) return { runId: waiting.id, existing: true };

    const override = await this.prisma.aiAgent.findUnique({
      where: { workspaceId_key: { workspaceId: doc.workspaceId, key: DRIFT_AGENT_KEY } },
      select: { id: true },
    });
    const input: AgentRunInput = { connectorId, apiSpecDocumentId: documentId };
    const run = await this.prisma.agentRun.create({
      data: {
        workspaceId: doc.workspaceId,
        agentKey: DRIFT_AGENT_KEY,
        agentId: override?.id ?? null,
        trigger: 'manual',
        subjectKey,
        createdBy: principal.userId,
        locale: principal.locale,
        input: input as unknown as Prisma.InputJsonValue,
      },
    });
    await this.producer.enqueue(run.id);
    return { runId: run.id, existing: false };
  }
}
