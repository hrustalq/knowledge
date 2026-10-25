import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CaptureOrigin, CaptureSession, ChatPlatformKind, ConnectorKind, CreateCaptureRequest } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Principal } from '../auth/principal.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { DecisionClient } from '../assistant/decision.client.js';
import { AiConfigService } from '../ai/ai-config.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { CaptureService } from '../captures/capture.service.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { countOccurrences, safeJson } from '../glossary/glossary.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { SearchService } from '../search/search.service.js';
import type { ChatThread } from './adapters/chat-adapter.types.js';
import { createMasker } from './harvest-mask.js';

/** Captures one harvest may propose; the rest of what the model returns is dropped. */
const MAX_PROPOSALS = 8;
/** Pages searched for an answer to cite. */
const MAX_PAGES = 8;
/** The thread as a search query: the start of it is what it is about. */
const QUERY_CHARS = 2_000;
const SNIPPET_CHARS = 300;
const HOUR_MS = 3_600_000;
const SESSION: CaptureSession = { client: 'chat' };

/** The decision model's question for a thread (#530), as measured in docs/features/67. */
const SETTLES_QUESTION = {
  instructions: 'Did this team chat thread settle something that belongs in the team knowledge base?',
  criteria: {
    true: 'The thread itself states a decision taken, a gotcha somebody hit, a convention agreed, steps that worked, a term defined, or a question answered.',
    false: 'The thread holds only opinions, open questions, plans not agreed, or chatter.',
  },
};

/** A refusal with something to tell the person, as a message key. */
export class HarvestRefused extends Error {
  constructor(readonly key: string) {
    super(key);
  }
}

export interface HarvestInput {
  workspaceId: string;
  /** The group's project; null in a DM, where the workspace's first is used. */
  projectId: string | null;
  /** A chat platform, or a harvest connector's kind (#382). */
  platform: ChatPlatformKind | ConnectorKind;
  chatTitle: string | null;
  thread: ChatThread;
}

export interface HarvestOutcome {
  proposed: number;
  duplicates: number;
  /** Proposals validation or the capture path refused. Never named to the chat. */
  dropped: number;
}

/** What the validated proposals become, before any of them is written. */
export interface HarvestPlan {
  requests: CreateCaptureRequest[];
  dropped: number;
}

/**
 * Harvesting a chat thread into captures (#82): mask it, ask the `harvester`
 * what it settled, check every proposal here — never in the prompt — and hand
 * each survivor to `CaptureService.capture` as the person who asked. Chat is
 * read once and never stored or indexed; what lands is a capture with a
 * server-set {@link CaptureOrigin}, reviewed like any other.
 *
 * API-side, because a capture is attributed to a person ("the worker
 * generates, the API publishes"). The chat glue — who may ask, the reply —
 * is `ChatAnswersService`'s; this is the part a Telegram thread (phase 3)
 * reuses unchanged.
 */
