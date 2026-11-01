import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type Connector, type ConnectorLink, type SourceRecipe as SourceRecipeRow } from '@prisma/client';
import type {
  DocumentSourceRecipeState,
  Locale,
  SourceCheckFailure,
  SourceRecipe,
  SourceRecipePreview,
  SourceRecipeVersion,
} from '@knowledge/contracts';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { DocumentsService } from '../documents/documents.service.js';
import { safeJson } from '../glossary/glossary.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { sha256 } from './connector-markdown.js';
import {
  baselineOf,
  checkExtraction,
  extractSource,
  isHtmlBody,
  readRecipe,
  sourceOutline,
  type SourceBaseline,
  type SourceBody,
  type SourceExtraction,
  type SourceFingerprint,
} from './source-recipe.js';

/** The system's own actor id: a draft nobody asked for is billed to no one. */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';
/** Characters of the last good page the agent reads beside the outline. */
const PAGE_EXCERPT = 4_000;

/** What reading a fetched version through the page's recipe decided. */
export type RecipeRead =
  | { held: false; markdown: string }
  | { held: true; newlyHeld: boolean };

/**
 * Extraction recipes (#674, phase 2), the stateful half: which recipe a link
 * reads with, the held state, the agent's draft and a person's save.
 *
 * The sync hook (`read`) runs in the worker inside staging; the page
 * operations (`preview`, `save`, `draft`, `dismiss`) are the review route's.
 * Output from a recipe that fails its checks is never written: `read` holds
 * it, `save` refuses it.
 */
@Injectable()
export class SourceRecipesService {
  private readonly logger = new Logger(SourceRecipesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly documents: DocumentsService,
    private readonly agents: AgentRegistryService,
    private readonly client: AssistantClient,
    private readonly aiUsage: AiUsageService,
  ) {}

  // ------------------------------------------------------------ sync hook

  /**
   * A fetched version, read through the recipe in force. Passing: the
   * baseline moves to it, and the markdown is what staging writes. Failing:
   * the link is held (the page stays on its last good revision) and, the
   * first time, the agent drafts a recipe — fail-open, a review opens either way.
   */
  async read(row: Connector, link: ConnectorLink, source: SourceBody): Promise<RecipeRead> {
    await this.keepBody(row, link, source);
    const recipe = await this.recipeFor(link);
    const ex = await extractSource(source, recipe);
    const failures = checkExtraction(ex, recipe, link.baseline as SourceBaseline | null);
    if (failures.length === 0) {
      await this.passed(link, ex);
      return { held: false, markdown: ex.markdown };
    }
    const newlyHeld = await this.hold(link, failures, ex.fingerprint);
    if (newlyHeld && isHtmlBody(source.contentType)) {
      await this.draft(row, link, failures, null, 'en').catch((err: unknown) =>
        this.logger.warn({ msg: 'Recipe draft failed', linkId: link.id, err: String(err) }),
      );
    }
    return { held: true, newlyHeld };
  }

  /** A body that is neither markdown nor HTML: held, with nothing to draft from. */
  async unsupported(link: ConnectorLink): Promise<boolean> {
    return this.hold(link, ['unsupported'], null);
  }

  /** The baseline moves to this version, a held link is released, and a moved fingerprint leaves a note. */
  private async passed(link: ConnectorLink, ex: SourceExtraction): Promise<void> {
    const before = (link.fingerprint as SourceFingerprint | null)?.hash;
    const moved = !!before && !!ex.fingerprint && before !== ex.fingerprint.hash;
    await this.prisma.connectorLink.update({
      where: { id: link.id },
      data: {
        baseline: baselineOf(ex) as unknown as Prisma.InputJsonValue,
        ...(ex.fingerprint ? { fingerprint: ex.fingerprint as unknown as Prisma.InputJsonValue } : {}),
        heldAt: null,
        heldReason: null,
        ...(moved && !link.structureChangedAt ? { structureChangedAt: new Date() } : {}),
      },
    });
  }

