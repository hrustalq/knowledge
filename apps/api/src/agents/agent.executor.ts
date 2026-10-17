import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentRun } from '@prisma/client';
import type {
  AgentFinding,
  AgentFindingKind,
  AgentRunDetails,
  AgentRunComponent,
  AgentRunInput,
  AgentRunPullRequest,
  AnswerSignalKind,
  ApiDriftSpec,
  AnswerSurface,
  AssistantWebSource,
  AuthorableRelationType,
  Locale,
  RelationInput,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { AGENT_FINDING_KINDS, AGENT_RUN_MAX_DOCUMENTS, builtInTemplateRef, isAuthorableRelationType } from '@knowledge/contracts';
import { normalizeRelation } from '../common/relations.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GraphService } from '../graph/graph.service.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { AssistantClient, ProviderAccountError } from '../assistant/assistant.client.js';
import { AssistantReadToolsService } from '../assistant/assistant-read-tools.service.js';
import { CODE_TOOLS } from '../assistant/assistant-tool-types.js';
import { CodeResearchService } from '../connectors/code-research/code-research.service.js';
import { RepoSnapshotService } from '../connectors/code-research/repo-snapshot.service.js';
import { PullRequestService } from '../connectors/code-research/pull-request.service.js';
import { ApiDriftService, type ApiDriftResult } from '../connectors/code-research/api-drift.service.js';
import { ComponentUsagesService, type ChangeImpact } from '../components/component-usages.service.js';
import { declaredPathFixes } from '../components/component-match.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { SearchService } from '../search/search.service.js';
import { visibilityWhere, WORKSPACE_AUDIENCE, type AccessScope } from '../permissions/access-scope.js';
import { PermissionService } from '../permissions/permission.service.js';
import { AgentRegistryService, type ResolvedAgent } from './agent-registry.service.js';
import { runCodeReadingLoop } from './code-reading-loop.js';
import { AiSkillsService } from '../ai/ai-skills.service.js';
import { AgentLearningsService } from '../ai/agent-learnings.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { GlossaryService } from '../glossary/glossary.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { composeFrontmatter } from '../common/frontmatter.js';
import type { Principal } from '../auth/principal.js';
import {
  CODE_OUTPUT_CONTRACT,
  DIGEST_CONTRACT,
  MAX_CANDIDATE_FILES,
  MAX_DIGEST_INPUT_CHARS,
  MAX_FINDINGS_PER_FILE,
  MAX_PREVIEW_CHARS,
  MAX_RANKED_FILES,
  digestInput,
  headingDigest,
  declaredText,
  isCovered,
  isWikiCovered,
  wikiModulePaths,
  rankCandidates,
  readExcavation,
  selectRepoDocs,
  type Candidate,
} from './archaeology.js';
import { COMPONENT_DRAFT_CONTRACT, componentFrontmatter, componentPreviews, readComponentDraft } from './component-draft.js';
import {
  DRIFT_OUTPUT_CONTRACT,
  MAX_DIFF_CHARS,
  MAX_DRIFT_PAGES,
  MAX_PAGE_CHARS,
  MAX_SEARCHED_PAGES,
  affectedUsagesDetails,
  componentPathFinding,
  diffExcerpt,
  listOf,
  linkedCandidates,
  mentionedFiles,
  readDriftVerdict,
  readReportVerdict,
  reportJudgementPrompt,
  REPORT_OUTPUT_CONTRACT,
  scopeFiles,
  searchQueryFor,
  subdirOf,
  type DriftCandidate,
} from './drift.js';
import { apiDriftFinding, apiDriftPromptNote } from './api-drift.js';
import { LINT_TEXT_MAX, enabledRules, lintMessages, readLintViolations } from './lint.js';
import { changedText, styleFindings } from '../documents/lint/lint-check.js';
import { CompareService } from '../documents/compare.service.js';
import { readEvidence } from '../feedback/knowledge-issues.service.js';
import {
  COVERAGE_OUTPUT_CONTRACT,
  EMBED_BATCH,
  MAX_CLUSTERS,
  citedIdsOf,
  clusterSignals,
  coverageOf,
  coveragePrompt,
  normalizeQuestion,
  questionKey,
  readCoverageVerdict,
  type CoverageSignal,
} from './coverage.js';
import {
  DIGEST_OUTPUT_CONTRACT,
  MAX_DIGEST_MERGES,
  MAX_DIGEST_PAGES,
  digestKnown,
  digestListing,
  digestMarkdown,
  digestSince,
  highlightFinding,
  isQuietDigest,
  isoDay,
  readDigestHighlights,
  type DigestFacts,
  type DigestHighlight,
} from './digest.js';

/**
 * Agents with a background executor. Exported so the API can refuse a run at
 * the point somebody asks for it, rather than accepting it and failing in the
 * worker a second later with nothing to show for the round trip.
 */
export const RUNNABLE_AGENTS = new Set([
  'curator',
  'reviewer',
  'glossarist',
  'cartographer',
  'archaeologist',
  'surveyor',
  'digest',
]);

/** A page id the model named is checked against the database only if it could be one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Workspace pages the archaeologist reads as "already declared" — linked to the connector or under its destination. */
const MAX_DECLARED_PAGES = 40;

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
/** Web citations kept on one finding — the reader is checking a claim, not reading a bibliography. */
const MAX_SOURCES_PER_FINDING = 8;

export interface AgentRunResult {
  summary: string;
  findings: AgentFinding[];
  /** What the run found that is not a finding; only the sentinel writes it (#236). */
  details?: AgentRunDetails;
}

/**
 * How a running executor says where it is (docs/features/29).
 *
 * The processor owns the write — it is the only thing that knows whether this
 * execution still owns the row — so an executor reports rather than updates.
 * Every call is also a heartbeat: `AgentScheduleSweeper` reads `updatedAt` to
 * decide a run is dead, and before this the row went untouched from claim to
 * result however long the run took.
 *
 * Reporting is best-effort by construction: the processor swallows its own
 * failures, so an executor never has to guard a progress call.
 */
export type AgentReporter = (update: {
  /** Free text, rendered through `labelFor` — see AgentRunSummary.stage. */
  stage?: string;
  /** 0–1, and only where it is honest. A step that cannot say omits it. */
  progress?: number;
  /** Something degraded but the run continues. Capped at MAX_RUN_WARNINGS. */
  warning?: string;
}) => Promise<void>;

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
    private readonly code: CodeResearchService,
    private readonly snapshots: RepoSnapshotService,
    private readonly pullRequests: PullRequestService,
    private readonly search: SearchService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedding: EmbeddingProvider,
    private readonly config: ConfigService<Env, true>,
    private readonly permissions: PermissionService,
    private readonly learnings: AgentLearningsService,
    private readonly componentUsages: ComponentUsagesService,
    private readonly templates: TemplatesService,
    private readonly apiDrift: ApiDriftService,
    private readonly compare: CompareService,
  ) {}

  /**
   * What a background agent is told beyond its instructions: the skills it
   * names, the learnings an admin approved for it, and the findings people
   * dismissed on its earlier runs (#70). One helper, so every executor renders
   * the same blocks in the same order and none can forget one.
   *
   * There is no trigger message in a background run, so only the skills the
   * agent explicitly names apply. Project-scoped learnings apply when the run
   * is about pages, or a connector, in that project.
   */
  private async guidance(run: AgentRun, agent: ResolvedAgent): Promise<string> {
    const [skills, projectIds] = await Promise.all([
      this.skills.forTurn(run.workspaceId, '', agent.skillIds),
      this.runProjects(run),
    ]);
    const [learnings, dismissed] = await Promise.all([
      this.learnings.promptFor({ workspaceId: run.workspaceId, agentKey: agent.key, projectIds }),
      this.learnings.dismissedPrompt(run.workspaceId, agent.key),
    ]);
    return this.skills.renderPrompt(skills) + learnings + dismissed;
  }

  /** The projects a run is about: its pages', else its connector's. Empty for a workspace-wide run. */
  private async runProjects(run: AgentRun): Promise<string[]> {
    const input = (run.input ?? {}) as AgentRunInput;
    if (input.documentIds?.length) {
      const pages = await this.prisma.document.findMany({
        where: { id: { in: input.documentIds }, workspaceId: run.workspaceId },
        select: { projectId: true },
      });
      return [...new Set(pages.map((p) => p.projectId))];
    }
    if (input.connectorId) {
      const connector = await this.prisma.connector.findFirst({
        where: { id: input.connectorId, workspaceId: run.workspaceId },
        select: { projectId: true },
      });
      return connector?.projectId ? [connector.projectId] : [];
    }
    return [];
  }

  /**
   * What a run may read (#76): its owner's pages, clamped to the workspace
   * audience. A run's summary and findings are listed to every member, and a
   * sentinel's verdict also lands on a pull request, so a page only some
   * members can open must not feed either — even when the owner is an admin.
   * Read once per stage for the run's own enumeration; the tool loop asks
   * again on every call through `ctx.audience`.
   */
  private async runScope(run: AgentRun, principal: Principal): Promise<AccessScope> {
    return this.permissions.audienceScope(await this.permissions.scopeFor(principal, run.workspaceId), WORKSPACE_AUDIENCE);
  }

  /** The tool context every agent loop runs with: the owner, clamped like {@link runScope}. */
  private toolCtx(run: AgentRun, principal: Principal) {
    return { principal, workspaceId: run.workspaceId, audience: WORKSPACE_AUDIENCE };
  }

  /**
   * `principal` is the run's rehydrated owner, already authorised by the
   * processor. It is passed down rather than re-derived so an executor that
   * calls an API-shaped service (the glossarist calls the same `suggest` the
   * settings page calls) bills and authorises as that same person.
   */
  async run(
    run: AgentRun,
    agent: ResolvedAgent,
    principal: Principal,
    report: AgentReporter,
  ): Promise<AgentRunResult> {
    switch (agent.key) {
      case 'curator':
        return this.curate(run, agent, principal, report);
      case 'reviewer':
        return this.review(run, agent, principal, report);
      case 'glossarist':
        return this.buildGlossary(run, principal, report);
      case 'cartographer':
        return this.mapRelations(run, agent, principal, report);
      case 'archaeologist':
        return this.excavate(run, agent, principal, report);
      case 'surveyor':
        return this.surveyCoverage(run, agent, principal, report);
      case 'digest':
        return this.digest(run, agent, principal, report);
      // Deliberately not in RUNNABLE_AGENTS (docs/features/35): that set offers
      // the Run button and feeds the schedule sweeper, and a sentinel run with
      // neither a pull request nor a report has nothing to check. Only
      // DriftTriggerService and KnowledgeIssuesService start one.
      case 'sentinel': {
        const input = (run.input ?? {}) as AgentRunInput;
        if (input.issueId) return this.checkReport(run, agent, principal, report);
        if (input.apiSpecDocumentId) return this.checkApiDrift(run, principal, report);
        return this.checkDrift(run, agent, principal, report);
      }
      // Not in RUNNABLE_AGENTS either (#74): a lint answers one merge request
      // check, and only LintTriggerSweeper starts one.
      case 'linter':
        return this.lintMergeRequest(run, agent, principal, report);
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
    report: AgentReporter,
  ): Promise<AgentRunResult> {
    await report({ stage: 'scanning', progress: 0.05 });
    const scope = await this.runScope(run, principal);
    const documents = await this.prisma.document.findMany({
      where: { workspaceId: run.workspaceId, ...pageScope(run), AND: [visibilityWhere(scope)] },
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
      const relations = await this.graph.getWorkspaceRelationGraph(
        run.workspaceId,
        await this.permissions.documentFilterFor(scope),
      );
      for (const edge of relations.edges) {
        degree.set(edge.documentId, (degree.get(edge.documentId) ?? 0) + 1);
      }
    } catch (error) {
      // The graph store being unavailable must not sink the whole run; the
      // model half still works, it just loses the orphan check.
      //
      // Reported as well as logged (docs/features/29): the run still succeeds,
      // and without this the reader is shown a pass with no orphan findings and
      // no way to tell that from a workspace with no orphans.
      this.logger.warn(`Curator could not read the relation graph: ${String(error)}`);
      await report({ warning: t('agent.warning.graphUnreadableOrphans') });
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
      // The model half is the long half — with the read tools it can open pages
      // before asserting a duplicate, so this single step can run for minutes.
      // Saying so before it starts is the difference between a run that looks
      // stuck and one that is visibly working.
      await report({ stage: 'thinking', progress: 0.4 });
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
              await this.guidance(run, agent),
          },
          {
            role: 'user',
            content:
              runBrief(run.input) +
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
                (name, args) => this.readTools.execute(name, args, this.toolCtx(run, principal)),
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
        summary += ` ${t('agent.warning.modelPassFailedStructuralOnly')}`;
        await report({ warning: t('agent.warning.modelPassFailed', { error: reasonOf(error) }) });
      }
    }

    return { summary, findings: findings.slice(0, MAX_FINDINGS) };
  }

  // ------------------------------------------------------------------ reviewer

  /**
   * Reviews the pages that changed most recently — or the run's named pages
   * (#70) — one model call each.
   *
   * The same division of labour as the curator: *which* pages changed is a
   * query, so the worker answers it, and the model is spent only on reading
   * them. Naturally bounded by `take` — a review pass is per page, so the cost
   * is linear and the cap is the budget.
   */
  private async review(
    run: AgentRun,
    agent: ResolvedAgent,
    principal: Principal,
    report: AgentReporter,
  ): Promise<AgentRunResult> {
    if (!agent.config.enabled || agent.missing.length > 0) {
      throw new Error(t('agent.review.cannotRun'));
    }

    // Newest revision first, then back to the page — "recently changed" is a
    // fact about revisions, and `documents` carries no updatedAt.
    const scope = await this.runScope(run, principal);
    const recent = await this.prisma.documentRevision.findMany({
      where: {
        document: { workspaceId: run.workspaceId, ...pageScope(run), AND: [visibilityWhere(scope)] },
        status: 'indexed',
      },
      distinct: ['documentId'],
      orderBy: { createdAt: 'desc' },
      select: { documentId: true, createdAt: true },
      take: MAX_REVIEWED,
    });
    if (recent.length === 0) return { summary: t('agent.review.noPages'), findings: [] };

    const documents = await this.prisma.document.findMany({
      where: { id: { in: recent.map((r) => r.documentId) } },
      select: { id: true, title: true },
    });
    const byId = new Map(documents.map((d) => [d.id, d]));
    const skillText = await this.guidance(run, agent);

    const findings: AgentFinding[] = [];
    let reviewed = 0;
    for (const [at, row] of recent.entries()) {
      if (findings.length >= MAX_FINDINGS) break;
      const doc = byId.get(row.documentId);
      if (!doc) continue;
      // One model call per page, so this loop is the run's whole duration and
      // the one place it can honestly say how far in it is. It is also why the
      // heartbeat matters here most: eight pages against a slow provider
      // outlives the sweeper's 30-minute patience (docs/features/29).
      await report({ stage: 'reviewing', progress: at / recent.length });
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
              content: `${runBrief(run.input)}Title: ${doc.title}\n\nPage:\n\n${content.markdown.slice(0, MAX_REVIEW_CHARS)}`,
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
        // The provider refused the account (no credit, bad key): every later
        // page would fail identically, so one warning, not one per page.
        if (error instanceof ProviderAccountError) {
          await report({ warning: t('agent.warning.stopped', { error: error.message }) });
          break;
        }
        // One unreadable page must not lose the pages already reviewed — but a
        // pass that silently skipped half its pages reads as a clean review.
        this.logger.warn(`Reviewer could not review "${doc.title}": ${String(error)}`);
        await report({ warning: t('agent.warning.pageNotReviewed', { title: doc.title, error: reasonOf(error) }) });
      }
    }

    return {
      // Counts are translated by a nested t() rather than glued in as
      // `page(s)`: Russian declines the noun, so the number and its noun
      // travel together (docs/features/18).
      summary:
        reviewed === 0
          ? t('agent.review.none')
          : t('agent.review.summary', {
              pages: t('agent.count.pages', { count: reviewed }),
              issues: t('agent.count.issues', { count: findings.length }),
            }),
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

  // -------------------------------------------------------------------- linter

  /**
   * The style lint of one merge request head (#74, phase 2).
   *
   * Only what the merge request adds is linted: the merge-base diff's added
   * lines, so a violation already on the target is not this author's. A page's
   * first merge request has no target head, and then all of it is new. The
   * prompt and the gate on what comes back are `lint.ts`'s, the same ones the
   * editor's check uses; `styleFindings` then keeps only quotes the page holds
   * and anchors each to the head. The run publishes nothing — the API's
   * `LintPublishSweeper` turns its findings into threads.
   */
  private async lintMergeRequest(
    run: AgentRun,
    agent: ResolvedAgent,
    principal: Principal,
    report: AgentReporter,
  ): Promise<AgentRunResult> {
    const lint = ((run.input ?? {}) as AgentRunInput).lint;
    if (!lint) throw new Error(t('agent.lint.noInput'));
    if (!agent.config.enabled || agent.missing.length > 0) throw new Error(t('agent.lint.cannotRun'));

    // Asked again on execution, not only at enqueue: the page may have been
    // restricted since, and this run's findings are listed to every member.
    const scope = await this.runScope(run, principal);
    const mr = await this.prisma.mergeRequest.findFirst({
      where: { id: lint.mergeRequestId, document: { workspaceId: run.workspaceId, AND: [visibilityWhere(scope)] } },
      include: {
        targetBranch: { select: { headRevisionId: true } },
        document: { select: { title: true, projectId: true } },
      },
    });
    if (!mr) throw new Error(t('agent.lint.notVisible'));

    const styleguide = await this.skills.effectiveStyleguide(run.workspaceId, mr.document.projectId);
    if (!styleguide || enabledRules(styleguide.rules).length === 0) {
      return { summary: t('agent.lint.noStyleguide'), findings: [] };
    }

    await report({ stage: 'diff' });
    const target = mr.targetBranch.headRevisionId;
    const diff = target
      ? await this.compare.compare(mr.documentId, target, lint.headRevisionId, 'merge-base', { structural: false })
      : await this.compare.compareWithNothing(mr.documentId, lint.headRevisionId, { structural: false });
    const text = changedText(diff.hunks).slice(0, LINT_TEXT_MAX);
    if (!text.trim()) return { summary: t('agent.lint.nothingChanged'), findings: [] };

    await report({ stage: 'linting' });
    const raw = await this.client.chat(
      { config: agent.config, userId: principal.userId, operation: 'lint', locale: run.locale as Locale },
      lintMessages(agent.instructions, styleguide.rules, mr.document.title, text),
      { json: true },
    );
    const max = this.config.get('LINT_MAX_FINDINGS', { infer: true });
    const { violations, dropped } = readLintViolations(safeJson(raw), styleguide.rules, text, max);
    const page = await this.documents.getContent(mr.documentId, lint.headRevisionId);
    const findings = styleFindings(violations, styleguide.rules, {
      documentId: mr.documentId,
      title: mr.document.title,
      revisionId: lint.headRevisionId,
      markdown: page.markdown,
    });
    const ungrounded = dropped + violations.length - findings.length;
    if (ungrounded > 0) await report({ warning: t('agent.lint.dropped', { count: ungrounded }) });

    return {
      summary:
        findings.length === 0
          ? t('agent.lint.clean')
          : t('agent.lint.summary', { violations: t('agent.count.violations', { count: findings.length }) }),
      findings,
    };
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
  private async buildGlossary(
    run: AgentRun,
    principal: Principal,
    report: AgentReporter,
  ): Promise<AgentRunResult> {
    const scope = await this.runScope(run, principal);
    const documents = await this.prisma.document.findMany({
      where: { workspaceId: run.workspaceId, ...pageScope(run), AND: [visibilityWhere(scope)] },
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

    for (const [at, doc] of documents.entries()) {
      if (findings.length >= MAX_FINDINGS) break;
      // Also one model call per page — the reviewer's shape, so the same
      // heartbeat (docs/features/29).
      await report({ stage: 'terms', progress: at / documents.length });
      try {
        const res = await this.glossary.suggest(
          { workspaceId: run.workspaceId, documentId: doc.id, title: doc.title },
          principal,
        );
        // The provider is off for this workspace — every later page would say
        // the same, so stop rather than making the same failed call per page.
        if (!res.enabled) {
          return { summary: t('agent.glossary.disabled'), findings };
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
            detail: `${s.definition}\n\n${t('agent.glossary.seenOn', { count: s.occurrences, title: doc.title })}${
              s.aliases.length ? ` ${t('agent.glossary.aliases', { list: s.aliases.join(', ') })}` : ''
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
          return {
            summary: t('agent.glossary.budgetSpent', { pages: t('agent.count.pages', { count: scanned }) }),
            findings,
          };
        }
        if (error instanceof ProviderAccountError) {
          await report({ warning: t('agent.warning.stopped', { error: error.message }) });
          break;
        }
        this.logger.warn(`Glossarist could not scan "${doc.title}": ${String(error)}`);
        await report({ warning: t('agent.warning.pageNotScanned', { title: doc.title, error: reasonOf(error) }) });
      }
    }

    return {
      summary:
        findings.length === 0
          ? t('agent.glossary.nothingNew', { pages: t('agent.count.pages', { count: scanned }) })
          : t('agent.glossary.summary', {
              pages: t('agent.count.pages', { count: scanned }),
              terms: t('agent.count.terms', { count: findings.length }),
            }),
      findings,
    };
  }

  // ------------------------------------------------------------ archaeologist

  /**
   * Reverse-documents one connected repository (docs/features/31).
   *
   * Four stages, three of them queries. `snapshot` opens the repository through
   * the same cache the chat tools use. `docs` gathers what is already declared
   * — the repository's own documents and the workspace pages linked to the
   * connector or under its destination — and asks the model once to digest it.
   * `candidates` ranks every source file by how much it decides and drops the
   * ones the declared text mentions, in code, with no model. Only `reading` is
   * judgement: one tool loop per uncovered file, with the file in front of the
   * model and the tools to follow its imports, returning the page it would
   * write. A person creates that page; the run never does.
   *
   * Re-running is what makes this converge rather than repeat: a page created
   * from a finding lands under the connector's destination, is read as declared
   * next time, and its file is no longer a candidate.
   */
  private async excavate(
    run: AgentRun,
    agent: ResolvedAgent,
    principal: Principal,
    report: AgentReporter,
  ): Promise<AgentRunResult> {
    const input = (run.input ?? {}) as AgentRunInput;
    if (input.component) return this.draftComponent(run, agent, input.component, principal, report);
    await report({ stage: 'snapshot', progress: 0.05 });
    // The API settled the scope at enqueue; a scheduled run never went through
    // it, so the only-repository fallback lives here too.
    const connectorId = input.connectorId ?? (await this.onlyRepository(run.workspaceId));
    if (!connectorId) throw new Error(t('error.ai.agentNeedsConnector', { key: agent.key }));
    const snapshot = await this.snapshots.open(connectorId, run.workspaceId);
    const connector = await this.prisma.connector.findUnique({
      where: { id: connectorId },
      select: { id: true, name: true, projectId: true, parentId: true },
    });

    // --- what is already declared: repo docs + workspace pages, and a digest of them
    await report({ stage: 'docs', progress: 0.15 });
    const docs = selectRepoDocs(snapshot.files);
    const pages = connector ? await this.destinationPages(await this.runScope(run, principal), connector) : [];
    // Lower-cased once: coverage is a substring test against this, per file.
    const declared = [...docs.map((d) => d.text), ...pages.map(declaredText)].join('\n').toLowerCase();
    // Modules the repo wiki documents as a whole (docs/features/46): their
    // entry files are declared by the module page; the logic below them is not.
    const wikiModules = wikiModulePaths(pages);
    const counts = { docs: docs.length, pages: pages.length, repository: snapshot.name };

    // 'tools' is a preference, not a prerequisite — the curator's rule.
    const blocking = agent.missing.filter((capability) => capability !== 'tools');
    const modelUsable = agent.config.enabled && blocking.length === 0;
    const call = {
      config: agent.config,
      userId: run.createdBy,
      operation: 'agent' as const,
      locale: run.locale as Locale,
    };

    let digest = headingDigest(docs, pages);
    if (modelUsable && (docs.length > 0 || pages.length > 0)) {
      try {
        const raw = await this.client.chat(
          call,
          [
            { role: 'system', content: DIGEST_CONTRACT },
            { role: 'user', content: digestInput(docs, pages, MAX_DIGEST_INPUT_CHARS) },
          ],
          { json: true },
        );
        const topics = safeJson(raw)?.topics;
        if (Array.isArray(topics) && topics.length > 0) {
          digest = topics
            .filter((topic): topic is { name: string; summary?: string; paths?: unknown } =>
              !!topic && typeof (topic as { name?: unknown }).name === 'string',
            )
            .map((topic) => {
              const paths = Array.isArray(topic.paths) ? topic.paths.filter((p) => typeof p === 'string') : [];
              return `- ${topic.name}: ${topic.summary ?? ''}${paths.length ? ` (${paths.join(', ')})` : ''}`;
            })
            .join('\n');
        }
      } catch (error) {
        if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
          return { summary: t('agent.archaeology.budgetSpent', { files: 0, candidates: 0 }), findings: [] };
        }
        this.logger.warn(`Archaeologist digest failed: ${String(error)}`);
        await report({ warning: t('agent.archaeology.digestSkipped') });
      }
    }

    // --- which files decide something nothing declares: ranked, then outlined, in code
    await report({ stage: 'candidates', progress: 0.3 });
    const candidates: Candidate[] = [];
    for (const candidate of rankCandidates(snapshot.files, MAX_RANKED_FILES)) {
      const outline = await this.code.outlineFile(snapshot, candidate.path);
      const names = outline?.symbols.filter((s) => s.exported).map((s) => s.name) ?? [];
      if (isWikiCovered(candidate.path, wikiModules) || isCovered(declared, candidate.path, names)) continue;
      candidates.push(candidate);
      if (candidates.length >= MAX_CANDIDATE_FILES) break;
    }

    if (!modelUsable) {
      await report({ warning: t('agent.archaeology.noModel') });
      return { summary: t('agent.archaeology.noModel'), findings: [] };
    }
    if (candidates.length === 0) return { summary: t('agent.archaeology.noCandidates', counts), findings: [] };

    // --- the judgement: one tool loop per file
    const skills = await this.guidance(run, agent);
    const tools = [...this.readTools.definitions(), ...this.code.definitions()];
    const toolCtx = this.toolCtx(run, principal);
    const findings: AgentFinding[] = [];
    let filesRead = 0;

    for (const [at, candidate] of candidates.entries()) {
      await report({ stage: 'reading', progress: 0.3 + (0.65 * at) / candidates.length });
      const execute = (name: string, args: Record<string, unknown>) =>
        CODE_TOOLS.has(name)
          ? // The run is scoped to one repository: whatever connectorId the
            // model wrote, this is the one it reads.
            this.code.execute(name, { ...args, connectorId }, toolCtx)
          : this.readTools.execute(name, args, toolCtx);

      const text = Buffer.from(snapshot.files.get(candidate.path) ?? new Uint8Array()).toString('utf8');
      const outline = await this.code.outlineFile(snapshot, candidate.path);
      const declares = outline?.symbols.length
        ? `\nIt declares: ${outline.symbols
            .slice(0, 40)
            .map((s) => `${s.kind} ${s.name}${s.exported ? ' (exported)' : ''}`)
            .join(', ')}.`
        : '';
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: `${agent.instructions}\n\n${CODE_OUTPUT_CONTRACT}${skills}` },
        {
          role: 'user',
          content:
            runBrief(input) +
            `Repository: ${snapshot.name} (${snapshot.host.owner}/${snapshot.host.repo} @ ${snapshot.branch}). ` +
            `Every code tool call reads this repository; connectorId is ${connectorId}.\n\n` +
            `What the repository's documents and the workspace's pages already declare:\n${digest || '(nothing)'}\n\n` +
            `The file nothing declares: ${candidate.path} (${candidate.lines} lines).${declares}\n\n` +
            `The first part of the file (use code_read for the rest, and code_search / code_outline for what it ` +
            `imports):\n<file path=${JSON.stringify(candidate.path)}>\n${text.slice(0, MAX_PREVIEW_CHARS)}\n</file>`,
        },
      ];

      try {
        // Every path the model actually opened. A finding may cite only these:
        // a path seen in a tree listing is not a path that was read.
        const { content: raw, readPaths } = await runCodeReadingLoop({
          client: this.client,
          call,
          messages,
          tools,
          execute,
          toolless: agent.missing.includes('tools'),
          json: true,
          seen: [candidate.path],
        });
        filesRead += 1;
        const proposals = safeJson(raw)?.findings;
        let kept = 0;
        for (const proposal of Array.isArray(proposals) ? proposals : []) {
          const finding = readExcavation(proposal, snapshot, readPaths);
          if (!finding) continue;
          findings.push(finding);
          if (++kept >= MAX_FINDINGS_PER_FILE) break;
        }
      } catch (error) {
        if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
          await report({ warning: t('agent.archaeology.budgetSpent', { files: filesRead, candidates: candidates.length }) });
          break;
        }
        if (error instanceof ProviderAccountError) {
          await report({ warning: t('agent.warning.stopped', { error: error.message }) });
          break;
        }
        this.logger.warn(`Archaeologist could not read ${candidate.path}: ${String(error)}`);
        await report({ warning: t('agent.warning.fileNotRead', { path: candidate.path, error: reasonOf(error) }) });
      }
      if (findings.length >= MAX_FINDINGS) break;
    }

    const kept = findings.slice(0, MAX_FINDINGS);
    return {
      summary: t('agent.archaeology.summary', { ...counts, files: filesRead, findings: kept.length }),
      findings: kept,
    };
  }

  /**
   * "Document this component" (#236, phase 5): one page, from the files the
   * run was asked about, written into the `component` template.
   *
   * The archaeologist's reading loop over a different question. The files
   * are given rather than ranked, so nothing here decides what to document,
   * only how: the template is rendered with the component's name and first
   * path, the model fills its sections from the code (`readComponentDraft`
   * refuses a body that drops one), and the frontmatter is computed — the
   * `component:` block names every file the run read. Nothing is written:
   * the draft rides on the finding, and `ComponentDraftSweeper` opens it as a
   * merge request API-side, as the person who asked.
   *
   * Failing loudly is the right answer to every problem here — a missing
   * file, no model, an unusable draft — because a person is waiting on this
   * one run and the failure is what they read.
   */
  private async draftComponent(
    run: AgentRun,
    agent: ResolvedAgent,
    component: AgentRunComponent,
    principal: Principal,
    report: AgentReporter,
  ): Promise<AgentRunResult> {
    const input = (run.input ?? {}) as AgentRunInput;
    if (!input.connectorId) throw new Error(t('error.ai.agentNeedsConnector', { key: agent.key }));
    if (!agent.config.enabled || agent.missing.some((capability) => capability !== 'tools')) {
      throw new Error(t('agent.component.noModel'));
    }
    await report({ stage: 'snapshot', progress: 0.1 });
    const snapshot = await this.snapshots.open(input.connectorId, run.workspaceId);
    // Settled at enqueue against the request, not the archive: the API cannot
    // afford a download per press, and the head may have moved since anyway.
    const missing = component.paths.filter((path) => !snapshot.files.has(path));
    if (missing.length > 0) {
      throw new Error(t('agent.component.pathsMissing', { paths: missing.join(', '), repository: snapshot.name }));
    }

    const ref = builtInTemplateRef('component');
    const repository = `${snapshot.host.owner}/${snapshot.host.repo}`;
    const [template, rendered, skills] = await Promise.all([
      this.templates.resolve(run.workspaceId, ref),
      this.templates.render(
        {
          workspaceId: run.workspaceId,
          ref,
          title: component.name,
          values: { name: component.name, path: component.paths[0], repository },
          ...(component.projectId ? { projectId: component.projectId } : {}),
          ...(component.parentId ? { parentId: component.parentId } : {}),
        },
        { id: run.createdBy },
      ),
      this.guidance(run, agent),
    ]);
    const notes = template.parsed.meta.aiInstructions?.trim();
    const files = componentPreviews(snapshot, component.paths)
      .map((f) => `<file path=${JSON.stringify(f.path)} lines=${f.lines}>\n${f.text}\n</file>`)
      .join('\n');
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: `${agent.instructions}\n\n${COMPONENT_DRAFT_CONTRACT}${skills}` },
      {
        role: 'user',
        content:
          runBrief(input) +
          `Repository: ${snapshot.name} (${repository} @ ${snapshot.branch}). ` +
          `Every code tool call reads this repository; connectorId is ${input.connectorId}.\n\n` +
          `The component: ${component.name}, declared by ${component.paths.join(', ')}` +
          (component.symbols?.length ? `, documenting only the exports ${component.symbols.join(', ')}` : '') +
          `.\n\nThe page skeleton to fill:\n${wrapUntrusted(rendered.body, 'component_template', 'template')}` +
          (notes ? `\n\nThe template's notes for whoever fills it:\n${wrapUntrusted(notes, 'component_template', 'template')}` : '') +
          `\n\nThe start of each file (use code_read for the rest):\n${wrapUntrusted(files, 'code_read', 'repo')}`,
      },
    ];

    await report({ stage: 'reading', progress: 0.3 });
    const toolCtx = this.toolCtx(run, principal);
    const { content, readPaths } = await runCodeReadingLoop({
      client: this.client,
      call: { config: agent.config, userId: run.createdBy, operation: 'component-draft', locale: run.locale as Locale },
      messages,
      tools: [...this.readTools.definitions(), ...this.code.definitions()],
      // One repository: whatever connectorId the model wrote, this is the one it reads.
      execute: (name, args) =>
        CODE_TOOLS.has(name)
          ? this.code.execute(name, { ...args, connectorId: input.connectorId }, toolCtx)
          : this.readTools.execute(name, args, toolCtx),
      toolless: agent.missing.includes('tools'),
      json: true,
      seen: component.paths,
    });
    const body = readComponentDraft(safeJson(content), rendered.body, snapshot, readPaths, component.paths);
    if (!body) throw new Error(t('agent.component.draftUnusable'));

    const title = rendered.title?.trim() || component.name;
    const markdown = composeFrontmatter(
      body.markdown,
      componentFrontmatter(rendered.frontmatter, {
        repository,
        component,
        source: snapshot.blobUrl(component.paths[0]),
        generatedBy: agent.key,
      }),
    );
    return {
      summary: t('agent.component.summary', { name: component.name, files: readPaths.size, repository: snapshot.name }),
      findings: [
        {
          kind: 'gap',
          severity: 'info',
          title: t('agent.component.findingTitle', { name: component.name }),
          detail: t('agent.component.findingDetail', { paths: component.paths.join(', ') }),
          documentIds: [],
          documentTitles: [],
          sources: body.sources,
          draft: { title: title.slice(0, 300), markdown, template: { ref: rendered.templateRef, version: rendered.templateVersion } },
        },
      ],
    };
  }

  // ----------------------------------------------------------------- sentinel

  /**
   * Checks the pages one pull or merge request may make wrong
   * (docs/features/35).
   *
   * Three stages, two of them queries. `diff` reads what the change touches
   * from the host. `related` ties pages to it without a model: the pages the
   * connector itself wrote about the changed modules, the pages under its
   * destination that name a changed file, and a few search hits for the
   * change's title — strongest tie first, capped. Only `judging` is a model:
   * one call per page, shown the page and the part of the diff that tied it,
   * returning whether a statement on it is now untrue and, when the diff says
   * enough, the corrected page.
   *
   * Nothing here writes. The corrected page rides on the finding as a draft;
   * `DriftPublishSweeper` turns it into a merge request and comments on the
   * pull request, API-side, as the connector's owner — the worker generates,
   * the API publishes.
   */
  private async checkDrift(
    run: AgentRun,
    agent: ResolvedAgent,
    principal: Principal,
    report: AgentReporter,
  ): Promise<AgentRunResult> {
    const input = (run.input ?? {}) as AgentRunInput;
    const pr = input.pullRequest;
    const connectorId = input.connectorId;
    if (!pr || !connectorId) throw new Error(t('error.ai.agentNeedsPullRequest', { key: agent.key }));

    // --- what the change touches
    await report({ stage: 'diff', progress: 0.05 });
    const connector = await this.prisma.connector.findFirst({
      where: { id: connectorId, workspaceId: run.workspaceId },
      select: { id: true, name: true, kind: true, config: true, projectId: true, parentId: true },
    });
    if (!connector) throw new Error(t('error.connector.notFound', { id: connectorId }));
    const changed = await this.pullRequests.files(connectorId, run.workspaceId, pr.number);
    if (changed.truncated) await report({ warning: t('agent.drift.truncated', { files: changed.files.length }) });
    const files = scopeFiles(changed.files, subdirOf(connector.config));
    // Spec ↔ code (#78) reads every changed file: the routes a docs
    // connector's spec describes sit outside its `subdir`.
    const api = await this.apiDriftForChange(run, connectorId, pr, changed.files, report);
    if (files.length === 0 && !api?.specs.length) return { summary: t('agent.drift.noFiles', { number: pr.number }), findings: [] };

    // --- which pages it touches, strongest tie first
    await report({ stage: 'related', progress: 0.2 });
    const scope = await this.runScope(run, principal);
    const apiSpecs = api ? await this.visibleSpecs(scope, api.specs, report) : [];
    // Certain, like a path fix: static analysis, whatever the model says.
    const apiFindings = apiSpecs.map((s) => apiDriftFinding(s, pr)).filter((f): f is AgentFinding => !!f);
    const impact = files.length ? await this.changeImpact(scope, connector, pr, files, report) : null;
    const all = files.length ? await this.driftCandidates(scope, connector, pr, files, impact, report) : [];
    // A spec page is the repository's file: its drift is the comparison
    // above, and a model-written body would be overwritten by the next sync.
    const specIds = await this.specDocumentIds(all.map((c) => c.documentId));
    // Past the cap a page is listed, never judged — one model call each.
    const candidates = all.filter((c) => !specIds.has(c.documentId)).slice(0, MAX_DRIFT_PAGES);

    // A declared path the change removes or moves is known from the diff
    // alone, so it is a finding whatever the model says, or whether one runs.
    const pathFindings = new Map<string, AgentFinding>();
    for (const page of impact?.declared ?? []) {
      const fixes = declaredPathFixes(page.paths, files, impact?.overlay?.baseFiles ?? null);
      if (fixes.length > 0) pathFindings.set(page.documentId, componentPathFinding({ id: page.documentId, title: page.title }, page.paths, fixes, pr));
    }
    const judged = new Set<string>();
    const details = (): AgentRunDetails | undefined => {
      const merged: AgentRunDetails = { ...affectedUsagesDetails(impact, judged), ...(apiSpecs.length ? { apiSpecs } : {}) };
      return Object.keys(merged).length ? merged : undefined;
    };

    if (candidates.length === 0) {
      const summary = apiFindings.length
        ? t('agent.drift.api.summaryPr', { number: pr.number, specs: apiSpecs.length, drifted: apiFindings.length })
        : t('agent.drift.noRelated', { number: pr.number, files: files.length });
      return { summary, findings: [...apiFindings, ...pathFindings.values()], details: details() };
    }

    // 'tools' is a preference, not a prerequisite — the curator's rule.
    const blocking = agent.missing.filter((capability) => capability !== 'tools');
    if (!agent.config.enabled || blocking.length > 0) {
      // No model: the ties are still facts worth a reader's attention, so the
      // strong ones become heads-up findings with no verdict and no draft. A
      // search hit is not strong enough to say anything about without reading.
      await report({ warning: t('agent.drift.noModel') });
      const findings: AgentFinding[] = candidates
        .filter((c) => c.tie !== 'searched')
        .map(
          (c) =>
            pathFindings.get(c.documentId) ?? {
              kind: 'stale',
              severity: 'info',
              title: t('agent.drift.mayDriftTitle', { title: c.title }),
              detail: t('agent.drift.mayDriftDetail', { number: pr.number, files: c.files.slice(0, 5).join(', ') }),
              documentIds: [c.documentId],
              documentTitles: [c.title],
            },
        );
      for (const [documentId, finding] of pathFindings) {
        if (!candidates.some((c) => c.documentId === documentId)) findings.push(finding);
      }
      findings.unshift(...apiFindings);
      return {
        summary: t('agent.drift.summaryNoModel', { number: pr.number, pages: findings.length }),
        findings,
        details: details(),
      };
    }

    // --- the judgement: one call per page
    const skills = await this.guidance(run, agent);
    const call = {
      config: agent.config,
      userId: run.createdBy,
      operation: 'agent' as const,
      locale: run.locale as Locale,
    };
    const tools = [...this.readTools.definitions(), ...this.code.definitions()];
    const toolCtx = this.toolCtx(run, principal);
    // The run reads one repository, whatever connectorId the model writes —
    // the archaeologist's rule. The code tools read the connector's branch, not
    // the change; the change itself is in the prompt.
    const execute = (name: string, args: Record<string, unknown>) =>
      CODE_TOOLS.has(name)
        ? this.code.execute(name, { ...args, connectorId }, toolCtx)
        : this.readTools.execute(name, args, toolCtx);
    const byPath = new Map(files.map((f) => [f.path, f]));
    const apiNote = apiDriftPromptNote(apiSpecs);

    const findings: AgentFinding[] = [];
    let checked = 0;
    for (const [at, candidate] of candidates.entries()) {
      await report({ stage: 'judging', progress: 0.3 + (0.65 * at) / candidates.length });
      const content = await this.documents.getContent(candidate.documentId).catch(() => null);
      if (!content || !content.markdown.trim()) continue;

      // A searched page has no file of its own to be shown; it sees the change.
      const shown = candidate.files.length
        ? candidate.files.map((p) => byPath.get(p)).filter((f): f is (typeof files)[number] => !!f)
        : files;
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: `${agent.instructions}

${DRIFT_OUTPUT_CONTRACT}${skills}` },
        {
          role: 'user',
          content:
            `Repository: ${connector.name}. Code tools read its configured branch, which does NOT yet contain ` +
            `this change; connectorId is ${connectorId}.

` +
            `Change #${pr.number}${pr.headRef ? ` (${pr.headRef} → ${pr.baseRef ?? '?'})` : ''}, not merged yet.
` +
            `Why this page may be affected: ${candidate.reasons.join('; ')}.

` +
            wrapUntrusted(
              `Title: ${pr.title}

${diffExcerpt(shown, MAX_DIFF_CHARS)}`,
              'pull_request',
              'repo',
            ) +
            `

<page title=${JSON.stringify(candidate.title)} documentId="${candidate.documentId}">
` +
            `${content.markdown.slice(0, MAX_PAGE_CHARS)}
</page>` +
            apiNote,
        },
      ];

      try {
        const raw = agent.missing.includes('tools')
          ? await this.client.chat(call, messages, { json: true })
          : (await this.client.runWithTools(call, messages, tools, execute, { jsonFinalRound: true })).content;
        checked += 1;
        judged.add(candidate.documentId);
        const finding = readDriftVerdict(
          safeJson(raw),
          { id: candidate.documentId, title: candidate.title, markdown: content.markdown },
          pr,
        );
        // One finding per page, so one merge request: the path edit rides on
        // the corrected body when the model wrote one.
        const paths = pathFindings.get(candidate.documentId);
        if (finding && paths) {
          pathFindings.delete(candidate.documentId);
          findings.push({ ...finding, detail: `${paths.detail} ${finding.detail}`.slice(0, 2_000), componentPaths: paths.componentPaths });
        } else if (finding) findings.push(finding);
      } catch (error) {
        if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
          await report({ warning: t('agent.drift.budgetSpent', { checked, pages: candidates.length }) });
          break;
        }
        if (error instanceof ProviderAccountError) {
          await report({ warning: t('agent.warning.stopped', { error: error.message }) });
          break;
        }
        this.logger.warn(`Sentinel could not judge "${candidate.title}": ${String(error)}`);
        await report({ warning: t('agent.warning.pageNotReviewed', { title: candidate.title, error: reasonOf(error) }) });
      }
    }

    // Path and spec findings first: they are certain, and the cap must not drop them.
    findings.unshift(...apiFindings, ...pathFindings.values());
    return {
      summary: t('agent.drift.summary', {
        number: pr.number,
        files: files.length,
        pages: t('agent.count.pages', { count: checked }),
        drifted: findings.length,
      }),
      findings: findings.slice(0, MAX_FINDINGS),
      details: details(),
    };
  }

  /**
   * What a change does to the agreement between the repository's specs and
   * its routes (#78, phase 8), or null when it ties no spec. Any failure costs
   * the comparison, never the run — the pages are still worth judging.
   */
  private async apiDriftForChange(
    run: AgentRun,
    connectorId: string,
    pr: AgentRunPullRequest,
    changed: Parameters<ApiDriftService['forPullRequest']>[3],
    report: AgentReporter,
  ): Promise<ApiDriftResult | null> {
    try {
      const result = await this.apiDrift.forPullRequest(connectorId, run.workspaceId, pr.headSha, changed, run.locale as Locale);
      for (const warning of result?.warnings ?? []) await report({ warning });
      return result;
    } catch (error) {
      this.logger.warn(`Sentinel could not compare specs with routes for #${pr.number}: ${String(error)}`);
      await report({ warning: t('agent.drift.api.failed') });
      return null;
    }
  }

  /** The specs the run's audience may open; the rest are counted, never named. */
  private async visibleSpecs(scope: AccessScope, specs: ApiDriftSpec[], report: AgentReporter): Promise<ApiDriftSpec[]> {
    const visible = await this.permissions.visibleDocumentIds(scope, specs.map((s) => s.documentId));
    const hidden = specs.filter((s) => !visible.has(s.documentId)).length;
    if (hidden > 0) await report({ warning: t('agent.drift.api.hidden', { count: hidden }) });
    return specs.filter((s) => visible.has(s.documentId));
  }

  /** Which of these pages are spec documents. */
  private async specDocumentIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.document.findMany({
      where: { id: { in: ids }, kind: { in: ['openapi', 'asyncapi'] } },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /**
   * The on-demand spec ↔ code check (#78, phase 8): one spec against its
   * repository's default branch, with no pull request and no model — the
   * comparison is static analysis, so it runs whether or not a model is
   * configured. Everything it finds is reported, drift that predates any
   * change included; the result is the run's findings, the same surface as a
   * pull request check, and nothing is published.
   */
  private async checkApiDrift(run: AgentRun, principal: Principal, report: AgentReporter): Promise<AgentRunResult> {
    const input = (run.input ?? {}) as AgentRunInput;
    const documentId = input.apiSpecDocumentId;
    if (!documentId || !input.connectorId) throw new Error(t('agent.drift.api.needsSpec'));

    await report({ stage: 'routes', progress: 0.1 });
    const scope = await this.runScope(run, principal);
    if (!(await this.permissions.visibleDocumentIds(scope, [documentId])).has(documentId)) {
      throw new Error(t('agent.drift.api.restricted'));
    }
    const result = await this.apiDrift.forBranch(input.connectorId, run.workspaceId, documentId, run.locale as Locale);
    for (const warning of result.warnings) await report({ warning });
    const spec = result.specs[0];
    if (!spec) return { summary: t('agent.drift.api.summaryUnchecked'), findings: [] };

    await report({ stage: 'comparing', progress: 0.9 });
    const details: AgentRunDetails = { apiSpecs: [spec] };
    if (spec.routes === 0) return { summary: t('agent.drift.api.summaryNoRoutes', { title: spec.title }), findings: [], details };
    const finding = apiDriftFinding(spec, null);
    return {
      summary: finding
        ? t('agent.drift.api.summaryDrifted', { title: spec.title, count: spec.mismatchTotal, routes: spec.routes })
        : t('agent.drift.api.summaryClean', { title: spec.title, routes: spec.routes }),
      findings: finding ? [finding] : [],
      details,
    };
  }

  /**
   * The component pages a change touches and the pages documenting where that
   * code is used (#236), or null when it touches none. The head's imports of
   * the changed files are read only once a declaration is known to be
   * touched; any failure costs the two new ties, never the run.
   */
  private async changeImpact(
    scope: AccessScope,
    connector: { id: string; kind: string },
    pr: NonNullable<AgentRunInput['pullRequest']>,
    files: ReturnType<typeof scopeFiles>,
    report: AgentReporter,
  ): Promise<ChangeImpact | null> {
    if (connector.kind !== 'codebase') return null;
    try {
      return await this.componentUsages.forChange(scope, connector.id, files, async () => {
        try {
          const head = await this.pullRequests.headImports(connector.id, scope.workspaceId, pr.headSha, files);
          if (head.unread > 0) await report({ warning: t('agent.drift.overlayPartial', { files: head.unread }) });
          return head;
        } catch (error) {
          this.logger.warn(`Sentinel could not read the head of #${pr.number}: ${String(error)}`);
          await report({ warning: t('agent.drift.overlayFailed') });
          return null;
        }
      });
    } catch (error) {
      this.logger.warn(`Sentinel could not find component usages for #${pr.number}: ${String(error)}`);
      await report({ warning: t('agent.drift.usagesFailed') });
      return null;
    }
  }

  /**
   * The sentinel pointed at a report instead of a diff (docs/features/38,
   * phase 3): one page, one model call, the report's text wrapped as the
   * untrusted evidence it is. The verdict is a `stale` finding naming the
   * report, with the corrected page as a draft when the model is sure; no
   * finding means the report was judged wrong, and `ReportPublishSweeper`
   * resolves the issue. The worker writes nothing else.
   */
  private async checkReport(
    run: AgentRun,
    agent: ResolvedAgent,
    principal: Principal,
    report: AgentReporter,
  ): Promise<AgentRunResult> {
    const issueId = ((run.input ?? {}) as AgentRunInput).issueId;
    if (!issueId) throw new Error(t('error.ai.agentNeedsPullRequest', { key: agent.key }));

    await report({ stage: 'report', progress: 0.05 });
    const issue = await this.prisma.knowledgeIssue.findFirst({ where: { id: issueId, workspaceId: run.workspaceId } });
    if (!issue) throw new Error(t('error.knowledgeIssue.notFound', { id: issueId }));
    const page = await this.prisma.document.findFirst({
      where: { id: issue.documentId, workspaceId: run.workspaceId },
      select: { id: true, title: true },
    });
    if (!page) throw new Error(t('error.document.notFound', { id: issue.documentId }));
    // A failure, not an empty verdict: the publisher reads "no finding" as
    // "judged wrong" and would resolve the report. A failed run sends it back
    // to `open` with this note, in front of a person who can open the page.
    const scope = await this.runScope(run, principal);
    if (!(await this.permissions.visibleDocumentIds(scope, [page.id])).has(page.id)) {
      throw new Error(t('agent.report.restricted'));
    }
    const head = await this.documents.getContent(page.id).catch(() => null);
    if (!head || !head.markdown.trim()) {
      return { summary: t('agent.report.noContent', { title: page.title }), findings: [] };
    }
    const reported =
      issue.revisionId && issue.revisionId !== head.revisionId
        ? await this.documents
            .getContent(page.id, issue.revisionId)
            .then((c) => ({ revisionId: c.revisionId, markdown: c.markdown }))
            .catch(() => null)
        : null;

    const echo: AgentFinding = {
      kind: 'stale',
      severity: 'info',
      title: t('agent.report.reportedTitle', { title: page.title, kind: issue.kind }),
      detail: issue.detail.slice(0, 2_000),
      documentIds: [page.id],
      documentTitles: [page.title],
      issueId: issue.id,
    };
    const blocking = agent.missing.filter((capability) => capability !== 'tools');
    if (!agent.config.enabled || blocking.length > 0) {
      // No model: the report is still worth a reader's attention, so it is
      // echoed as a heads-up finding with no verdict — `agent.drift.noModel`.
      await report({ warning: t('agent.report.noModel') });
      return { summary: t('agent.report.summaryNoModel', { title: page.title }), findings: [echo] };
    }

    await report({ stage: 'judging', progress: 0.4 });
    const skills = await this.guidance(run, agent);
    const call = { config: agent.config, userId: run.createdBy, operation: 'agent' as const, locale: run.locale as Locale };
    const tools = this.readTools.definitions();
    const toolCtx = this.toolCtx(run, principal);
    const execute = (name: string, args: Record<string, unknown>) => this.readTools.execute(name, args, toolCtx);
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: `${agent.instructions}\n\n${REPORT_OUTPUT_CONTRACT}${skills}` },
      {
        role: 'user',
        content: reportJudgementPrompt(
          {
            id: issue.id,
            kind: issue.kind,
            detail: issue.detail,
            evidence: readEvidence(issue.evidence),
            suggestedMarkdown: issue.suggestedMarkdown,
            reportCount: issue.reportCount,
          },
          { id: page.id, title: page.title, markdown: head.markdown },
          reported,
          MAX_PAGE_CHARS,
        ),
      },
    ];

    try {
      const raw = agent.missing.includes('tools')
        ? await this.client.chat(call, messages, { json: true })
        : (await this.client.runWithTools(call, messages, tools, execute, { jsonFinalRound: true })).content;
      const finding = readReportVerdict(safeJson(raw), { id: page.id, title: page.title, markdown: head.markdown }, issue.id);
      return {
        summary: finding
          ? t('agent.report.summaryConfirmed', { title: page.title, drafted: finding.draft ? 1 : 0 })
          : t('agent.report.summaryRejected', { title: page.title }),
        findings: finding ? [finding] : [],
      };
    } catch (error) {
      if (error instanceof ProviderAccountError) {
        await report({ warning: t('agent.warning.stopped', { error: error.message }) });
      } else {
        this.logger.warn(`Sentinel could not judge report ${issue.id}: ${String(error)}`);
        await report({ warning: t('agent.warning.pageNotReviewed', { title: page.title, error: reasonOf(error) }) });
      }
      // Not judged is not "judged fine": the echo keeps the report in front of
      // a person, and the publisher reads an info finding as exactly that.
      return { summary: t('agent.report.summaryNoModel', { title: page.title }), findings: [echo] };
    }
  }

  /**
   * The pages a change is tied to, and why, strongest first and uncapped — the
   * caller judges the first `MAX_DRIFT_PAGES`. Each tie is a weaker claim than
   * the one before: a page declared the changed file as its component (#236),
   * the connector wrote a page about exactly that code, a page documents code
   * that uses a changed component, a person named the file, and last, a page
   * merely reads like the change's title.
   */
  private async driftCandidates(
    scope: AccessScope,
    connector: { id: string; kind: string; projectId: string; parentId: string | null },
    pr: NonNullable<AgentRunInput['pullRequest']>,
    files: ReturnType<typeof scopeFiles>,
    impact: ChangeImpact | null,
    report: AgentReporter,
  ): Promise<DriftCandidate[]> {
    const workspaceId = scope.workspaceId;
    const links = await this.prisma.connectorLink.findMany({
      where: { connectorId: connector.id },
      select: { externalId: true, documentId: true },
    });
    const { ties, inChange } = linkedCandidates(connector.kind, links, files);
    const out = new Map<string, DriftCandidate>();

    // `impact` was read under `scope` already: every page in it may be opened.
    for (const page of impact?.declared ?? []) {
      out.set(page.documentId, {
        documentId: page.documentId,
        title: page.title,
        tie: 'declared',
        reasons: [`declares ${listOf(page.files)} in component.paths`],
        files: page.files,
      });
    }

    const titles = new Map(
      (
        await this.prisma.document.findMany({
          where: { id: { in: [...ties.keys()] }, workspaceId, AND: [visibilityWhere(scope)] },
          select: { id: true, title: true },
        })
      ).map((d) => [d.id, d.title]),
    );
    for (const [documentId, tie] of ties) {
      const title = titles.get(documentId);
      if (title && !out.has(documentId)) out.set(documentId, { documentId, title, tie: 'linked', ...tie });
    }

    for (const page of impact?.affected ?? []) {
      if (out.has(page.documentId) || inChange.has(page.documentId)) continue;
      out.set(page.documentId, {
        documentId: page.documentId,
        title: page.title,
        tie: 'used',
        reasons: [`documents ${listOf(page.sites)}, which use${page.sites.length === 1 ? 's' : ''} ${listOf(page.uses)} (changed)`],
        files: page.uses,
      });
    }

    for (const page of await this.destinationPages(scope, connector)) {
      if (inChange.has(page.id) || out.has(page.id)) continue;
      const named = mentionedFiles(`${page.title}
${page.markdown}`, files);
      if (named.length === 0) continue;
      out.set(page.id, {
        documentId: page.id,
        title: page.title,
        tie: 'mentioned',
        reasons: [`names ${named.slice(0, 3).join(', ')}${named.length > 3 ? ` and ${named.length - 3} more` : ''}`],
        files: named,
      });
    }

    // A page outside the connector's destination — a hand-written design doc —
    // is the one most likely to drift and least likely to be tied above. One
    // search, few hits; a failure costs the weakest tie, never the run.
    try {
      const res = await this.search.search(
        {
          workspaceId,
          query: searchQueryFor(pr, files),
          mode: 'hybrid',
          limit: MAX_SEARCHED_PAGES * 3,
        },
        scope,
      );
      let added = 0;
      for (const hit of res.results) {
        if (added >= MAX_SEARCHED_PAGES) break;
        if (out.has(hit.documentId) || inChange.has(hit.documentId)) continue;
        out.set(hit.documentId, {
          documentId: hit.documentId,
          title: hit.title,
          tie: 'searched',
          reasons: ['reads like the change (search)'],
          files: [],
        });
        added += 1;
      }
    } catch (error) {
      this.logger.warn(`Sentinel search failed: ${String(error)}`);
      await report({ warning: t('agent.drift.searchFailed') });
    }

    return [...out.values()];
  }

  /** The one enabled repository connector, when there is exactly one to mean. */
  private async onlyRepository(workspaceId: string): Promise<string | null> {
    const rows = await this.prisma.connector.findMany({
      where: { workspaceId, enabled: true, kind: { in: ['codebase', 'markdown-git'] } },
      select: { id: true },
      take: 2,
    });
    return rows.length === 1 ? rows[0].id : null;
  }

  /**
   * The workspace pages that count as "already declared" for a repository:
   * the ones the connector itself wrote (its links) and the ones under its
   * destination — which is where a page created from a finding lands, and
   * what makes a second run skip the file that page is about. With no
   * destination parent the project's root pages stand in. Capped, and read
   * through the same `getContent` a reader uses; a draft-only page is skipped.
   */
  private async destinationPages(
    scope: AccessScope,
    connector: { id: string; projectId: string; parentId: string | null },
  ): Promise<Array<{ id: string; title: string; markdown: string; frontmatter: Record<string, unknown> | null }>> {
    const workspaceId = scope.workspaceId;
    const ids = new Set<string>();
    for (const link of await this.prisma.connectorLink.findMany({
      where: { connectorId: connector.id },
      select: { documentId: true },
      take: MAX_DECLARED_PAGES,
    })) {
      ids.add(link.documentId);
    }
    if (connector.parentId) {
      ids.add(connector.parentId);
      let frontier = [connector.parentId];
      while (frontier.length > 0 && ids.size < MAX_DECLARED_PAGES) {
        const children = await this.prisma.document.findMany({
          where: { workspaceId, parentId: { in: frontier } },
          select: { id: true },
          take: MAX_DECLARED_PAGES,
        });
        frontier = children.map((c) => c.id).filter((id) => !ids.has(id));
        for (const id of frontier) ids.add(id);
      }
    } else {
      for (const root of await this.prisma.document.findMany({
        where: { workspaceId, projectId: connector.projectId, parentId: null },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
        take: MAX_DECLARED_PAGES,
      })) {
        ids.add(root.id);
      }
    }

    // Walked unfiltered so a hidden section does not cut off what is under
    // it, then filtered: a page the run may not read declares nothing to it.
    const rows = await this.prisma.document.findMany({
      where: { id: { in: [...ids].slice(0, MAX_DECLARED_PAGES) }, workspaceId, AND: [visibilityWhere(scope)] },
      select: { id: true, title: true },
    });
    const out: Array<{ id: string; title: string; markdown: string; frontmatter: Record<string, unknown> | null }> = [];
    for (const row of rows) {
      try {
        const content = await this.documents.getContent(row.id);
        // The frontmatter counts as declared text too: a page created from a
        // finding names its file in `source:`, and that is the mention that
        // keeps the next run from proposing the same file again even when the
        // prose paraphrases the path.
        const frontmatter = content.frontmatter ? JSON.stringify(content.frontmatter) : '';
        out.push({
          id: row.id,
          title: row.title,
          markdown: `${content.markdown}\n${frontmatter}`,
          frontmatter: (content.frontmatter as Record<string, unknown> | null) ?? null,
        });
      } catch {
        // No indexed content yet, or a draft: nothing declared, nothing to read.
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ surveyor

  /**
   * Clusters the questions answers failed on into coverage gaps
   * (docs/features/38, phase 4).
   *
   * Three stages, two of them no model. `signals` reads `answer_feedback` for
   * the window: down-votes, low-confidence turns, turns with no answer — the
   * misses only, since a good answer nobody rated wrote nothing. `clustering`
   * embeds each distinct question with the workspace's embedding provider and
   * joins them greedily by cosine to a centroid; clusters under the minimum
   * size are dropped. Only `topics` is judgement: one tool loop per cluster,
   * with the questions wrapped as the untrusted text they are, returning the
   * topic's name, what the workspace already says, and one of three fixes.
   *
   * Every finding carries `coverage` — the questions, the count, the signal
   * mix — so it is grounded whether or not the model cited a page: the cluster
   * is a fact about feedback, and the proposal is what the model adds. A
   * person then creates the drafted page, proposes the edit, or starts the
   * archaeologist; the run never writes.
   */
  private async surveyCoverage(
    run: AgentRun,
    agent: ResolvedAgent,
    principal: Principal,
    report: AgentReporter,
  ): Promise<AgentRunResult> {
    const input = (run.input ?? {}) as AgentRunInput;
    const windowDays =
      input.coverage?.windowDays && input.coverage.windowDays > 0
        ? Math.trunc(input.coverage.windowDays)
        : this.config.get('COVERAGE_WINDOW_DAYS', { infer: true });
    const minSize = this.config.get('COVERAGE_MIN_CLUSTER_SIZE', { infer: true });
    const threshold = this.config.get('COVERAGE_SIMILARITY', { infer: true });
    const maxQuestions = this.config.get('COVERAGE_MAX_QUESTIONS', { infer: true });

    // The stub provider hashes words: two phrasings of one question land far
    // apart and two unrelated questions sharing a word land close. Clusters
    // over it would be junk with a confident count on them, so the run says so
    // and stops — the one honest answer a fixture can give.
    if (this.config.get('EMBEDDINGS_PROVIDER', { infer: true }) === 'stub') {
      return { summary: t('agent.coverage.noEmbedding'), findings: [] };
    }

    // --- what failed, in the window
    await report({ stage: 'signals', progress: 0.05 });
    const scope = await this.runScope(run, principal);
    const since = new Date(Date.now() - windowDays * 86_400_000);
    const rows = await this.prisma.answerFeedback.findMany({
      where: {
        workspaceId: run.workspaceId,
        createdAt: { gte: since },
        OR: [{ kind: { in: ['low-confidence', 'no-answer'] } }, { kind: 'vote', rating: 'down' }],
      },
      select: { id: true, query: true, kind: true, surface: true },
      orderBy: { createdAt: 'desc' },
      take: maxQuestions,
    });
    const signals: CoverageSignal[] = rows
      .filter((r) => questionKey(r.query).length >= 3)
      .map((r) => ({ id: r.id, query: r.query, kind: r.kind as AnswerSignalKind, surface: r.surface as AnswerSurface }));
    if (signals.length === 0) return { summary: t('agent.coverage.noSignals', { days: windowDays }), findings: [] };

    // --- which of them are one topic: one embedding per distinct text
    await report({ stage: 'clustering', progress: 0.15 });
    const texts = new Map<string, string>();
    for (const s of signals) texts.set(questionKey(s.query), normalizeQuestion(s.query));
    const keys = [...texts.keys()];
    const vectors = new Map<string, number[]>();
    for (let at = 0; at < keys.length; at += EMBED_BATCH) {
      const slice = keys.slice(at, at + EMBED_BATCH);
      const embedded = await this.embedding.embedBatch(slice.map((k) => texts.get(k)!));
      slice.forEach((k, i) => vectors.set(k, embedded[i]));
      await report({ stage: 'clustering', progress: 0.15 + (0.25 * Math.min(at + EMBED_BATCH, keys.length)) / keys.length });
    }
    const clusters = clusterSignals(signals, vectors, { threshold, minSize, maxClusters: MAX_CLUSTERS });
    const counts = { signals: signals.length, questions: keys.length, clusters: clusters.length };
    if (clusters.length === 0) return { summary: t('agent.coverage.tooFew', { ...counts, min: minSize }), findings: [] };

    // --- the judgement: one tool loop per cluster
    const hasCodebase =
      (await this.prisma.connector.count({ where: { workspaceId: run.workspaceId, enabled: true, kind: 'codebase' } })) > 0;
    const blocking = agent.missing.filter((capability) => capability !== 'tools');
    if (!agent.config.enabled || blocking.length > 0) {
      // No model: the clusters are still the facts a reader came for, so each
      // becomes a finding with no proposal — named by its most-asked question.
      await report({ warning: t('agent.coverage.noModel') });
      return {
        summary: t('agent.coverage.summaryNoModel', counts),
        findings: clusters.map((cluster) => ({
          kind: 'gap' as const,
          severity: 'info' as const,
          title: cluster.questions[0],
          detail: t('agent.coverage.noModelDetail', { count: cluster.count }),
          documentIds: [],
          documentTitles: [],
          coverage: coverageOf(cluster, 'create-page'),
        })),
      };
    }

    const skills = await this.guidance(run, agent);
    const call = { config: agent.config, userId: run.createdBy, operation: 'agent' as const, locale: run.locale as Locale };
    const tools = this.readTools.definitions();
    const toolCtx = this.toolCtx(run, principal);
    const execute = (name: string, args: Record<string, unknown>) => this.readTools.execute(name, args, toolCtx);
    const findings: AgentFinding[] = [];
    let judged = 0;

    for (const [at, cluster] of clusters.entries()) {
      await report({ stage: 'topics', progress: 0.4 + (0.55 * at) / clusters.length });
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: `${agent.instructions}\n\n${COVERAGE_OUTPUT_CONTRACT}${skills}` },
        {
          role: 'user',
          content:
            runBrief(input) +
            coveragePrompt(cluster, { hasCodebase, windowDays }),
        },
      ];
      const fallbackDetail = t('agent.coverage.noModelDetail', { count: cluster.count });
      try {
        const raw = agent.missing.includes('tools')
          ? await this.client.chat(call, messages, { json: true })
          : (await this.client.runWithTools(call, messages, tools, execute, { jsonFinalRound: true })).content;
        judged += 1;
        const parsed = safeJson(raw);
        // A cited page must exist here: one query over whatever the model
        // named, and `readCoverageVerdict` keeps only what came back.
        const cited = citedIdsOf(parsed).filter((id) => UUID.test(id));
        const known = new Map(
          cited.length
            ? (
                await this.prisma.document.findMany({
                  where: { id: { in: cited }, workspaceId: run.workspaceId, AND: [visibilityWhere(scope)] },
                  select: { id: true, title: true },
                })
              ).map((d) => [d.id, d.title])
            : [],
        );
        findings.push(readCoverageVerdict(parsed, cluster, known, { hasCodebase, fallbackDetail }));
      } catch (error) {
        if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
          await report({ warning: t('agent.coverage.budgetSpent', { judged, clusters: clusters.length }) });
          break;
        }
        if (error instanceof ProviderAccountError) {
          await report({ warning: t('agent.warning.stopped', { error: error.message }) });
          break;
        }
        // Not judged is not "no gap": the cluster still lands, unnamed.
        this.logger.warn(`Surveyor could not judge a cluster: ${String(error)}`);
        await report({ warning: t('agent.warning.modelPassFailed', { error: reasonOf(error) }) });
        findings.push(readCoverageVerdict(null, cluster, new Map(), { hasCodebase, fallbackDetail }));
      }
      if (findings.length >= MAX_FINDINGS) break;
    }

    return {
      summary: t('agent.coverage.summary', { ...counts, judged, findings: findings.length }),
      findings: findings.slice(0, MAX_FINDINGS),
    };
  }

  // ------------------------------------------------------------------- digest

  /**
   * What changed since the last digest (#70, phase 4), as a page a person can
   * publish.
   *
   * The curator's division of labour: which pages were created or changed,
   * what was merged and how many findings the other agents reported are
   * queries over the run's scope — clamped to the workspace audience, because
   * the digest is listed to every member — and the model is spent once, on
   * what mattered. The proposed page is the first finding's `draft`; Create
   * page publishes it through the archaeologist's path, as whoever presses it.
   */
  private async digest(
    run: AgentRun,
    agent: ResolvedAgent,
    principal: Principal,
    report: AgentReporter,
  ): Promise<AgentRunResult> {
    await report({ stage: 'scanning', progress: 0.05 });
    const facts = await this.digestFacts(run, principal);
    const days = Math.max(1, Math.round((facts.until.getTime() - facts.since.getTime()) / 86_400_000));
    if (isQuietDigest(facts)) return { summary: t('agent.digestRun.quiet', { days }), findings: [] };

    const counts = { days, created: facts.created.length, changed: facts.changed.length, merged: facts.merged.length };
    let summary = t('agent.digestRun.summary', counts);
    let highlights: DigestHighlight[] = [];
    const known = digestKnown(facts);

    const blocking = agent.missing.filter((capability) => capability !== 'tools');
    if (agent.config.enabled && blocking.length === 0) {
      await report({ stage: 'thinking', progress: 0.4 });
      try {
        const call = { config: agent.config, userId: run.createdBy, operation: 'agent' as const, locale: run.locale as Locale };
        const messages: ChatCompletionMessageParam[] = [
          {
            role: 'system',
            content:
              `${agent.instructions}\n\n${DIGEST_OUTPUT_CONTRACT}` +
              await this.guidance(run, agent),
          },
          { role: 'user', content: runBrief(run.input) + digestListing(facts) },
        ];
        const raw = agent.missing.includes('tools')
          ? await this.client.chat(call, messages, { json: true })
          : (
              await this.client.runWithTools(
                call,
                messages,
                this.readTools.definitions(),
                (name, args) => this.readTools.execute(name, args, this.toolCtx(run, principal)),
                { jsonFinalRound: true },
              )
            ).content;
        const parsed = safeJson(raw);
        highlights = readDigestHighlights(parsed, known);
        if (typeof parsed?.summary === 'string' && parsed.summary.trim()) {
          summary = parsed.summary.trim().slice(0, 2_000);
        }
      } catch (error) {
        // The lists are the digest's facts and stand without the model.
        this.logger.warn(`Digest model pass failed: ${String(error)}`);
        await report({ warning: t('agent.warning.modelPassFailed', { error: reasonOf(error) }) });
      }
    }

    const title = t('agent.digestRun.pageTitle', { from: isoDay(facts.since), to: isoDay(facts.until) });
    const markdown = digestMarkdown(facts, summary, highlights, {
      highlights: t('agent.digestRun.highlights'),
      created: t('agent.digestRun.created'),
      changed: t('agent.digestRun.changed'),
      merged: t('agent.digestRun.merged'),
      findings: t('agent.digestRun.findings'),
      revisions: (n) => t('agent.digestRun.revisions', { n }),
    });
    return {
      summary,
      findings: [
        // First, and citing nothing: `createPage` reads an empty documentIds as
        // "not published yet" and records the new page there once it is.
        {
          kind: 'other',
          severity: 'info',
          title,
          detail: t('agent.digestRun.draftDetail', counts),
          documentIds: [],
          documentTitles: [],
          draft: { title, markdown },
        },
        ...highlights.map((h) => highlightFinding(h, known)),
      ],
    };
  }

  /** The digest's facts, every page read under the run's audience-clamped scope. */
  private async digestFacts(run: AgentRun, principal: Principal): Promise<DigestFacts> {
    const until = new Date();
    const previous = await this.prisma.agentRun.findFirst({
      where: { workspaceId: run.workspaceId, agentKey: 'digest', status: 'succeeded', id: { not: run.id } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const since = digestSince(previous?.createdAt ?? null, until);
    const scope = await this.runScope(run, principal);
    const visible = { workspaceId: run.workspaceId, archivedAt: null, AND: [visibilityWhere(scope)] };
    const page = { id: true, title: true, category: true } as const;

    const [created, revisions, merged, runs, agents] = await Promise.all([
      this.prisma.document.findMany({
        where: { ...visible, createdAt: { gte: since } },
        select: { ...page, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: MAX_DIGEST_PAGES,
      }),
      // Indexed revisions only — a draft that never reached the index changed
      // nothing a reader can see. Bounded; the default-branch check is a
      // column-to-column compare Prisma cannot express, so it runs below.
      this.prisma.documentRevision.findMany({
        where: { createdAt: { gte: since }, status: 'indexed', document: visible },
        select: { documentId: true, branch: { select: { name: true } }, document: { select: { ...page, defaultBranch: true } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      this.prisma.mergeRequest.findMany({
        where: { status: 'merged', mergedAt: { gte: since }, document: visible },
        select: { title: true, mergedAt: true, document: { select: page } },
        orderBy: { mergedAt: 'desc' },
        take: MAX_DIGEST_MERGES,
      }),
      this.prisma.agentRun.findMany({
        where: {
          workspaceId: run.workspaceId,
          status: 'succeeded',
          finishedAt: { gte: since },
          agentKey: { not: 'digest' },
        },
        select: { agentKey: true, findings: true },
        take: 200,
      }),
      this.registry.list(run.workspaceId),
    ]);

    const createdIds = new Set(created.map((d) => d.id));
    const changed = new Map<string, DigestFacts['changed'][number]>();
    for (const rev of revisions) {
      // A new page's first revisions are its creation, already listed.
      if (createdIds.has(rev.documentId) || rev.branch?.name !== rev.document.defaultBranch) continue;
      const entry = changed.get(rev.documentId);
      if (entry) entry.revisions += 1;
      else
        changed.set(rev.documentId, {
          id: rev.document.id,
          title: rev.document.title,
          category: rev.document.category,
          revisions: 1,
        });
    }

    const names = new Map(agents.map((a) => [a.key, a.name]));
    const findings = new Map<string, number>();
    for (const r of runs) {
      const count = Array.isArray(r.findings) ? r.findings.length : 0;
      if (count > 0) findings.set(r.agentKey, (findings.get(r.agentKey) ?? 0) + count);
    }

    return {
      since,
      until,
      created,
      changed: [...changed.values()].sort((a, b) => b.revisions - a.revisions).slice(0, MAX_DIGEST_PAGES),
      merged: merged.flatMap((m) => (m.mergedAt ? [{ title: m.title, mergedAt: m.mergedAt, document: m.document }] : [])),
      findings: [...findings].map(([key, count]) => ({ agent: names.get(key) ?? key, count })),
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
    report: AgentReporter,
  ): Promise<AgentRunResult> {
    await report({ stage: 'scanning', progress: 0.05 });
    const scope = await this.runScope(run, principal);
    const documents = await this.prisma.document.findMany({
      where: { workspaceId: run.workspaceId, AND: [visibilityWhere(scope)] },
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

    await report({ stage: 'graph', progress: 0.2 });
    try {
      // Filtered, not only matched against `documents` below: an entity whose
      // only edges come from pages the run may not read is not one to name.
      const graph = await this.graph.getWorkspaceRelationGraph(
        run.workspaceId,
        await this.permissions.documentFilterFor(scope),
      );
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
      await report({ warning: t('agent.warning.graphUnreadableModelOnly') });
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
      // The tool loop can open pages before proposing an edge, so this step is
      // the long one here too — see the curator's note (docs/features/29).
      await report({ stage: 'thinking', progress: 0.5 });
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
              await this.guidance(run, agent),
          },
          {
            role: 'user',
            content:
              runBrief(run.input) +
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
                (name, args) => this.readTools.execute(name, args, this.toolCtx(run, principal)),
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
        await report({ warning: t('agent.warning.modelPassFailed', { error: reasonOf(error) }) });
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

    // Grounded means cited — by a page in this workspace, or by a page on the
    // open web that was actually fetched (docs/features/29). Only the first
    // counted before, so a finding whose whole evidence was off-platform was
    // dropped in silence, which is what left a research run's output with
    // nowhere to land. Neither kind is a free pass: a page id has to exist
    // here, and a URL has to parse as http(s).
    const ids = Array.isArray(raw.documentIds)
      ? raw.documentIds.filter((id): id is string => typeof id === 'string' && known.has(id))
      : [];
    const sources = readWebSources(raw.sources);
    if (ids.length === 0 && sources.length === 0) return null;

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
      ...(sources.length ? { sources } : {}),
    };
  }
}

/**
 * Web citations on a finding (docs/features/29).
 *
 * Validated, never trusted — the rule `readFinding` applies to page ids, applied
 * to URLs. A string that does not parse is dropped rather than rendered as a
 * dead link, and the scheme is checked because these end up as `href`s: a
 * `javascript:` "citation" is worth rather less than nothing.
 *
 * The host is derived here rather than taken from the model, so a finding cannot
 * claim a page on `docs.stripe.com` while linking somewhere else.
 */
function readWebSources(value: unknown): AssistantWebSource[] {
  if (!Array.isArray(value)) return [];
  const out: AssistantWebSource[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.url !== 'string') continue;
    let url: URL;
    try {
      url = new URL(raw.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    out.push({
      kind: 'web',
      url: url.href,
      site: url.hostname.replace(/^www\./, ''),
      title: title ? title.slice(0, 300) : url.hostname,
      ...(typeof raw.snippet === 'string' && raw.snippet.trim()
        ? { snippet: raw.snippet.trim().slice(0, 500) }
        : {}),
      ...(typeof raw.fetchedAt === 'string' ? { fetchedAt: raw.fetchedAt } : {}),
    });
    if (out.length >= MAX_SOURCES_PER_FINDING) break;
  }
  return out;
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

/** What a warning shows: the message, never `ServiceUnavailableException: …`. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/**
 * The page filter a page-scoped run (#70) adds to its gathering query, or
 * nothing. Spread beside the run's `visibilityWhere`, never instead of it:
 * naming a page the owner cannot open narrows the run to nothing, it does not
 * widen what the run may read.
 */
function pageScope(run: AgentRun): { id?: { in: string[] } } {
  const ids = ((run.input ?? {}) as AgentRunInput).documentIds;
  return Array.isArray(ids) && ids.length > 0 ? { id: { in: ids.slice(0, AGENT_RUN_MAX_DOCUMENTS) } } : {};
}

/**
 * What the run was asked beyond its own instructions: the trigger's or the
 * person's note, and — for a webhook run (#70) — the delivery's body. The note
 * is trusted (an admin or the person pressing Run wrote it); the payload never
 * is, so it reaches the model only inside `wrapUntrusted`. One helper so no
 * executor can render the payload any other way.
 */
export function runBrief(input: unknown): string {
  const { note, payload } = (input ?? {}) as { note?: unknown; payload?: unknown };
  return (
    (typeof note === 'string' && note ? `Extra instructions: ${note}\n\n` : '') +
    (typeof payload === 'string' && payload
      ? `What started this run:\n${wrapUntrusted(payload, 'webhook', 'webhook')}\n\n`
      : '')
  );
}
