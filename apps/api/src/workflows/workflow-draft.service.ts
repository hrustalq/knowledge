import { Injectable, Logger } from '@nestjs/common';
import {
  AUTHORABLE_RELATION_TYPES,
  DOCUMENT_CATEGORIES,
  WORKFLOW_STEP_KINDS,
  isAuthorableRelationType,
  type DocumentCategory,
  type DraftWorkflowResponse,
  type WorkflowDraftMessage,
  type WorkflowGraph,
  type WorkflowStep,
  type WorkflowStepProduces,
} from '@knowledge/contracts';
import { validateGraph } from '@knowledge/workflow';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import type { Principal } from '../auth/principal.js';
import { localizeIssues } from '../i18n/workflow-messages.js';
import { t } from '../i18n/t.js';
import type { DraftWorkflowDto } from './workflows.dto.js';

/**
 * The architect: designing a workflow by describing it (docs/features/17).
 *
 * This is the AI half of the creation wizard, and it follows feature 14's
 * glossary rule exactly — **the model proposes, it never persists**. Nothing
 * here writes a row. The wizard receives a graph, the operator edits it on the
 * canvas, and saving is the same `POST /v1/workflows` a hand-drawn chain uses.
 *
 * The turns live in the wizard, not in `assistant_threads`, because designing a
 * chain is a scenario that ends with a definition rather than a conversation
 * worth keeping. Storing the transcript beside the artefact it produced would
 * be the same fact in two places, and the second copy is the one that rots.
 *
 * The proposal is **compiled here before it is returned**. That is the whole
 * reason `validateGraph` lives in a shared package: the canvas gets to say "the
 * graph has a cycle" the instant you draw one because it runs the server's own
 * compiler, and the same guarantee now covers the model's output — the wizard
 * can never be handed a graph the save would reject.
 */

/** Turns kept, oldest dropped. Designing a chain is short; a long transcript
 *  here means the conversation went wrong, not that it needs more room. */
const MAX_TURNS = 20;
const MAX_MESSAGE_CHARS = 4_000;
/** Ceiling on a proposal. `validateGraph` has no opinion on size; a reviewer does. */
const MAX_STEPS = 12;

const KIND_SET = new Set<string>(WORKFLOW_STEP_KINDS);
const CATEGORY_SET = new Set<string>(DOCUMENT_CATEGORIES);

/**
 * The response shape, appended to the agent's instructions rather than stored
 * on the agent. An admin may rewrite how the architect *designs*; the JSON it
 * must return is this service's contract with itself and is not editable — the
 * same split `GlossaryService.suggest` makes with its own item cap.
 */
const RESPONSE_CONTRACT =
  '\n\nReply with JSON only, in this exact shape:\n' +
  '{\n' +
  '  "reply": "one or two sentences: your question, or what you just designed",\n' +
  '  "done": true | false,\n' +
  '  "name": "short name for the workflow",\n' +
  '  "description": "one line on what it is for",\n' +
  '  "steps": [\n' +
  '    {\n' +
  '      "id": "lower-case-dashed-slug",\n' +
  '      "kind": "ai.generate" | "ai.draft" | "search" | "review",\n' +
  '      "title": "Short label shown on the canvas",\n' +
  '      "prompt": "what the model running this step is told (ai.* only)",\n' +
  '      "next": ["id of the step that runs after this one"],\n' +
  '      "fanOut": true | false,\n' +
  '      "maxItems": 8,\n' +
  '      "produces": { "category": "use-case", "relationToParent": "IMPLEMENTS" }\n' +
  '    }\n' +
  '  ]\n' +
  '}\n\n' +
  'Set "done" to false and leave "steps" empty while you are still asking. Set it to true when "steps" ' +
  'holds the whole design. Exactly one step must have nothing pointing at it — that is where a run starts. ' +
  '"fanOut" is true only on "ai.generate". Omit "produces" on a step that writes no page. ' +
  `"category" must be one of: ${DOCUMENT_CATEGORIES.join(', ')}. ` +
  `"relationToParent" is one of: ${AUTHORABLE_RELATION_TYPES.join(', ')}. ` +
  `At most ${MAX_STEPS} steps.`;

@Injectable()
export class WorkflowDraftService {
  private readonly logger = new Logger(WorkflowDraftService.name);

  constructor(
    private readonly agents: AgentRegistryService,
    private readonly client: AssistantClient,
    private readonly aiUsage: AiUsageService,
  ) {}