  /** Returns true on the transition into held, the one that alerts. */
  private async hold(link: ConnectorLink, failures: SourceCheckFailure[], fingerprint: SourceFingerprint | null): Promise<boolean> {
    // The source was read, so "checked" moves even though nothing is written.
    const fp = { lastPulledAt: new Date(), ...(fingerprint ? { fingerprint: fingerprint as unknown as Prisma.InputJsonValue } : {}) };
    const { count } = await this.prisma.connectorLink.updateMany({
      where: { id: link.id, heldAt: null },
      data: { heldAt: new Date(), heldReason: failures.join(','), ...fp },
    });
    if (count === 0) await this.prisma.connectorLink.update({ where: { id: link.id }, data: { heldReason: failures.join(','), ...fp } });
    return count > 0;
  }

  private async keepBody(row: Connector, link: ConnectorLink, source: SourceBody): Promise<void> {
    const hash = sha256(`${source.contentType}\n${source.url}\n${source.body}`);
    if (hash === link.bodyHash) return;
    await this.storage.putObjectText(this.storage.sourceBodyObjectKey(row.workspaceId, row.id, link.id), JSON.stringify(source), 'application/json');
    await this.prisma.connectorLink.update({ where: { id: link.id }, data: { bodyHash: hash } });
    link.bodyHash = hash;
  }

  // ------------------------------------------------------------ page operations

  async state(link: ConnectorLink): Promise<DocumentSourceRecipeState> {
    const [active, proposal] = await Promise.all([this.activeRow(link), this.proposalRow(link)]);
    return {
      active: active ? versionOf(active) : null,
      proposal: proposal ? versionOf(proposal) : null,
      heldAt: link.heldAt?.toISOString() ?? null,
      heldReasons: (link.heldReason ? link.heldReason.split(',') : []) as SourceCheckFailure[],
      structureChangedAt: link.structureChangedAt?.toISOString() ?? null,
      hasBody: link.bodyHash !== null,
    };
  }

  /** What a recipe makes of the last fetched version, beside the page as it reads now. */
  async preview(link: ConnectorLink, value: unknown): Promise<SourceRecipePreview> {
    const recipe = this.parse(value);
    const [source, before] = await Promise.all([this.body(link), this.headMarkdown(link.documentId)]);
    const ex = await extractSource(source, recipe);
    return { before, after: ex.markdown, failures: checkExtraction(ex, recipe, link.baseline as SourceBaseline | null), hits: ex.hits };
  }

