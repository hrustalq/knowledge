import { Injectable, Logger } from '@nestjs/common';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { WorkflowRun, WorkflowRunNode } from '@prisma/client';
import type { WorkflowNodeDraft, WorkflowStep } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { AgentRegistryService, type ResolvedAgent } from '../agents/agent-registry.service.js';
import { AiSkillsService } from '../ai/ai-skills.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { SearchService } from '../search/search.service.js';
import { StorageService } from '../storage/storage.service.js';
import { asLocale } from '../i18n/locale.js';

/** What a step produced: either a fan-out list, or one node's draft. */
export type StepResult =
  | { kind: 'items'; items: Array<{ title: string; summary?: string }> }
  | { kind: 'draft'; draft: WorkflowNodeDraft }
  | { kind: 'context'; context: unknown }
  | { kind: 'gate' };

/**
 * The step catalogue's executors (docs/features/17).
 *
 * The catalogue is closed on purpose: `setup({ actors, guards })` resolves
 * implementations by name in code, so a stored definition only ever *names* a
 * step kind. That is what makes a "dynamic" workflow data rather than
 * executable content arriving from the database.
 *
 * Provider resolution follows feature 12 exactly — `resolveFor(workspaceId,
 * purpose, step.providerId)` — so a workflow honours the workspace's routing,
 * its budget and its usage log without knowing anything about them.
 */
@Injectable()
export class WorkflowExecutors {
  private readonly logger = new Logger(WorkflowExecutors.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AssistantClient,
    private readonly search: SearchService,
    private readonly storage: StorageService,
    private readonly agents: AgentRegistryService,
    private readonly skills: AiSkillsService,
  ) {}

  async run(step: WorkflowStep, node: WorkflowRunNode, run: WorkflowRun): Promise<StepResult> {
    switch (step.kind) {
      case 'review':
        return { kind: 'gate' };
      case 'search':
        return this.runSearch(step, node, run);
      case 'ai.generate':
        return this.runGenerate(step, node, run);
      case 'ai.draft':
        return this.runDraft(step, node, run);
    }
  }

  // ------------------------------------------------------------------ search

  private async runSearch(step: WorkflowStep, node: WorkflowRunNode, run: WorkflowRun): Promise<StepResult> {
    const context = await this.gather(node, run);
    const results = await this.search.search({
      workspaceId: run.workspaceId,
      query: context.title || context.markdown.slice(0, 400),
      limit: step.filters?.limit ?? 8,
      ...(step.filters?.categories?.length ? { filters: { categories: step.filters.categories } } : {}),
      ...(step.filters?.projectIds?.length
        ? { filters: { projectIds: step.filters.projectIds } }
        : {}),
    } as Parameters<SearchService['search']>[0]);
    return { kind: 'context', context: results };
  }

  // ------------------------------------------------------------- ai.generate

