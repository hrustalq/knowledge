import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { headingSections } from '@knowledge/editor-schema/markdown';
import { isApiSpecKind, operationAnchor, type AgentRunInput } from '@knowledge/contracts';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AgentProducer } from '../agents/agent.producer.js';
import { UNFILTERED } from '../common/document-acl.js';
import { GraphService } from '../graph/graph.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { VerificationService } from '../verification/verification.service.js';

/** The system's own actor id, used when a connector's owner was deleted. */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';
/** Changes named in one dependent's note; the rest is "…". */
const MAX_NOTE_ITEMS = 10;
/** The agent that judges the linking pages (phase 5b). */
const JUDGE_AGENT_KEY = 'sentinel';
/** Waiting source checks one workspace may hold — the drift trigger's cap, for its reason. */
const MAX_PENDING = 20;

export interface Anchor {
  id: string;
  /** The section's text, or null where there is none to compare (a spec operation). */
  body: string | null;
}

/**
 * The anchors of `before` that `after` no longer has. One whose section text
 * reappears unchanged under a new id was renamed, and maps to that id; the
 * rest were removed.
 */
export function anchorChanges(before: Anchor[], after: Anchor[]): Map<string, string | null> {
  const kept = new Set(after.map((a) => a.id));
  const added = after.filter((a) => !before.some((b) => b.id === a.id));
  const out = new Map<string, string | null>();
  for (const old of before) {
    if (kept.has(old.id)) continue;
    const to = old.body ? added.find((a) => a.body === old.body) : undefined;
    if (to) added.splice(added.indexOf(to), 1);
    out.set(old.id, to?.id ?? null);
  }
  return out;
}

/**
 * The deterministic half of a source-backed page's misalignment check (#674,
 * phase 5): once a new version of the page is indexed, the pages that relied
 * on something it no longer has are flagged `requested`, with no model call.
 *
 * - **Anchors.** A page linking `#section` of it (the page link index) when
 *   the new version removed or renamed that section. On a spec page the
 *   anchors are its operations' (`operationAnchor`).
 * - **Entity keys.** A page with a live edge to a key the new version's
 *   deterministic facts (frontmatter, spec) no longer name — a removed
 *   operation's `op:` key among them.
 *
 * Runs in the worker, after the revision is indexed (the new facts exist only
 * then). A page already flagged is left alone — its owner is already asked —
 * and so is another source-backed page, which no person can correct.
 *
 * Then (phase 5b) it queues the sentinel to judge the linking pages the pass
 * did not flag, against what changed (`checkSourceChange` in the executor).
 * No run when the sentinel has no model or the connector no owner: the
 * deterministic flags are the floor. A run still pending absorbs a newer
 * version — the drift trigger's coalescing rule.
 */
@Injectable()
export class SourceDependentsService {
  private readonly logger = new Logger(SourceDependentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly graph: GraphService,
    private readonly verification: VerificationService,
    private readonly registry: AgentRegistryService,
    private readonly producer: AgentProducer,
  ) {}

  /** Returns how many pages were flagged. */
  async revisionIndexed(revisionId: string): Promise<number> {
    const revision = await this.prisma.documentRevision.findUnique({
      where: { id: revisionId },
      include: { document: { select: { id: true, workspaceId: true, title: true, kind: true } } },
    });
    if (!revision) return 0;
    const { document } = revision;
    const link = await this.prisma.connectorLink.findFirst({
      where: { documentId: document.id, connector: { kind: 'web' } },
      select: { connector: { select: { createdBy: true, locale: true } } },
    });
    if (!link) return 0;
    const previous = await this.prisma.documentRevision.findFirst({
      where: { documentId: document.id, branchId: revision.branchId, revisionNumber: { lt: revision.revisionNumber }, status: 'indexed' },
      orderBy: { revisionNumber: 'desc' },
    });
    if (!previous) return 0;

    const flagged = await this.flagDropped(document, previous, revision, link.connector.createdBy ?? AUTHOR_ID_STUB);
    // After the flags, so the run skips the pages they already asked about.
    await this.requestJudge(document, link.connector, previous.id, revision.id).catch((err: unknown) =>
      this.logger.warn({ msg: 'Source change check could not be queued', documentId: document.id, err }),
    );
    return flagged;
  }

