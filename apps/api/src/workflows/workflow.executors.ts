import { Injectable, Logger } from '@nestjs/common';
import { ConnectorWorkItemsService } from '../connectors/connector-work-items.service.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { WorkflowRun, WorkflowRunNode } from '@prisma/client';
import { AUTHORABLE_RELATION_TYPES } from '@knowledge/contracts';
import type { RelationInput, WorkflowNodeDraft, WorkflowStep } from '@knowledge/contracts';
import { normalizeRelation, relationKey } from '../common/relations.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { TemplatesService, type TemplateDefaults } from '../templates/templates.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AgentRegistryService, type ResolvedAgent } from '../agents/agent-registry.service.js';
import { AiSkillsService } from '../ai/ai-skills.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { SearchService } from '../search/search.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import type { Principal } from '../auth/principal.js';
import { StorageService } from '../storage/storage.service.js';
import { asLocale } from '../i18n/locale.js';
import { t } from '../i18n/t.js';

/** Caps on what one draft may declare, so a hallucinated list cannot fill a page's frontmatter. */
/** A page attached to a dozen issues is a page; a flow should not spam all of them. */
const MAX_TASK_COMMENTS = 5;

const MAX_DRAFT_RELATIONS = 20;
const MAX_DRAFT_TAGS = 20;
/** The template skeleton handed to a drafting model — a structure, not a second source page. */
const MAX_SKELETON_CHARS = 24_000;
const MAX_TEMPLATE_NOTES_CHARS = 4_000;

/**
 * Appended to a drafting step's system prompt when its `produces.templateRef`
 * names a template. Trusted and code-owned; the template itself travels in the
 * user turn, wrapped untrusted (`templateBlock`).
 */