  /**
   * A person's recipe, approving a proposal or not: refused while its checks
   * fail, else the new active version for this page. The last fetched version
   * is re-read through it, and a different result is written as a revision
   * (unless the source is paused — resuming re-reads anyway).
   */
  async save(row: Connector, link: ConnectorLink, value: unknown, proposalId: string | undefined, userId: string): Promise<void> {
    const recipe = this.parse(value);
    const source = await this.body(link);
    const ex = await extractSource(source, recipe);
    const failures = checkExtraction(ex, recipe, link.baseline as SourceBaseline | null);
    if (failures.length > 0) {
      throw new ConflictException({ statusCode: 409, message: t('error.source.recipeChecksFail', { checks: failures.join(', ') }), failures });
    }
    const proposal = proposalId ? await this.proposalRow(link) : null;
    if (proposalId && proposal?.id !== proposalId) throw new ConflictException(t('error.source.proposalStale'));
    const scope = { connectorId: row.id, documentId: link.documentId };
    const unchanged = proposal && JSON.stringify(readRecipe(proposal.recipe).recipe) === JSON.stringify(recipe);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.sourceRecipe.updateMany({ where: { ...scope, status: 'active' }, data: { status: 'superseded' } });
      if (proposal && unchanged) {
        await tx.sourceRecipe.update({ where: { id: proposal.id }, data: { status: 'active', decidedBy: userId, decidedAt: now } });
      } else {
        if (proposal) await tx.sourceRecipe.update({ where: { id: proposal.id }, data: { status: 'superseded', decidedBy: userId, decidedAt: now } });
        await tx.sourceRecipe.create({
          data: {
            ...scope,
            workspaceId: row.workspaceId,
            version: await this.nextVersion(tx, row.id),
            status: 'active',
            origin: 'person',
            recipe: recipe as unknown as Prisma.InputJsonValue,
            createdBy: userId,
            decidedBy: userId,
            decidedAt: now,
          },
        });
      }
      await tx.connectorLink.update({
        where: { id: link.id },
        data: {
          baseline: baselineOf(ex) as unknown as Prisma.InputJsonValue,
          ...(ex.fingerprint ? { fingerprint: ex.fingerprint as unknown as Prisma.InputJsonValue } : {}),
          heldAt: null,
          heldReason: null,
          structureChangedAt: null,
        },
      });
    });

    const markdown = ex.markdown.trim();
    const hash = sha256(markdown);
    if (link.pausedAt || hash === link.contentHash) return;
    const draft = await this.documents.createRevision(
      link.documentId,
      { message: t('connector.sourceRecipeMessage'), contentType: 'text/markdown' },
      undefined,
      userId,
      { connectorId: row.id },
    );
    const stored = await this.prisma.documentRevision.findUniqueOrThrow({ where: { id: draft.revisionId } });
    await this.storage.putObjectText(stored.s3Key, markdown, stored.contentType);
    await this.documents.finalizeRevision(link.documentId, draft.revisionId);
    await this.prisma.connectorLink.update({ where: { id: link.id }, data: { contentHash: hash, revisionId: draft.revisionId, lastPulledAt: new Date() } });
  }

  /** "Keep the current recipe": the open proposal is rejected and the layout note cleared. A held version stays held. */
  async dismiss(row: Connector, link: ConnectorLink, userId: string): Promise<void> {
    await this.prisma.sourceRecipe.updateMany({
      where: { connectorId: row.id, documentId: link.documentId, status: 'proposed' },
      data: { status: 'rejected', decidedBy: userId, decidedAt: new Date() },
    });
    await this.prisma.connectorLink.update({ where: { id: link.id }, data: { structureChangedAt: null } });
  }

  /**
   * The `interpreter` drafts a recipe for the last fetched version: a
   * proposal for this page, replacing any earlier one. Null when the agent is
   * off or the body is not HTML. Its output is reduced to the declared shape
   * by `readRecipe`; nothing it writes is run.
   */
  async draft(
    row: Connector,
    link: ConnectorLink,
    failures: SourceCheckFailure[],
    userId: string | null,
    locale: Locale,
  ): Promise<SourceRecipeVersion | null> {
    const agent = await this.agents.resolve(row.workspaceId, 'interpreter');
    if (!agent.enabled || !agent.config.enabled) return null;
    const source = await this.body(link);
    if (!isHtmlBody(source.contentType)) return null;
    const billed = userId ?? AUTHOR_ID_STUB;
    await this.aiUsage.assertWithinBudget(row.workspaceId, billed);
    const [current, page] = await Promise.all([this.recipeFor(link), this.headMarkdown(link.documentId)]);

    const raw = await this.client.chat(
      { config: agent.config, userId: billed, operation: 'source-recipe', locale },
      [
        { role: 'system', content: agent.instructions },
        {
          role: 'user',
          content:
            `Source URL: ${source.url}\n` +
            `Current recipe: ${current ? JSON.stringify(current) : 'none (automatic article extraction)'}\n` +
            `Failed checks: ${failures.length ? failures.join(', ') : 'none (a person asked for a new recipe)'}\n\n` +
            `The page as it last read (its start):\n${wrapUntrusted(page.slice(0, PAGE_EXCERPT), 'source-recipe', 'page')}\n\n` +
            `The new version's element outline:\n${wrapUntrusted(sourceOutline(source.body, source.url), 'source-recipe', 'web')}`,
        },
      ],
      { json: true },
    );
    const parsed = (safeJson(raw) ?? {}) as Record<string, unknown>;
    const { recipe } = readRecipe(parsed.recipe ?? parsed);
    // The agent drafts where the content is; the rules are people's and carry over.
    if (current && recipe.rules.length === 0) recipe.rules = current.rules;
    const note = typeof parsed.note === 'string' ? parsed.note.slice(0, 500) : null;

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.sourceRecipe.updateMany({ where: { connectorId: row.id, documentId: link.documentId, status: 'proposed' }, data: { status: 'superseded' } });
      return tx.sourceRecipe.create({
        data: {
          workspaceId: row.workspaceId,
          connectorId: row.id,
          documentId: link.documentId,
          version: await this.nextVersion(tx, row.id),
          status: 'proposed',
          origin: 'agent',
          recipe: recipe as unknown as Prisma.InputJsonValue,
          note,
          createdBy: userId,
        },
      });
    });
    return versionOf(created);
  }

  // ------------------------------------------------------------ reads

  /** The page's active recipe, else the connector's; null = the implicit one. */
  private async recipeFor(link: ConnectorLink): Promise<SourceRecipe | null> {
    const row = await this.activeRow(link);
    return row ? readRecipe(row.recipe).recipe : null;
  }

  private async activeRow(link: ConnectorLink): Promise<SourceRecipeRow | null> {
    const rows = await this.prisma.sourceRecipe.findMany({
      where: { connectorId: link.connectorId, status: 'active', OR: [{ documentId: link.documentId }, { documentId: null }] },
      orderBy: { version: 'desc' },
    });
    return rows.find((r) => r.documentId === link.documentId) ?? rows[0] ?? null;
  }

  private proposalRow(link: ConnectorLink): Promise<SourceRecipeRow | null> {
    return this.prisma.sourceRecipe.findFirst({
      where: { connectorId: link.connectorId, documentId: link.documentId, status: 'proposed' },
      orderBy: { version: 'desc' },
    });
  }

  private async body(link: ConnectorLink): Promise<SourceBody> {
    if (!link.bodyHash) throw new ConflictException(t('error.source.noBody'));
    const connector = await this.prisma.connector.findUniqueOrThrow({ where: { id: link.connectorId }, select: { workspaceId: true } });
    return JSON.parse(await this.storage.getObjectText(this.storage.sourceBodyObjectKey(connector.workspaceId, link.connectorId, link.id))) as SourceBody;
  }

  private async headMarkdown(documentId: string): Promise<string> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId }, include: { branches: true } });
    const head = document?.branches.find((b) => b.name === document.defaultBranch)?.headRevisionId;
    const revision = head ? await this.prisma.documentRevision.findUnique({ where: { id: head }, select: { s3Key: true } }) : null;
    return revision ? this.storage.getObjectText(revision.s3Key) : '';
  }

  private parse(value: unknown): SourceRecipe {
    const { recipe, errors } = readRecipe(value);
    if (errors.length > 0) throw new BadRequestException({ statusCode: 400, message: t('error.source.recipeInvalid', { errors: errors.join('; ') }), errors });
    return recipe;
  }

  private async nextVersion(tx: Prisma.TransactionClient, connectorId: string): Promise<number> {
    const { _max } = await tx.sourceRecipe.aggregate({ where: { connectorId }, _max: { version: true } });
    return (_max.version ?? 0) + 1;
  }
}

function versionOf(row: SourceRecipeRow): SourceRecipeVersion {
  return {
    id: row.id,
    version: row.version,
    status: row.status as SourceRecipeVersion['status'],
    origin: row.origin as SourceRecipeVersion['origin'],
    connectorScope: row.documentId === null,
    recipe: readRecipe(row.recipe).recipe,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}
