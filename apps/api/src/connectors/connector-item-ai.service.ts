import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ConnectorItemAiOp, ConnectorRunItemInfo } from '@knowledge/contracts';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { DocumentsService } from '../documents/documents.service.js';
import type { Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { toItemInfo } from './connector-items.service.js';
import { sha256 } from './connector-markdown.js';
import type { ItemDraft } from './connector-staging.service.js';

/** Enough of a page to reason about; the rest is ballast for a repair job. */
const MAX_SOURCE_CHARS = 24_000;

/**
 * The two AI assists on a staged item (docs/features/26).
 *
 * Both go through the existing `drafter` agent rather than adding a built-in.
 * `drafter`'s job is already "produce revised prose for an existing page given
 * context", which is what each of these is; an eleventh built-in differing only
 * in framing is the roster drift feature 20 warns about, and routing here means
 * an admin can already edit the prompt and pick the model.
 *
 * Neither is ever automatic. A model rewriting an import unasked would make the
 * staged copy something nobody chose, and the whole point of staging is that
 * somebody chooses.
 */
@Injectable()
export class ConnectorItemAiService {
  private readonly logger = new Logger(ConnectorItemAiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentRegistryService,
    private readonly client: AssistantClient,
    private readonly aiUsage: AiUsageService,
    private readonly documents: DocumentsService,
    private readonly storage: StorageService,
  ) {}

  async run(runId: string, itemId: string, op: ConnectorItemAiOp, principal: Principal): Promise<ConnectorRunItemInfo> {
    const item = await this.prisma.connectorRunItem.findUnique({ where: { id: itemId } });
    if (!item || item.runId !== runId) throw new BadRequestException(t('error.connector.itemNotFound'));
    if (item.status !== 'staged') throw new ConflictException(t('error.connector.itemNotEditable'));
    if (!item.stagedKey) throw new ConflictException(t('error.connector.itemNotEditable'));
    if (op === 'merge' && item.action !== 'conflict') {
      // Merging needs two versions that disagree. Offering it elsewhere would
      // ask the model to reconcile a page with itself.
      throw new ConflictException(t('error.connector.mergeNotAConflict'));
    }

    const run = await this.prisma.connectorRun.findUniqueOrThrow({ where: { id: runId } });
    const agent = await this.agents.resolve(run.workspaceId, 'drafter');
    if (!agent.enabled || !agent.config.enabled) {
      throw new ConflictException(t('error.ai.disabled'));
    }
    await this.aiUsage.assertWithinBudget(run.workspaceId, principal.userId);

    const staged = await this.storage.getObjectText(item.stagedKey);
    const messages =
      op === 'cleanup'
        ? this.cleanupPrompt(agent.instructions, item.title, staged, (item.draft as ItemDraft | null)?.warnings ?? [])
        : await this.mergePrompt(agent.instructions, item, staged);

    const revised = await this.client.chat(
      { config: agent.config, userId: principal.userId, operation: 'connector', locale: principal.locale },
      messages,
    );

    const markdown = stripFence(revised).trim();
    // A model that returns nothing must not blank the import. Refusing is the
    // only safe answer: the staged copy is still good, and the person can retry.
    if (markdown.length === 0) throw new ConflictException(t('error.connector.aiEmpty'));

    await this.storage.putObjectText(item.stagedKey, markdown, 'text/markdown');
    const draft: ItemDraft = { ...((item.draft as ItemDraft | null) ?? {}), aiOp: op };
    const updated = await this.prisma.connectorRunItem.update({
      where: { id: item.id },
      data: { contentHash: sha256(markdown), draft: draft as unknown as Prisma.InputJsonValue },
    });

    return toItemInfo(updated);
  }

  private cleanupPrompt(instructions: string, title: string, markdown: string, warnings: string[]) {
    const lost = warnings.length > 0 ? `\n\nThe conversion reported: ${warnings.join(' ')}` : '';
    return [
      {
        role: 'system' as const,
        content:
          `${instructions}\n\n` +
          'You are repairing a page converted from a wiki into Markdown. Fix heading ' +
          'levels, broken tables, list nesting and leftover markup from macros that ' +
          'did not survive. Transcribe, never summarise: do not shorten, reword or ' +
          'drop anything that carries meaning. Reply with the corrected Markdown only.',
      },
      { role: 'user' as const, content: `Title: ${title}\n\n${markdown.slice(0, MAX_SOURCE_CHARS)}${lost}` },
    ];
  }

  /**
   * Three-way, not two: the version the two sides last agreed on is what makes
   * "who changed what" answerable. Without the base, a model can only guess
   * which differences are edits and which are the other side's untouched text.
   */
  private async mergePrompt(instructions: string, item: { documentId: string | null; linkId: string | null; title: string }, incoming: string) {
    const local = item.documentId
      ? await this.documents
          .getContent(item.documentId)
          .then((c) => c.markdown)
          .catch(() => '')
      : '';

    let base = '';
    const link = item.linkId ? await this.prisma.connectorLink.findUnique({ where: { id: item.linkId } }) : null;
    if (link?.revisionId) {
      const revision = await this.prisma.documentRevision.findUnique({ where: { id: link.revisionId } });
      if (revision) base = await this.storage.getObjectText(revision.s3Key).catch(() => '');
    }

    return [
      {
        role: 'system' as const,
        content:
          `${instructions}\n\n` +
          'Two copies of one page changed independently. Produce a single Markdown ' +
          'document keeping both sets of changes. Preserve every fact from each ' +
          'side; where they genuinely contradict, keep the incoming version and ' +
          'note the disagreement inline as a blockquote beginning "Conflict:". ' +
          'Reply with the merged Markdown only.',
      },
      {
        role: 'user' as const,
        content:
          `Title: ${item.title}\n\n` +
          `## Last agreed version\n\n${base.slice(0, MAX_SOURCE_CHARS)}\n\n` +
          `## Our current page\n\n${local.slice(0, MAX_SOURCE_CHARS)}\n\n` +
          `## Incoming version\n\n${incoming.slice(0, MAX_SOURCE_CHARS)}`,
      },
    ];
  }
}

/** Models wrap whole documents in a fence often enough to be worth undoing. */
function stripFence(text: string): string {
  const match = /^\s*```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/.exec(text);
  return match ? match[1] : text;
}
