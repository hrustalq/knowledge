import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { AgentRun } from '@prisma/client';
import type {
  AgentFinding,
  AgentFindingKind,
  AuthorableRelationType,
  Locale,
  RelationInput,
} from '@knowledge/contracts';
import { AGENT_FINDING_KINDS, isAuthorableRelationType } from '@knowledge/contracts';
import { normalizeRelation } from '../common/relations.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GraphService } from '../graph/graph.service.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { AssistantClient } from '../assistant/assistant.client.js';
import { AssistantReadToolsService } from '../assistant/assistant-read-tools.service.js';
import { AgentRegistryService, type ResolvedAgent } from './agent-registry.service.js';
import { AiSkillsService } from '../ai/ai-skills.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { GlossaryService } from '../glossary/glossary.service.js';
import type { Principal } from '../auth/principal.js';

/**
 * Agents with a background executor. Exported so the API can refuse a run at
 * the point somebody asks for it, rather than accepting it and failing in the
 * worker a second later with nothing to show for the round trip.
 */
export const RUNNABLE_AGENTS = new Set(['curator', 'reviewer', 'glossarist', 'cartographer']);

/** How many pages the curator will look at in one pass. */
const MAX_PAGES = 60;
/** How many it will describe to the model — the rest are summarised as counts. */
const MAX_DESCRIBED = 30;
/** Pages the reviewer reads in one pass — one model call each, so this is the cost. */
const MAX_REVIEWED = 8;
/** How much of a page the reviewer is shown. */
const MAX_REVIEW_CHARS = 40_000;
/** Issues taken from one page, so a single bad page cannot fill the run. */
const MAX_ISSUES_PER_PAGE = 5;
/** Pages the glossarist scans in one pass — also one model call each. */
const MAX_GLOSSARY_PAGES = 15;
/** Findings kept from one run. A wall of findings is not a review, it is noise. */
const MAX_FINDINGS = 20;

export interface AgentRunResult {
  summary: string;
  findings: AgentFinding[];
}

/**
 * Runs a background agent (docs/features/20).
 *
 * The division of labour is the same one the rest of this codebase draws
 * between deterministic and inferred facts: what the database already knows —
 * which pages exist, which have no relations, when each last changed — is
 * gathered by query, and the model is spent only on the part that is genuinely
 * judgement. That keeps a run cheap, keeps its orphan findings exactly right,
 * and means a workspace with no model configured still gets the half of the
 * answer that never needed one.
 */
@Injectable()
export class AgentExecutor {
  private readonly logger = new Logger(AgentExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    private readonly registry: AgentRegistryService,
    private readonly client: AssistantClient,
    private readonly readTools: AssistantReadToolsService,
    private readonly skills: AiSkillsService,
    private readonly documents: DocumentsService,
    private readonly glossary: GlossaryService,
  ) {}

  /**
   * `principal` is the run's rehydrated owner, already authorised by the
   * processor. It is passed down rather than re-derived so an executor that
   * calls an API-shaped service (the glossarist calls the same `suggest` the
   * settings page calls) bills and authorises as that same person.
   */
  async run(run: AgentRun, agent: ResolvedAgent, principal: Principal): Promise<AgentRunResult> {
    switch (agent.key) {
      case 'curator':
        return this.curate(run, agent, principal);
      case 'reviewer':
        return this.review(run, agent, principal);
      case 'glossarist':
        return this.buildGlossary(run, principal);
      case 'cartographer':
        return this.mapRelations(run, agent, principal);
      default:
        // RUNNABLE_AGENTS is the API's copy of this switch; anything reaching
        // here got past that check, so failing loudly beats running an agent as
        // if it had done something.
        throw new Error(t('error.ai.agentNoExecutor', { key: agent.key }));
    }
  }