  private async runGenerate(step: WorkflowStep, node: WorkflowRunNode, run: WorkflowRun): Promise<StepResult> {
    // The step's default instructions come from the agent (docs/features/20);
    // an explicit `step.prompt.system` still wins, because a workflow author
    // writing a prompt for one step means that step and not the roster.
    //
    // The step's own providerId still pins the model; absent one, the agent's
    // routing bucket decides. That moved `ai.draft` from the 'chat' route to
    // 'review' — the bucket feature 12 describes as background generation, and
    // the one the editor's Suggest already used. A workspace that wants the old
    // model back pins it on the step or on the drafter agent.
    const planner = await this.agents.resolve(run.workspaceId, 'planner', step.providerId ?? undefined);
    const config = planner.config;
    if (!planner.enabled || !config.enabled) throw new Error('The AI assistant is disabled for this workspace');

    const context = await this.gather(node, run);
    const cap = Math.min(step.maxItems ?? 8, 50);

    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: [
          step.prompt?.system ?? planner.instructions,
          `Return JSON: {"items":[{"title":"…","summary":"…"}]}.`,
          `Return at most ${cap} items. Every item must be grounded in the source below —`,
          'do not invent things the source gives no basis for. Titles are short and specific.',
          await this.skillText(run.workspaceId, step, planner),
        ]
          .filter(Boolean)
          .join('\n'),
      },
      {
        role: 'user',
        content: [
          step.prompt?.user ?? '',
          run.note ? `\nExtra instructions for this run: ${run.note}` : '',
          `\n\n--- SOURCE: ${context.title} ---\n${context.markdown}`,
          context.parentSummary ? `\n\n--- PARENT ITEM ---\n${context.parentSummary}` : '',
        ].join(''),
      },
    ];

    const raw = await this.client.chat(
      { config, userId: run.createdBy, operation: 'workflow', locale: asLocale(run.locale) },
      messages,
      { json: true },
    );

    const items = this.parseItems(raw).slice(0, cap);
    if (items.length === 0) throw new Error('The model returned no items for this step');
    return { kind: 'items', items };
  }

  // ---------------------------------------------------------------- ai.draft

  private async runDraft(step: WorkflowStep, node: WorkflowRunNode, run: WorkflowRun): Promise<StepResult> {
    const drafter = await this.agents.resolve(run.workspaceId, 'drafter', step.providerId ?? undefined);
    const config = drafter.config;
    if (!drafter.enabled || !config.enabled) throw new Error('The AI assistant is disabled for this workspace');

    const context = await this.gather(node, run);
    const title = context.parentTitle || context.title;

    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: [
          step.prompt?.system ?? drafter.instructions,
          'Return JSON: {"title":"…","markdown":"…","summary":"…"}.',
          'The markdown is the page body — no front matter, no wrapping code fence.',
          'Stay grounded in the source material; say plainly when something is not specified.',
          await this.skillText(run.workspaceId, step, drafter),
        ]
          .filter(Boolean)
          .join('\n'),
      },
      {
        role: 'user',
        content: [
          step.prompt?.user ?? '',
          run.note ? `\nExtra instructions for this run: ${run.note}` : '',
          `\n\nWrite the page for: ${title}`,
          context.parentSummary ? `\n\nWhat it covers: ${context.parentSummary}` : '',
          `\n\n--- SOURCE: ${context.title} ---\n${context.markdown}`,
        ].join(''),
      },
    ];

    const raw = await this.client.chat(
      { config, userId: run.createdBy, operation: 'workflow', locale: asLocale(run.locale) },
      messages,
      { json: true },
    );

    const parsed = this.parseObject(raw);
    const markdown = typeof parsed.markdown === 'string' ? parsed.markdown : '';
    if (!markdown.trim()) throw new Error('The model returned an empty page');

    return {
      kind: 'draft',
      draft: {
        title: (typeof parsed.title === 'string' && parsed.title.trim()) || title,
        markdown,
        summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      },
    };
  }

  // ----------------------------------------------------------------- context

  /**
   * What a step gets to see: the run's source page, plus the parent item when
   * this node came out of a fan-out. Kept small on purpose — a whole subtree in
   * the prompt is how a chain of steps runs out of context halfway down.
   */
  private async gather(
    node: WorkflowRunNode,
    run: WorkflowRun,
  ): Promise<{ title: string; markdown: string; parentTitle?: string; parentSummary?: string }> {
    const source = await this.documentText(run.rootDocumentId);
    const input = (node.input ?? {}) as { parentDraft?: { title?: string; summary?: string } };
    const own = (node.draft ?? null) as WorkflowNodeDraft | null;

    return {
      title: source.title,
      markdown: source.markdown,
      // A fan-out node carries its own item as its draft; a step spawned below
      // one carries the parent's.
      parentTitle: own?.title ?? input.parentDraft?.title,
      parentSummary: own?.summary ?? input.parentDraft?.summary,
    };
  }

  /**
   * The run's source page, read the way `DocumentsService.getContent` reads it:
   * the default branch's head revision out of object storage. Frontmatter is
   * left in — it usually carries the relations that tell a model what the page
   * is connected to.
   */
  private async documentText(documentId: string): Promise<{ title: string; markdown: string }> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { branches: true },
    });
    if (!document) return { title: 'Unknown page', markdown: '' };

    const headId = document.branches.find((b) => b.name === document.defaultBranch)?.headRevisionId;
    if (!headId) return { title: document.title, markdown: '' };
    const revision = await this.prisma.documentRevision.findUnique({ where: { id: headId } });
    if (!revision?.s3Key || revision.status === 'draft') return { title: document.title, markdown: '' };

    const raw = await this.storage.getObjectText(revision.s3Key).catch(() => '');
    // Capped rather than chunked: a chain of steps that each paste a whole page
    // into its prompt is how a run walks off the end of a context window.
    return { title: document.title, markdown: raw.slice(0, 24_000) };
  }

  /**
   * Operator-authored instruction packs, through the same service `prepareTurn`
   * uses. This used to hand-roll its own `<skills>` block because
   * AiSkillsService was API-only; it now lives in AiCoreModule, so a step and a
   * chat turn cannot render skills two different ways.
   *
   * The agent's own `skillIds` join the step's — that is what an agent
   * *referencing* skills means (docs/features/20), and a step that names none
   * still gets whatever its agent carries. Trigger matching runs against the
   * step's prompt, which the workflow author wrote, never against the source
   * document: page content must not be able to select instructions.
   */
  private async skillText(workspaceId: string, step: WorkflowStep, agent: ResolvedAgent): Promise<string> {
    const ids = [...(step.skillIds ?? []), ...agent.skillIds];
    const haystack = `${step.prompt?.system ?? ''}\n${step.prompt?.user ?? ''}`;
    return this.skills.renderPrompt(await this.skills.forTurn(workspaceId, haystack, ids));
  }

  // ------------------------------------------------------------------ parsing

  private parseObject(raw: string): Record<string, unknown> {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      this.logger.warn('Model returned unparseable JSON for a workflow step');
      return {};
    }
  }

  /** Providers disagree about whether to wrap a list; accept either shape. */
  private parseItems(raw: string): Array<{ title: string; summary?: string }> {
    const parsed = this.parseObject(raw);
    const candidate = Array.isArray(parsed.items)
      ? parsed.items
      : Array.isArray(parsed.results)
        ? parsed.results
        : [];

    const seen = new Set<string>();
    const items: Array<{ title: string; summary?: string }> = [];
    for (const entry of candidate) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { title, summary } = entry as { title?: unknown; summary?: unknown };
      if (typeof title !== 'string' || !title.trim()) continue;
      const key = title.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        title: title.trim().slice(0, 300),
        summary: typeof summary === 'string' ? summary.slice(0, 4_000) : undefined,
      });
    }
    return items;
  }
}