const TEMPLATE_RULE =
  'The page is written into a page template, given below as a skeleton. Keep its headings, in their order, ' +
  'and fill every section from the source material. Replace each remaining {{placeholder}} with a value the ' +
  'source supports, or with "TODO:" and what is missing — never invent one. Follow the title pattern when ' +
  'there is one. Return the filled-in page as "markdown"; never return the skeleton unchanged.';

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
    private readonly workItems: ConnectorWorkItemsService,
    private readonly templates: TemplatesService,
    private readonly permissions: PermissionService,
  ) {}

  /** `principal` is the run's rehydrated owner, already authorised by the processor. */
  async run(step: WorkflowStep, node: WorkflowRunNode, run: WorkflowRun, principal: Principal): Promise<StepResult> {
    switch (step.kind) {
      case 'review':
        return { kind: 'gate' };
      case 'search':
        return this.runSearch(step, node, run, principal);
      case 'ai.generate':
        return this.runGenerate(step, node, run);
      case 'ai.draft':
        return this.runDraft(step, node, run);
      case 'task.update':
        return this.runTaskUpdate(step, node, run);
    }
  }

  // ------------------------------------------------------------- task.update

  /**
   * Report back to the issue this run is about (docs/features/32).
   *
   * Deterministic — no model call — and it acts only on work items already
   * attached to the run's **source page**. A definition cannot name an issue
   * number, which is the one thing that keeps a workflow from being a way to
   * comment on any repository the workspace can reach.
   *
   * It runs in the worker, unlike everything else that reaches outside: the
   * "worker generates, API publishes" rule is about acts that need a principal
   * to attribute them to, and a run carries `created_by` precisely so its steps
   * have one. The processor has already rehydrated it and checked the role.
   *
   * A page with no attached work item is a no-op rather than a failure. A flow
   * that also runs manually, or against a page nobody connected to an issue,
   * should finish rather than fail on a step that had nothing to say.
   */
  private async runTaskUpdate(step: WorkflowStep, node: WorkflowRunNode, run: WorkflowRun): Promise<StepResult> {
    const context = await this.gather(node, run);
    // The comment body is the step's own prompt — trusted text an admin wrote —
    // with the node's title appended. Nothing here is interpolated into
    // anything that executes, and the title is the only untrusted half.
    const body = [step.prompt?.user?.trim(), context.title ? `\n\n— ${context.title}` : '']
      .filter(Boolean)
      .join('');
    if (!body.trim()) return { kind: 'context', context: { commented: 0, reason: 'step has no message' } };

    const commented = await this.workItems.commentOnDocument(run.rootDocumentId, body, MAX_TASK_COMMENTS);
    return { kind: 'context', context: { commented } };
  }

  // ------------------------------------------------------------------ search

  private async runSearch(
    step: WorkflowStep,
    node: WorkflowRunNode,
    run: WorkflowRun,
    principal: Principal,
  ): Promise<StepResult> {
    const context = await this.gather(node, run);
    // The owner's pages, clamped to the source page's audience (#76): what the
    // search finds feeds drafts that land under that page, read by whoever can
    // open it — not necessarily by everyone the owner can see.
    const scope = await this.permissions.audienceScope(await this.permissions.scopeFor(principal, run.workspaceId), {
      kind: 'document',
      documentId: run.rootDocumentId,
    });
    const results = await this.search.search(
      {
        workspaceId: run.workspaceId,
        query: context.title || context.markdown.slice(0, 400),
        limit: step.filters?.limit ?? 8,
        ...(step.filters?.categories?.length ? { filters: { categories: step.filters.categories } } : {}),
        ...(step.filters?.projectIds?.length
          ? { filters: { projectIds: step.filters.projectIds } }
          : {}),
      } as Parameters<SearchService['search']>[0],
      scope,
    );
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
    if (!planner.enabled || !config.enabled) throw new Error(t('error.assistant.providerDisabled'));

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
    if (items.length === 0) throw new Error(t('error.workflow.noItems'));
    return { kind: 'items', items };
  }

  // ---------------------------------------------------------------- ai.draft

  private async runDraft(step: WorkflowStep, node: WorkflowRunNode, run: WorkflowRun): Promise<StepResult> {
    const drafter = await this.agents.resolve(run.workspaceId, 'drafter', step.providerId ?? undefined);
    const config = drafter.config;
    if (!drafter.enabled || !config.enabled) throw new Error(t('error.assistant.providerDisabled'));

    const context = await this.gather(node, run);
    const title = context.parentTitle || context.title;
    // Resolved at draft time, at its current version — which is what the node
    // records, so the page can say which shape it was written against even
    // after the template moves on. An archived template still resolves: the
    // definition was valid when it was saved, and a run in flight should not
    // fail because somebody tidied the gallery.
    const template = step.produces?.templateRef
      ? await this.templates.defaults({
          workspaceId: run.workspaceId,
          ref: step.produces.templateRef,
          title,
          projectId: run.projectId,
          authorId: run.createdBy,
        })
      : null;

    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: [
          step.prompt?.system ?? drafter.instructions,
          'Return JSON: {"title":"…","markdown":"…","summary":"…","relations":[{"type":"…","targetKey":"…"}],"tags":["…"]}.',
          'The markdown is the page body — no front matter, no wrapping code fence.',
          // Relations travel in their own field rather than as YAML the model
          // writes by hand: the materializer owns the frontmatter block, and a
          // hand-written one would have to be parsed back out before it could be
          // merged with what the step's `produces` adds.
          `Relations go in the "relations" field, never in the body. Allowed types: ${AUTHORABLE_RELATION_TYPES.join(', ')}.`,
          'A relation target is a stable entity key such as "service:identity" — reuse the spelling the source page already uses, since a near-miss key creates a second entity rather than linking to the first.',
          'Declare only relations the source material actually supports; return [] rather than guessing. Tags are not relations.',
          'Stay grounded in the source material; say plainly when something is not specified.',
          template ? TEMPLATE_RULE : '',
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
          template ? `\n\nFollow this structure exactly:\n${this.templateBlock(template)}` : '',
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
    if (!markdown.trim()) throw new Error(t('error.workflow.emptyPage'));

    // Until now these two fields were declared on WorkflowNodeDraft, validated by
    // the DTO and written by the materializer — and no executor ever produced
    // them. That is the same declared-and-ignored defect `WorkflowStep.tools`
    // was (docs/features/20).
    const relations = this.withTemplateRelations(template, this.parseRelations(parsed.relations));
    const tags = this.parseTags([...(template?.tags ?? []), ...this.asArray(parsed.tags)]);
    const frontmatter = { ...template?.frontmatter, ...(tags.length > 0 ? { tags } : {}) };

    return {
      kind: 'draft',
      draft: {
        title: (typeof parsed.title === 'string' && parsed.title.trim()) || title,
        markdown,
        summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
        ...(relations.length > 0 ? { relations } : {}),
        ...(Object.keys(frontmatter).length > 0 ? { frontmatter } : {}),
        ...(template ? { templateRef: template.ref, templateVersion: template.version } : {}),
      },
    };
  }

  /**
   * The template as the drafting model sees it (issue #69). Everything in it —
   * name, description, notes, placeholder labels and the skeleton itself — was
   * typed by a workspace member, so it is wrapped untrusted: a structure to
   * follow, never instructions (CLAUDE.md trust boundary). The rule that says
   * to follow it is `TEMPLATE_RULE`, which is code.
   */
  private templateBlock(template: TemplateDefaults): string {
    const placeholders = template.meta.placeholders.map(
      (p) => `- {{${p.name}}}: ${p.label ?? p.name}${p.hint ? ` (e.g. ${p.hint})` : ''}`,
    );
    const notes = [
      `Template: ${template.name} (${template.ref}, version ${template.version})`,
      template.meta.description?.trim() ? `Description: ${template.meta.description.trim()}` : '',
      template.titlePattern ? `Title pattern: ${template.titlePattern}` : '',
      placeholders.length ? `Placeholders to fill:\n${placeholders.join('\n')}` : '',
      template.meta.aiInstructions?.trim() ? `Notes for whoever fills it in:\n${template.meta.aiInstructions.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_TEMPLATE_NOTES_CHARS);
    return wrapUntrusted(
      `${notes}\n\n--- SKELETON ---\n${template.skeleton.slice(0, MAX_SKELETON_CHARS)}`,
      'template',
      'template',
    );
  }

  /**
   * The template's default relations first, so the model's cap never pushes
   * out what every page of this kind declares; then the model's, de-duplicated
   * on the pair the graph uniques on.
   */
  private withTemplateRelations(template: TemplateDefaults | null, proposed: RelationInput[]): RelationInput[] {
    if (!template?.relations.length) return proposed;
    const out: RelationInput[] = [...template.relations];
    const seen = new Set(out.map(relationKey));
    for (const relation of proposed) {
      if (out.length >= MAX_DRAFT_RELATIONS + template.relations.length) break;
      const key = relationKey(relation);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(relation);
    }
    return out;
  }

  private asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  /**
   * Relations the model proposed, validated here rather than downstream.
   *
   * An unknown edge type would otherwise travel worker → draft → approval →
   * `createDocument` → `GraphService.assertEdgeType`, which throws — stranding
   * the node in `materializing` hours after a person approved it. Dropping it
   * with a warning keeps the rest of the page: a step that proposed one bad
   * relation should still produce what it was asked for.
   */
  private parseRelations(value: unknown): RelationInput[] {
    if (!Array.isArray(value)) return [];
    const out: RelationInput[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const normalized = normalizeRelation({ type: e.type, target: e.target ?? e.targetKey });
      if (!normalized) {
        this.logger.warn(
          `Dropped a relation a workflow step proposed: ${JSON.stringify(entry).slice(0, 200)}`,
        );
        continue;
      }
      const key = `${normalized.type} ${normalized.target.key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: normalized.type, target: normalized.target });
      if (out.length >= MAX_DRAFT_RELATIONS) break;
    }
    return out;
  }

  private parseTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const tag of value) {
      if (typeof tag !== 'string' || !tag.trim()) continue;
      const trimmed = tag.trim().slice(0, 60);
      if (!out.includes(trimmed)) out.push(trimmed);
      if (out.length >= MAX_DRAFT_TAGS) break;
    }
    return out;
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