  private async curate(
    run: AgentRun,
    agent: ResolvedAgent,
    principal: Principal,
  ): Promise<AgentRunResult> {
    const documents = await this.prisma.document.findMany({
      where: { workspaceId: run.workspaceId },
      select: { id: true, title: true, category: true, projectId: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_PAGES,
    });
    if (documents.length === 0) {
      return { summary: t('agent.curation.noPages'), findings: [] };
    }

    // `documents` has no updatedAt — a page's age is the age of its newest
    // revision, which is the only date that means "when did this last change".
    // One grouped query over the bounded id set rather than a join per page.
    const latest = await this.prisma.documentRevision.groupBy({
      by: ['documentId'],
      where: { documentId: { in: documents.map((d) => d.id) } },
      _max: { createdAt: true },
    });
    const changedAt = new Map(latest.map((row) => [row.documentId, row._max.createdAt]));

    // Relation degree per page, straight from the graph. A page nothing points
    // at and which points at nothing is an orphan — that is a fact, not an
    // opinion, so it becomes a finding without asking a model.
    const degree = new Map<string, number>();
    try {
      const relations = await this.graph.getWorkspaceRelationGraph(run.workspaceId);
      for (const edge of relations.edges) {
        degree.set(edge.documentId, (degree.get(edge.documentId) ?? 0) + 1);
      }
    } catch (error) {
      // The graph store being unavailable must not sink the whole run; the
      // model half still works, it just loses the orphan check.
      this.logger.warn(`Curator could not read the relation graph: ${String(error)}`);
    }

    const findings: AgentFinding[] = [];
    const orphans = documents.filter((doc) => (degree.get(doc.id) ?? 0) === 0);
    for (const doc of orphans.slice(0, 10)) {
      findings.push({
        kind: 'orphan',
        severity: 'info',
        title: t('agent.curation.orphanTitle', { title: doc.title }),
        detail: t('agent.curation.orphanDetail'),
        documentIds: [doc.id],
        documentTitles: [doc.title],
      });
    }

    // The judgement half: duplicates, contradictions and gaps across the recent
    // set. Skipped entirely when no model is configured — the orphan findings
    // above are still worth returning.
    let summary = t('agent.curation.summary', { pages: documents.length, orphans: orphans.length });
    // 'tools' is a preference, not a prerequisite — see the cartographer's note.
    const blocking = agent.missing.filter((capability) => capability !== 'tools');
    if (agent.config.enabled && blocking.length === 0) {
      const described = documents.slice(0, MAX_DESCRIBED);
      const listing = described
        .map((d) => {
          const when = changedAt.get(d.id);
          return `- ${d.id} | ${d.category ?? 'other'} | ${d.title} | last changed ${
            when ? when.toISOString().slice(0, 10) : 'never'
          }`;
        })
        .join('\n');
      try {
        const call = {
          config: agent.config,
          userId: run.createdBy,
          operation: 'agent' as const,
          locale: run.locale as Locale,
        };
        const messages: ChatCompletionMessageParam[] = [
          {
            role: 'system',
            // The agent's own skillIds, rendered through the same service the
            // chat turn uses. A background agent references skills exactly as
            // a conversational one does; there is no trigger message here, so
            // only what the agent explicitly names applies.
            content:
              `${agent.instructions}\n\n${OUTPUT_CONTRACT}` +
              this.skills.renderPrompt(await this.skills.forTurn(run.workspaceId, '', agent.skillIds)),
          },
          {
            role: 'user',
            content:
              (run.input && typeof (run.input as { note?: string }).note === 'string'
                ? `Extra instructions: ${(run.input as { note?: string }).note}\n\n`
                : '') +
              `Pages in this workspace (id | category | title | last updated):\n${listing}`,
          },
        ];

        // Titles and dates can suggest a duplicate; only the prose can confirm
        // one. With the read tools the curator can open both pages before
        // asserting a conflict — the single-shot call stays for models that
        // cannot call tools. jsonFinalRound, not `json: true`: response_format
        // suppresses tool calls, so the contract applies to the last round only.
        const raw = agent.missing.includes('tools')
          ? await this.client.chat(call, messages, { json: true })
          : (
              await this.client.runWithTools(
                call,
                messages,
                this.readTools.definitions(),
                (name, args) =>
                  this.readTools.execute(name, args, { principal, workspaceId: run.workspaceId }),
                { jsonFinalRound: true },
              )
            ).content;
        const parsed = safeJson(raw);
        const proposals = Array.isArray(parsed?.findings) ? (parsed.findings as unknown[]) : [];
        const known = new Map(documents.map((d) => [d.id, d.title]));
        for (const proposal of proposals) {
          const finding = this.readFinding(proposal, known);
          if (!finding) continue; // ungrounded or malformed — dropped, never shown
          findings.push(finding);
          if (findings.length >= MAX_FINDINGS) break;
        }
        if (typeof parsed?.summary === 'string' && parsed.summary.trim()) {
          summary = parsed.summary.trim().slice(0, 2_000);
        }
      } catch (error) {
        // A flaky model must not lose the deterministic findings already made.
        this.logger.warn(`Curator model pass failed: ${String(error)}`);
        summary += ' The model pass failed, so only structural findings are included.';
      }
    }

    return { summary, findings: findings.slice(0, MAX_FINDINGS) };
  }

  // ------------------------------------------------------------------ reviewer

  /**
   * Reviews the pages that changed most recently, one model call each.
   *
   * The same division of labour as the curator: *which* pages changed is a
   * query, so the worker answers it, and the model is spent only on reading
   * them. Naturally bounded by `take` — a review pass is per page, so the cost
   * is linear and the cap is the budget.
   */
  private async review(run: AgentRun, agent: ResolvedAgent, principal: Principal): Promise<AgentRunResult> {
    if (!agent.config.enabled || agent.missing.length > 0) {
      throw new Error('The model routed at the reviewer cannot run it.');
    }

    // Newest revision first, then back to the page — "recently changed" is a
    // fact about revisions, and `documents` carries no updatedAt.
    const recent = await this.prisma.documentRevision.findMany({
      where: { document: { workspaceId: run.workspaceId }, status: 'indexed' },
      distinct: ['documentId'],
      orderBy: { createdAt: 'desc' },
      select: { documentId: true, createdAt: true },
      take: MAX_REVIEWED,
    });
    if (recent.length === 0) return { summary: 'No indexed pages to review yet.', findings: [] };

    const documents = await this.prisma.document.findMany({
      where: { id: { in: recent.map((r) => r.documentId) } },
      select: { id: true, title: true },
    });
    const byId = new Map(documents.map((d) => [d.id, d]));
    const skillText = this.skills.renderPrompt(
      await this.skills.forTurn(run.workspaceId, '', agent.skillIds),
    );

    const findings: AgentFinding[] = [];
    let reviewed = 0;
    for (const row of recent) {
      if (findings.length >= MAX_FINDINGS) break;
      const doc = byId.get(row.documentId);
      if (!doc) continue;
      const content = await this.documents.getContent(doc.id).catch(() => null);
      if (!content || !content.markdown.trim()) continue;

      try {
        const raw = await this.client.chat(
          {
            config: agent.config,
            userId: principal.userId,
            operation: 'agent',
            locale: run.locale as Locale,
          },
          [
            { role: 'system', content: agent.instructions + skillText },
            {
              role: 'user',
              content: `Title: ${doc.title}\n\nPage:\n\n${content.markdown.slice(0, MAX_REVIEW_CHARS)}`,
            },
          ],
          { json: true },
        );
        reviewed++;
        for (const finding of this.readIssues(raw, doc)) {
          findings.push(finding);
          if (findings.length >= MAX_FINDINGS) break;
        }
      } catch (error) {
        // One unreadable page must not lose the pages already reviewed.
        this.logger.warn(`Reviewer could not review "${doc.title}": ${String(error)}`);
      }
    }

    return {
      summary:
        reviewed === 0
          ? 'No page could be reviewed in this pass.'
          : `Reviewed ${reviewed} recently changed page(s) and found ${findings.length} issue(s).`,
      findings,
    };
  }

  /**
   * The reviewer speaks in `issues`, not findings — it is the same prompt the
   * editor's review panel uses, and rewriting it for the background would give
   * one agent two voices. Translated here instead; severity maps across, and
   * the citation is the page under review, so a finding is never uncited.
   */
  private readIssues(raw: string, doc: { id: string; title: string }): AgentFinding[] {
    const parsed = safeJson(raw);
    const issues = Array.isArray(parsed?.issues) ? (parsed.issues as unknown[]) : [];
    const out: AgentFinding[] = [];
    for (const entry of issues) {
      if (!entry || typeof entry !== 'object') continue;
      const issue = entry as Record<string, unknown>;
      const message = typeof issue.message === 'string' ? issue.message.trim() : '';
      if (!message) continue;
      const section = typeof issue.section === 'string' && issue.section.trim() ? issue.section.trim() : null;
      out.push({
        kind: 'other',
        severity: issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info',
        title: `${doc.title}${section ? ` — ${section}` : ''}`,
        detail: message.slice(0, 2_000),
        documentIds: [doc.id],
        documentTitles: [doc.title],
      });
      if (out.length >= MAX_ISSUES_PER_PAGE) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- glossarist

  /**
   * Proposes glossary terms across the workspace's pages.
   *
   * This calls the very `GlossaryService.suggest` the settings page calls,
   * which is why GlossaryCoreModule exists: the prompt, the occurrence check
   * that drops ungrounded terms, and the "already defined in this project"
   * lookup are one implementation, not two. Terms are proposed as findings —
   * nothing is written to the glossary, exactly as a background agent never
   * writes.
   */
  private async buildGlossary(run: AgentRun, principal: Principal): Promise<AgentRunResult> {
    const documents = await this.prisma.document.findMany({
      where: { workspaceId: run.workspaceId },
      select: { id: true, title: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_GLOSSARY_PAGES,
    });
    if (documents.length === 0) return { summary: t('agent.curation.noPages'), findings: [] };

    const findings: AgentFinding[] = [];
    // Proposed once per run: the same term found on four pages is one entry to
    // add, and four findings saying so is a wall, not a review.
    const seen = new Set<string>();
    let scanned = 0;

    for (const doc of documents) {
      if (findings.length >= MAX_FINDINGS) break;
      try {
        const res = await this.glossary.suggest(
          { workspaceId: run.workspaceId, documentId: doc.id, title: doc.title },
          principal,
        );
        // The provider is off for this workspace — every later page would say
        // the same, so stop rather than making the same failed call per page.
        if (!res.enabled) {
          return { summary: 'The AI assistant is disabled for this workspace.', findings };
        }
        scanned++;
        for (const s of res.suggestions) {
          // Already in the glossary: proposing it again is noise.
          if (s.existingTermId) continue;
          const key = s.term.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            kind: 'gap',
            severity: 'info',
            title: s.term,
            detail: `${s.definition}\n\nSeen ${s.occurrences}× on "${doc.title}".${
              s.aliases.length ? ` Aliases: ${s.aliases.join(', ')}.` : ''
            }`,
            documentIds: [doc.id],
            documentTitles: [doc.title],
          });
          if (findings.length >= MAX_FINDINGS) break;
        }
      } catch (error) {
        // A budget refusal is terminal — every later page would hit it too.
        // Matched on the status, not the message: the message is localized
        // (docs/features/18), so a text match would only work in English.
        if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
          return { summary: `Stopped after ${scanned} page(s): the workspace AI budget is spent.`, findings };
        }
        this.logger.warn(`Glossarist could not scan "${doc.title}": ${String(error)}`);
      }
    }

    return {
      summary:
        findings.length === 0
          ? `Scanned ${scanned} page(s); every term they use is already defined.`
          : `Scanned ${scanned} page(s) and proposes ${findings.length} new term(s).`,
      findings,
    };
  }

  // ------------------------------------------------------------- cartographer

  /**
   * Proposes the relations pages should declare (docs/features/28).
   *
   * The curator's division of labour, applied to edges. One thing here is a
   * query rather than a judgement, and it is the sharpest finding this agent
   * makes: an `inferred` edge that the page does not declare. A model read that
   * connection out of the text at some point, nobody ever confirmed it, and it
   * is replaced wholesale on the next re-index — so it is a claim the graph
   * carries and the page does not. Declaring it is a mechanical fix, and the
   * finding carries the exact relations to declare.
   *
   * The model is spent only on the genuinely uncertain half: which connection a
   * page's text supports that nothing has spotted at all.
   *
   * Nothing here writes. `AgentFindingsService.applyRelations` turns a finding
   * into a frontmatter merge request on the API side, where a person exists.
   */
  private async mapRelations(
    run: AgentRun,
    agent: ResolvedAgent,
    principal: Principal,
  ): Promise<AgentRunResult> {
    const documents = await this.prisma.document.findMany({
      where: { workspaceId: run.workspaceId },
      select: { id: true, title: true, category: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_PAGES,
    });
    if (documents.length === 0) return { summary: t('agent.cartography.noPages'), findings: [] };

    const known = new Map(documents.map((d) => [d.id, d.title]));
    const declared = new Map<string, Set<string>>();
    const unconfirmed = new Map<string, Array<{ type: AuthorableRelationType; targetKey: string }>>();
    const entityNames = new Map<string, string>();
    let graphReadable = true;

    try {
      const graph = await this.graph.getWorkspaceRelationGraph(run.workspaceId);
      for (const [key, entity] of Object.entries(graph.entities)) entityNames.set(key, entity.name);
      for (const edge of graph.edges) {
        if (!known.has(edge.documentId)) continue;
        if (edge.extractor === 'inferred') {
          // Only what a page could actually declare. A TAGGED_WITH edge is
          // synthesised from `tags:`, so proposing it as a relation is not a fix
          // anyone could apply.
          if (!isAuthorableRelationType(edge.type)) continue;
          const list = unconfirmed.get(edge.documentId) ?? [];
          list.push({ type: edge.type, targetKey: edge.targetKey });
          unconfirmed.set(edge.documentId, list);
        } else {
          const set = declared.get(edge.documentId) ?? new Set<string>();
          set.add(`${edge.type} ${edge.targetKey}`);
          declared.set(edge.documentId, set);
        }
      }
    } catch (error) {
      // Same accommodation the curator makes: the graph store being down must
      // not sink the run, it just loses the deterministic half.
      graphReadable = false;
      this.logger.warn(`Cartographer could not read the relation graph: ${String(error)}`);
    }

    const findings: AgentFinding[] = [];
    for (const [documentId, edges] of unconfirmed) {
      if (findings.length >= MAX_FINDINGS) break;
      const already = declared.get(documentId) ?? new Set<string>();
      const missing = edges.filter((e) => !already.has(`${e.type} ${e.targetKey}`));
      if (missing.length === 0) continue;

      const title = known.get(documentId) ?? documentId;
      findings.push({
        kind: 'relation',
        severity: 'info',
        title: t('agent.cartography.unconfirmedTitle', { title, count: missing.length }),
        detail: t('agent.cartography.unconfirmedDetail', {
          list: missing.map((m) => `${m.type} ${m.targetKey}`).join(', '),
        }),
        documentIds: [documentId],
        documentTitles: [title],
        relations: missing.map((m) => ({
          type: m.type,
          target: {
            key: m.targetKey,
            type: m.targetKey.includes(':') ? m.targetKey.slice(0, m.targetKey.indexOf(':')) : 'entity',
            name: entityNames.get(m.targetKey) ?? m.targetKey,
          },
        })),
      });
    }

    let summary = t('agent.cartography.summary', { pages: documents.length, found: findings.length });
    // 'tools' is a preference, not a prerequisite: a model without tool support
    // still does useful work here from the listing alone, so it must not block
    // the model half the way a genuinely missing capability (json) does.
    const blocking = agent.missing.filter((capability) => capability !== 'tools');
    if (agent.config.enabled && blocking.length === 0 && findings.length < MAX_FINDINGS) {
      const listing = documents
        .slice(0, MAX_DESCRIBED)
        .map((d) => {
          const rels = [...(declared.get(d.id) ?? [])];
          return `- ${d.id} | ${d.category ?? 'other'} | ${d.title} | declares: ${
            rels.length ? rels.join('; ') : 'nothing'
          }`;
        })
        .join('\n');

      try {
        const call = {
          config: agent.config,
          userId: run.createdBy,
          operation: 'agent' as const,
          locale: run.locale as Locale,
        };
        const messages: ChatCompletionMessageParam[] = [
          {
            role: 'system',
            content:
              `${agent.instructions}\n\n${RELATION_OUTPUT_CONTRACT}` +
              this.skills.renderPrompt(await this.skills.forTurn(run.workspaceId, '', agent.skillIds)),
          },
          {
            role: 'user',
            content:
              (run.input && typeof (run.input as { note?: string }).note === 'string'
                ? `Extra instructions: ${(run.input as { note?: string }).note}\n\n`
                : '') +
              `Pages in this workspace (id | category | title | relations it already declares):\n${listing}`,
          },
        ];

        // The listing says what each page DECLARES; whether a connection is real
        // is in the prose, which this agent could never open. With the read
        // tools it can search, read and walk the graph before proposing — the
        // single-shot call below stays for models that cannot call tools.
        //
        // jsonFinalRound rather than `json: true`: response_format suppresses
        // tool calls, so the JSON contract can only be applied on the last,
        // toolless round.
        const raw = agent.missing.includes('tools')
          ? await this.client.chat(call, messages, { json: true })
          : (
              await this.client.runWithTools(
                call,
                messages,
                this.readTools.definitions(),
                (name, args) =>
                  this.readTools.execute(name, args, { principal, workspaceId: run.workspaceId }),
                { jsonFinalRound: true },
              )
            ).content;

        const parsed = safeJson(raw);
        for (const proposal of Array.isArray(parsed?.findings) ? (parsed.findings as unknown[]) : []) {
          const finding = this.readRelationFinding(proposal, known);
          if (!finding) continue;
          findings.push(finding);
          if (findings.length >= MAX_FINDINGS) break;
        }
        if (typeof parsed?.summary === 'string' && parsed.summary.trim()) {
          summary = parsed.summary.trim().slice(0, 2_000);
        }
      } catch (error) {
        this.logger.warn(`Cartographer model pass failed: ${String(error)}`);
      }
    }

    if (!graphReadable) summary += ` ${t('agent.cartography.graphUnavailable')}`;
    return { summary, findings: findings.slice(0, MAX_FINDINGS) };
  }

  /**
   * A relation finding must carry relations that survive the allowlist, on top
   * of citing a page that exists.
   *
   * One without any is a prose opinion about the graph: nothing downstream can
   * apply it, and the Apply button would be offered for something that cannot
   * be applied. Dropped, exactly as an uncited finding is.
   */
  private readRelationFinding(value: unknown, known: Map<string, string>): AgentFinding | null {
    const base = this.readFinding(value, known);
    if (!base) return null;

    const raw = value as Record<string, unknown>;
    const relations: RelationInput[] = [];
    for (const entry of Array.isArray(raw.relations) ? raw.relations : []) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const normalized = normalizeRelation({ type: e.type, target: e.target ?? e.targetKey });
      if (normalized) relations.push({ type: normalized.type, target: normalized.target });
    }
    if (relations.length === 0) return null;

    return { ...base, kind: 'relation', relations };
  }

  /**
   * A finding survives only if it cites pages that actually exist in this
   * workspace (plan.md §12.7: source-backed citations, never a bare LLM
   * answer). A model that invents a page id is describing a page that is not
   * there, and everything it says about it is worth exactly nothing.
   */
  private readFinding(value: unknown, known: Map<string, string>): AgentFinding | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const detail = typeof raw.detail === 'string' ? raw.detail.trim() : '';
    if (!title || !detail) return null;

    const ids = Array.isArray(raw.documentIds)
      ? raw.documentIds.filter((id): id is string => typeof id === 'string' && known.has(id))
      : [];
    if (ids.length === 0) return null;

    const kind = AGENT_FINDING_KINDS.includes(raw.kind as AgentFindingKind)
      ? (raw.kind as AgentFindingKind)
      : 'other';
    const severity =
      raw.severity === 'error' || raw.severity === 'warning' || raw.severity === 'info'
        ? raw.severity
        : 'info';

    return {
      kind,
      severity,
      title: title.slice(0, 300),
      detail: detail.slice(0, 2_000),
      documentIds: ids,
      documentTitles: ids.map((id) => known.get(id) ?? id),
    };
  }
}