  async draft(dto: DraftWorkflowDto, principal: Principal): Promise<DraftWorkflowResponse> {
    const agent = await this.agents.resolve(dto.workspaceId, 'architect');
    // Not an error: a workspace with no provider still has the manual lane, and
    // the wizard says so rather than showing a failed request.
    if (!agent.enabled || !agent.config.enabled || agent.missing.length) {
      return { enabled: false, reply: '', graph: null, name: null, description: null, issues: [] };
    }
    await this.aiUsage.assertWithinBudget(dto.workspaceId, principal.userId);

    const raw = await this.client.chat(
      {
        config: agent.config,
        userId: principal.userId,
        operation: 'workflow',
        locale: principal.locale,
      },
      [
        { role: 'system', content: agent.instructions + RESPONSE_CONTRACT },
        ...this.turns(dto.messages, dto.graph ?? null),
      ],
      { json: true },
    );

    const parsed = safeJson(raw);
    const reply = typeof parsed?.reply === 'string' ? parsed.reply.trim() : '';
    const steps = this.readSteps(parsed);

    // "done" is the model's claim; an empty step list is the fact. Trusting the
    // flag alone hands the wizard a finished-looking proposal with nothing in it.
    if (!steps.length) {
      return {
        enabled: true,
        reply: reply || t('workflow.draft.needMore'),
        graph: null,
        name: null,
        description: null,
        issues: [],
      };
    }

    const graph: WorkflowGraph = { steps };
    const issues = validateGraph(graph);
    return {
      enabled: true,
      reply: reply || t('workflow.draft.designed'),
      graph,
      name: typeof parsed?.name === 'string' ? parsed.name.trim().slice(0, 120) || null : null,
      description:
        typeof parsed?.description === 'string' ? parsed.description.trim().slice(0, 500) || null : null,
      issues: localizeIssues(issues),
    };
  }

  /**
   * The transcript the model sees.
   *
   * The proposal currently on the operator's screen is replayed as the last
   * assistant turn rather than left implicit, so "make the second step wait for
   * a person" edits *that* graph. Without it the model re-derives a chain from
   * the conversation and quietly discards whatever the operator changed on the
   * canvas in between.
   */
  private turns(messages: WorkflowDraftMessage[], graph: WorkflowGraph | null) {
    const recent = messages.slice(-MAX_TURNS).map((m) => ({
      role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: String(m.content ?? '').slice(0, MAX_MESSAGE_CHARS),
    }));
    if (!graph?.steps?.length) return recent;
    const last = recent[recent.length - 1];
    const current = {
      role: 'assistant' as const,
      content: `The design currently on their canvas:\n${JSON.stringify({ steps: graph.steps })}`,
    };
    // Sits before the operator's newest message, which is what that message is
    // about.
    return last?.role === 'user' ? [...recent.slice(0, -1), current, last] : [...recent, current];
  }

  /**
   * Read the model's steps into the shape the compiler accepts.
   *
   * Everything is narrowed rather than trusted: an unknown kind, a category
   * this product does not have, a `next` pointing nowhere. `validateGraph` would
   * catch most of it and report it honestly, but a proposal whose problems are
   * all "the model wrote nonsense" teaches the operator nothing — dropping what
   * cannot be true and compiling the rest gives them something to edit.
   */
  private readSteps(parsed: Record<string, unknown> | null): WorkflowStep[] {
    const raw = Array.isArray(parsed?.steps) ? (parsed.steps as Array<Record<string, unknown>>) : [];
    const out: WorkflowStep[] = [];
    const seen = new Set<string>();

    for (const item of raw) {
      if (out.length >= MAX_STEPS) break;
      const kind = String(item?.kind ?? '');
      if (!KIND_SET.has(kind)) continue;
      const id = slug(String(item?.id ?? ''));
      if (!id || seen.has(id)) continue;
      const title = String(item?.title ?? '').trim().slice(0, 120);
      if (!title) continue;
      seen.add(id);

      const isAi = kind === 'ai.generate' || kind === 'ai.draft';
      const prompt = typeof item?.prompt === 'string' ? item.prompt.trim() : '';
      const produces = readProduces(item?.produces);

      out.push({
        id,
        kind: kind as WorkflowStep['kind'],
        title,
        next: Array.isArray(item?.next)
          ? [...new Set(item.next.filter((n): n is string => typeof n === 'string').map(slug))].filter(Boolean)
          : [],
        // Only ai.generate fans out, whatever the model claimed: the compiler
        // warns about the mismatch, and a `search` step marked fanOut would
        // make that warning the first thing the operator sees.
        fanOut: kind === 'ai.generate' && item?.fanOut !== false,
        // Never inherited from the model. Publishing without review is the
        // operator's decision, and a proposal that quietly took it would be
        // the one thing in this flow that cannot be undone by editing.
        autoApprove: false,
        ...(isAi ? { prompt: { user: prompt } } : {}),
        ...(produces ? { produces } : {}),
        ...(kind === 'ai.generate' ? { maxItems: clampItems(item?.maxItems) } : {}),
      });
    }

    // A `next` naming a step that was dropped would fail the compiler with an
    // error about the operator's graph rather than about our own filtering.
    const present = new Set(out.map((s) => s.id));
    return out.map((s) => ({ ...s, next: s.next.filter((n) => present.has(n) && n !== s.id) }));
  }
}

function readProduces(value: unknown): WorkflowStepProduces | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const category = String(record.category ?? '');
  if (!CATEGORY_SET.has(category)) return null;
  const relation = String(record.relationToParent ?? '');
  return {
    category: category as DocumentCategory,
    // A model that names an edge type the graph would refuse falls back rather
    // than stranding the run: `assertEdgeType` throws at materialize time, which
    // is hours later and after a person has already approved the draft.
    relationToParent: isAuthorableRelationType(relation) ? relation : 'IMPLEMENTS',
    // Feature 08's nesting: a produced page belongs under the page it came
    // from, which is what makes the chain legible in the tree afterwards.
    nestUnderParent: true,
  };
}

function clampItems(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 50) : 8;
}

/** The compiler's own id rule, applied before it can complain about it. */
function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    // A fenced block is the common failure of a model told to return JSON.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