  private async flagDropped(
    document: { id: string; workspaceId: string; title: string; kind: string },
    previous: { id: string; s3Key: string },
    revision: { id: string; s3Key: string },
    actorId: string,
  ): Promise<number> {
    const spec = isApiSpecKind(document.kind);
    const [before, after, keysBefore, keysAfter] = await Promise.all([
      spec ? this.operationAnchors(previous.id) : this.headingAnchors(previous.s3Key),
      spec ? this.operationAnchors(revision.id) : this.headingAnchors(revision.s3Key),
      this.graph.revisionEntityKeys(document.workspaceId, document.id, previous.id),
      this.graph.revisionEntityKeys(document.workspaceId, document.id, revision.id),
    ]);
    const anchors = anchorChanges(before, after);
    const dropped = [...keysBefore].filter((k) => !keysAfter.has(k));
    if (anchors.size === 0 && dropped.length === 0) return 0;

    // What each dependent relied on that is gone.
    const changes = new Map<string, string[]>();
    const add = (id: string, item: string) => changes.set(id, [...(changes.get(id) ?? []), item]);
    if (anchors.size > 0) {
      const linking = await this.prisma.pageLink.findMany({
        where: { workspaceId: document.workspaceId, targetDocumentId: document.id, targetAnchor: { in: [...anchors.keys()] } },
        select: { sourceDocumentId: true, targetAnchor: true },
      });
      for (const l of linking) {
        const to = anchors.get(l.targetAnchor!);
        add(l.sourceDocumentId, to ? t('connector.sourceChange.anchorRenamed', { from: l.targetAnchor!, to }) : t('connector.sourceChange.anchorRemoved', { anchor: l.targetAnchor! }));
      }
    }
    // A system act over the workspace: the flag is the connector's, whoever may open the page.
    for (const [id, keys] of await this.graph.documentsNamingKeys(document.workspaceId, dropped, UNFILTERED)) {
      for (const key of keys) add(id, t('connector.sourceChange.keyDropped', { key }));
    }
    changes.delete(document.id);
    if (changes.size === 0) return 0;

    const [pages, sourced] = await Promise.all([
      this.prisma.document.findMany({
        where: { id: { in: [...changes.keys()] }, workspaceId: document.workspaceId, archivedAt: null, verificationFlag: null },
        select: { id: true },
      }),
      this.prisma.connectorLink.findMany({
        where: { documentId: { in: [...changes.keys()] }, connector: { kind: 'web' } },
        select: { documentId: true },
      }),
    ]);
    const skip = new Set(sourced.map((l) => l.documentId));
    let flagged = 0;
    for (const { id } of pages) {
      if (skip.has(id)) continue;
      const items = changes.get(id)!;
      const shown = items.slice(0, MAX_NOTE_ITEMS);
      if (items.length > shown.length) shown.push('…');
      const note = t('connector.sourceChangedNote', { title: document.title, changes: shown.join('; ') });
      await this.verification
        .flag(id, 'requested', { actorId, note, source: { kind: 'source', by: actorId }, keepOutdated: true })
        .then(() => flagged++)
        .catch((err: unknown) => this.logger.warn({ msg: 'Dependent page could not be flagged', documentId: id, err }));
    }
    return flagged;
  }

  /** The sentinel run that will judge the linking pages, or null when none was queued. */
  async requestJudge(
    document: { id: string; workspaceId: string },
    connector: { createdBy: string | null; locale: string },
    fromRevisionId: string,
    toRevisionId: string,
  ): Promise<string | null> {
    // A run acts as a person; a connector nobody owns gets no model calls (feature 27).
    if (!connector.createdBy) return null;
    const agent = await this.registry.resolve(document.workspaceId, JUDGE_AGENT_KEY);
    // 'tools' is a preference, not a prerequisite — the sentinel's own rule.
    if (!agent.enabled || !agent.config.enabled || agent.missing.some((c) => c !== 'tools')) return null;
    const linked = await this.prisma.pageLink.count({
      where: { workspaceId: document.workspaceId, targetDocumentId: document.id, sourceDocumentId: { not: document.id } },
    });
    if (linked === 0) return null;

    const waiting = await this.prisma.agentRun.findFirst({
      where: { workspaceId: document.workspaceId, agentKey: JUDGE_AGENT_KEY, status: 'pending', input: { path: ['sourceChange', 'documentId'], equals: document.id } },
      orderBy: { createdAt: 'desc' },
    });
    if (waiting) {
      const input = (waiting.input ?? {}) as AgentRunInput;
      // Guarded on still pending: a run the worker claimed has frozen its input.
      const absorbed = await this.prisma.agentRun.updateMany({
        where: { id: waiting.id, status: 'pending' },
        data: { input: { ...input, sourceChange: { ...input.sourceChange!, toRevisionId } } as unknown as Prisma.InputJsonValue },
      });
      if (absorbed.count === 1) return waiting.id;
    }

    const pending = await this.prisma.agentRun.count({
      where: { workspaceId: document.workspaceId, agentKey: JUDGE_AGENT_KEY, status: 'pending' },
    });
    if (pending >= MAX_PENDING) {
      this.logger.warn(`source change check for ${document.id} dropped: ${pending} checks already waiting`);
      return null;
    }
    const override = await this.prisma.aiAgent.findUnique({
      where: { workspaceId_key: { workspaceId: document.workspaceId, key: JUDGE_AGENT_KEY } },
      select: { id: true },
    });
    const input: AgentRunInput = { sourceChange: { documentId: document.id, fromRevisionId, toRevisionId } };
    const run = await this.prisma.agentRun.create({
      data: {
        workspaceId: document.workspaceId,
        agentKey: JUDGE_AGENT_KEY,
        agentId: override?.id ?? null,
        trigger: 'source',
        createdBy: connector.createdBy,
        locale: connector.locale,
        input: input as Prisma.InputJsonValue,
      },
    });
    await this.producer.enqueue(run.id);
    return run.id;
  }

  private async headingAnchors(s3Key: string): Promise<Anchor[]> {
    return headingSections(await this.storage.getObjectText(s3Key));
  }

  private async operationAnchors(revisionId: string): Promise<Anchor[]> {
    const ops = await this.prisma.apiOperation.findMany({ where: { revisionId }, select: { entityKey: true, method: true } });
    return ops.map((o) => ({ id: operationAnchor(o), body: null }));
  }
}