const RELATION_OUTPUT_CONTRACT =
  'Respond ONLY with a json object of the shape ' +
  '{"summary": string, "findings": [{"kind": "relation", "severity": "info"|"warning", "title": string, ' +
  '"detail": string, "documentIds": string[], "relations": [{"type": string, "targetKey": string}]}]}. ' +
  'Every finding MUST cite at least one page id from the list, copied exactly, and the FIRST id is the page ' +
  'whose frontmatter would gain the relations. Every finding MUST carry at least one relation; a finding ' +
  'with none is dropped. Do not propose a relation the page already declares — they are listed beside it. ' +
  'You are looking at titles, categories and existing relations only: propose a connection where those give ' +
  'you real grounds, and leave it out otherwise. At most 12 findings; returning none is a valid answer.';

const OUTPUT_CONTRACT =
  'Respond ONLY with a json object of the shape ' +
  '{"summary": string, "findings": [{"kind": "duplicate"|"contradiction"|"gap"|"stale"|"other", ' +
  '"severity": "info"|"warning"|"error", "title": string, "detail": string, "documentIds": string[]}]}. ' +
  'Every finding MUST cite at least one page id from the list, copied exactly. ' +
  'A finding you cannot tie to a listed page must be left out. ' +
  'You are looking at titles and dates only — say what they suggest, and never assert what a page ' +
  'contains as though you had read it. At most 12 findings; returning none is a valid answer.';

/** Fence-tolerant parse, matching the leniency of every other JSON call site here. */
function safeJson(raw: string): Record<string, unknown> | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}