@Injectable()
export class HarvestService {
  private readonly logger = new Logger(HarvestService.name);
  private readonly ratePerHour: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentRegistryService,
    private readonly client: AssistantClient,
    private readonly aiConfig: AiConfigService,
    private readonly aiUsage: AiUsageService,
    private readonly captures: CaptureService,
    private readonly permissions: PermissionService,
    private readonly search: SearchService,
    config: ConfigService<Env, true>,
    private readonly decision: DecisionClient,
  ) {
    this.ratePerHour = config.get('HARVEST_RATE_PER_HOUR', { infer: true });
  }

  async harvest(input: HarvestInput, principal: Principal): Promise<HarvestOutcome> {
    const { workspaceId, thread } = input;
    if (!thread.messages.length) throw new HarvestRefused('chat.harvest.empty');
    if (!(await this.aiConfig.captureSettings(workspaceId)).enabled.effective) throw new HarvestRefused('chat.capture.capturesOff');
    // Counted from the spend itself: a harvest is one `harvest` usage row
    // from the harvester. The decision model's row (#530) is not counted — a
    // thread it turns away costs a fraction of one and proposes nothing.
    const recent = await this.prisma.aiUsage.count({
      where: {
        userId: principal.userId,
        operation: 'harvest',
        createdAt: { gt: new Date(Date.now() - HOUR_MS) },
        NOT: { model: { startsWith: 'jev' } },
      },
    });
    if (recent >= this.ratePerHour) throw new HarvestRefused('chat.harvest.rateLimited');
    const agent = await this.agents.resolve(workspaceId, 'harvester');
    if (!agent.enabled || !agent.config.enabled) throw new HarvestRefused('chat.capture.disabled');
    await this.aiUsage.assertWithinBudget(workspaceId, principal.userId);
    const projectId = input.projectId ?? (await this.firstProject(workspaceId));

    const transcript = maskedTranscript(thread);
    if (!(await this.settlesSomething(workspaceId, transcript, principal))) return { proposed: 0, duplicates: 0, dropped: 0 };
    const pages = await this.pagesFor(workspaceId, transcript, principal);
    const raw = await this.client.chat(
      { config: agent.config, userId: principal.userId, operation: 'harvest', locale: principal.locale },
      [
        { role: 'system', content: `${agent.instructions} At most ${MAX_PROPOSALS} captures.` },
        {
          role: 'user',
          content:
            `Knowledge-base pages an answer may cite:\n${pages.prompt || '(none)'}\n\n` +
            `Thread:\n${wrapUntrusted(transcript, 'harvest', 'chat')}`,
        },
      ],
      { json: true },
    );

    const plan = planCaptures(safeJson(raw), { workspaceId, projectId, transcript, pages: pages.byLabel });
    const outcome: HarvestOutcome = { proposed: 0, duplicates: 0, dropped: plan.dropped };
    const origin: CaptureOrigin = {
      platform: input.platform,
      chatTitle: input.chatTitle,
      ...(thread.url ? { threadUrl: thread.url } : {}),
      from: thread.messages[0]!.at.toISOString(),
      to: thread.messages[thread.messages.length - 1]!.at.toISOString(),
    };
    for (const req of plan.requests) {
      try {
        const result = await this.captures.capture(req, principal, { origin });
        if (result.state === 'duplicate') outcome.duplicates++;
        else if (result.state === 'failed') outcome.dropped++;
        else outcome.proposed++;
      } catch (err) {
        // Too long, over the capture rate, a page gone since the search: one proposal, not the harvest.
        this.logger.warn({ msg: 'harvest capture refused', workspaceId, kind: req.kind, error: String(err) });
        outcome.dropped++;
      }
    }
    return outcome;
  }

  /**
   * With a decision route (#530), Jev first: a thread it puts below the harvest
   * threshold settled nothing, and gets the reply an empty harvest gets without
   * the harvester's call. Fail-open: no route, or a failed question, harvests
   * as before. Only the masked thread is sent.
   */
  private async settlesSomething(workspaceId: string, transcript: string, principal: Principal): Promise<boolean> {
    const route = await this.decision.routeFor(workspaceId);
    if (!route) return true;
    try {
      const p = await this.decision.noul(
        { route, userId: principal.userId, operation: 'harvest' },
        { thread: wrapUntrusted(transcript, 'harvest', 'chat') },
        SETTLES_QUESTION,
      );
      return p >= route.thresholds.harvest;
    } catch (err) {
      this.logger.warn({ msg: 'harvest decision failed; harvesting anyway', workspaceId, error: String(err) });
      return true;
    }
  }

  /**
   * The pages an answer may cite: a search over the masked thread under the
   * asker's own scope, labelled P1…Pn. The model sees labels, never ids, and
   * a label the search did not hand out cites nothing.
   */
  private async pagesFor(
    workspaceId: string,
    transcript: string,
    principal: Principal,
  ): Promise<{ prompt: string; byLabel: Map<string, string> }> {
    const byLabel = new Map<string, string>();
    try {
      const scope = await this.permissions.scopeFor(principal, workspaceId);
      const res = await this.search.search({ workspaceId, query: transcript.slice(0, QUERY_CHARS), mode: 'hybrid', limit: MAX_PAGES * 2 }, scope);
      const lines: string[] = [];
      for (const hit of res.results) {
        if ([...byLabel.values()].includes(hit.documentId)) continue;
        const label = `P${byLabel.size + 1}`;
        byLabel.set(label, hit.documentId);
        lines.push(`${label}: ${hit.title}\n${hit.snippet.slice(0, SNIPPET_CHARS)}`);
        if (byLabel.size >= MAX_PAGES) break;
      }
      return { prompt: lines.length ? wrapUntrusted(lines.join('\n\n'), 'harvest', 'page') : '', byLabel };
    } catch (err) {
      // No search, no citable page: answers are dropped, everything else still stands.
      this.logger.warn({ msg: 'harvest search failed', workspaceId, error: String(err) });
      return { prompt: '', byLabel };
    }
  }

  private async firstProject(workspaceId: string): Promise<string> {
    const first = await this.prisma.project.findFirst({ where: { workspaceId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!first) throw new HarvestRefused('chat.capture.noProject');
    return first.id;
  }
}

/**
 * The thread as the harvester reads it: one masker for the whole thread, so a
 * placeholder means the same value in every message, and authors as
 * "Person 1", "Person 2" in order of first appearance — the model needs to
 * tell speakers apart, never who they are.
 */
export function maskedTranscript(thread: ChatThread): string {
  const mask = createMasker();
  const people = new Map<string, number>();
  return thread.messages
    .map((m) => {
      if (!people.has(m.authorId)) people.set(m.authorId, people.size + 1);
      return `Person ${people.get(m.authorId)}: ${mask(m.text)}`;
    })
    .join('\n\n');
}

/**
 * The model's proposals as capture requests, each checked against what the
 * harvest itself knows: a glossary term (and each alias) appears verbatim in
 * the masked thread, an answer cites at least one page label the search
 * handed out. Anything else — an unknown kind, a missing field, one past the
 * cap — is dropped and counted. A credential shape is `CaptureService`'s to
 * refuse (`findSecret`), before it writes a row; the harvest counts it dropped.
 */
export function planCaptures(
  parsed: Record<string, unknown> | null,
  ctx: { workspaceId: string; projectId: string; transcript: string; pages: ReadonlyMap<string, string> },
): HarvestPlan {
  const items = Array.isArray(parsed?.captures) ? (parsed.captures as unknown[]) : [];
  const requests: CreateCaptureRequest[] = [];
  let dropped = 0;
  for (const item of items) {
    const req = requests.length < MAX_PROPOSALS ? toRequest(item, ctx) : null;
    if (req) requests.push(req);
    else dropped++;
  }
  return { requests, dropped };
}

function toRequest(
  item: unknown,
  ctx: { workspaceId: string; projectId: string; transcript: string; pages: ReadonlyMap<string, string> },
): CreateCaptureRequest | null {
  if (!item || typeof item !== 'object') return null;
  const p = item as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string).trim() : '');
  const list = (k: string) => (Array.isArray(p[k]) ? (p[k] as unknown[]).filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim()) : []);
  const base = { workspaceId: ctx.workspaceId, projectId: ctx.projectId, session: SESSION };
  switch (p.kind) {
    case 'decision': {
      const [title, context, decision] = [str('title'), str('context'), str('decision')];
      if (!title || !context || !decision) return null;
      const alternatives = list('alternatives');
      return {
        ...base,
        kind: 'decision',
        title,
        context,
        decision,
        ...(str('consequences') ? { consequences: str('consequences') } : {}),
        ...(alternatives.length ? { alternatives } : {}),
      };
    }
    case 'gotcha':
    case 'convention':
    case 'howto': {
      const [title, body] = [str('title'), str('body')];
      return title && body ? { ...base, kind: p.kind, title, body } : null;
    }
    case 'glossary': {
      const [term, definition] = [str('term'), str('definition')];
      if (!term || !definition || !countOccurrences(ctx.transcript, term)) return null;
      const aliases = list('aliases').filter((a) => countOccurrences(ctx.transcript, a));
      return { ...base, kind: 'glossary', term, definition, ...(aliases.length ? { aliases } : {}) };
    }
    case 'answer': {
      const [question, answer] = [str('question'), str('answer')];
      const cited = [...new Set(list('pages').map((l) => ctx.pages.get(l.toUpperCase())).filter((id): id is string => !!id))];
      return question && answer && cited.length ? { ...base, kind: 'answer', question, answer, citedDocumentIds: cited } : null;
    }
    default:
      return null;
  }
}

