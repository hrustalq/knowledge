import { createHash } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentRun } from '@prisma/client';
import type { ChatCompletionFunctionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { AGENT_RUN_MAX_DOCUMENTS, type AgentFinding, type AgentRunDetails, type AgentRunInput, type BuiltInAgentKey } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { t } from '../i18n/t.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GraphService } from '../graph/graph.service.js';
import { AssistantClient, ProviderAccountError, type AiCallContext, type ToolExecutor } from '../assistant/assistant.client.js';
import { DecisionClient } from '../assistant/decision.client.js';
import { ConflictsService } from '../conflicts/conflicts.service.js';
import { AssistantReadToolsService } from '../assistant/assistant-read-tools.service.js';
import { CodeResearchService } from '../connectors/code-research/code-research.service.js';
import { RepoSnapshotService } from '../connectors/code-research/repo-snapshot.service.js';
import { PullRequestService } from '../connectors/code-research/pull-request.service.js';
import { ApiDriftService } from '../connectors/code-research/api-drift.service.js';
import { ComponentUsagesService } from '../components/component-usages.service.js';
import { SearchService } from '../search/search.service.js';
import { WORKSPACE_AUDIENCE, type AccessScope } from '../permissions/access-scope.js';
import { PermissionService } from '../permissions/permission.service.js';
import { AccessService } from '../auth/access.service.js';
import { ApiFixturesService } from '../api-specs/api-fixtures.service.js';
import { ApiTestSuitesService } from '../api-specs/api-test-suites.service.js';
import { ApiSpecDiffService } from '../api-specs/api-spec-diff.service.js';
import { AgentRegistryService, type ResolvedAgent } from './agent-registry.service.js';
import { AiSkillsService } from '../ai/ai-skills.service.js';
import { AgentLearningsService } from '../ai/agent-learnings.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { GlossaryService } from '../glossary/glossary.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { CompareService } from '../documents/compare.service.js';
import { TrackerRegistry } from '../connectors/tracker-registry.service.js';
import type { Principal } from '../auth/principal.js';

export interface AgentRunResult {
  summary: string;
  findings: AgentFinding[];
  /** What the run found that is not a finding: the sentinel's usages (#236), the glossarist's watermark (#74). */
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
 * One background agent (#823): its key and the function that runs it, in its
 * own file under `runners/`. `svc` is the executor itself — the collaborators
 * and the per-run helpers every runner shares — passed rather than injected
 * so a runner is a plain function and the executor stays one provider.
 */
export interface AgentRunner {
  key: BuiltInAgentKey;
  run(svc: AgentServices, run: AgentRun, agent: ResolvedAgent, principal: Principal, report: AgentReporter): Promise<AgentRunResult>;
}


/** Findings kept from one run. A wall of findings is not a review, it is noise. */
export const MAX_FINDINGS = 20;

/**
 * What one run's prompt was built from (#305), collected as the executor
 * renders it and stamped on the run at the end. `trusted` holds only text a
 * person wrote or approved — skills, learnings, a styleguide — never page
 * content, which every executor wraps untrusted in the user turn.
 */
interface RunLedger {
  guidance: Promise<string> | null;
  trusted: Set<string>;
  learningIds: string[];
}

/**
 * SHA-256 over a run's trusted prompt: the agent's instructions (the built-in
 * prompt or its override) and the trusted parts, order-free and with empty
 * parts dropped, so an agent with no skills hashes the same whether or not its
 * executor asked for guidance. Untrusted content never reaches it — that is
 * what makes two runs over different pages comparable as one prompt.
 */
export function promptHashOf(instructions: string, trusted: Iterable<string>): string {
  const parts = [...new Set(trusted)].filter((p) => p.trim() !== '').sort();
  return createHash('sha256').update(JSON.stringify([instructions, ...parts])).digest('hex');
}

/**
 * What every runner shares: the executor's collaborators and the per-run
 * helpers (guidance, scope, the model call). A base class rather than a
 * context object so `AgentExecutor` keeps its constructor, which the specs
 * build positionally, and so a runner importing this file never imports the
 * executor that imports it (#822 made the same split for the MCP tools).
 */
@Injectable()
export class AgentServices {
  readonly logger = new Logger('AgentExecutor');
  /** In-flight runs' ledgers, by run id. A run's entry lives from its first prompt to its stamp. */
  private readonly ledgers = new Map<string, RunLedger>();

  constructor(
    readonly prisma: PrismaService,
    readonly graph: GraphService,
    readonly registry: AgentRegistryService,
    readonly client: AssistantClient,
    readonly readTools: AssistantReadToolsService,
    readonly skills: AiSkillsService,
    readonly documents: DocumentsService,
    readonly glossary: GlossaryService,
    readonly code: CodeResearchService,
    readonly snapshots: RepoSnapshotService,
    readonly pullRequests: PullRequestService,
    readonly search: SearchService,
    @Inject(EMBEDDING_PROVIDER) readonly embedding: EmbeddingProvider,
    readonly config: ConfigService<Env, true>,
    readonly permissions: PermissionService,
    readonly learnings: AgentLearningsService,
    readonly componentUsages: ComponentUsagesService,
    readonly templates: TemplatesService,
    readonly apiDrift: ApiDriftService,
    readonly compare: CompareService,
    readonly conflicts: ConflictsService,
    readonly trackers: TrackerRegistry,
    readonly access: AccessService,
    readonly testSuites: ApiTestSuitesService,
    readonly fixtures: ApiFixturesService,
    readonly decision: DecisionClient,
    readonly specDiff: ApiSpecDiffService,
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
  guidance(run: AgentRun, agent: ResolvedAgent): Promise<string> {
    // Rendered once per run, however many stages ask: the learnings stamped on
    // the run (#305) must be the ones every one of its calls was given.
    const ledger = this.ledgerOf(run);
    ledger.guidance ??= this.renderGuidance(run, agent, ledger);
    return ledger.guidance;
  }

  private async renderGuidance(run: AgentRun, agent: ResolvedAgent, ledger: RunLedger): Promise<string> {
    const [skills, projectIds] = await Promise.all([
      this.skills.forTurn(run.workspaceId, '', agent.skillIds),
      this.runProjects(run),
    ]);
    const [learnings, dismissed] = await Promise.all([
      this.learnings.promptFor({ workspaceId: run.workspaceId, agentKey: agent.key, projectIds }),
      this.learnings.dismissedPrompt(run.workspaceId, agent.key),
    ]);
    const skillText = this.skills.renderPrompt(skills);
    ledger.trusted.add(skillText);
    ledger.trusted.add(learnings.prompt);
    ledger.learningIds = learnings.learningIds;
    // The dismissed block is not hashed: its titles are the agent's earlier
    // words written from page content, quoted as data, and they change with
    // every dismissal. Hashing them would split one prompt into many.
    return skillText + learnings.prompt + dismissed;
  }

  /** The ledger of one run, created on first use. */
  private ledgerOf(run: AgentRun): RunLedger {
    let ledger = this.ledgers.get(run.id);
    if (!ledger) {
      ledger = { guidance: null, trusted: new Set(), learningIds: [] };
      this.ledgers.set(run.id, ledger);
    }
    return ledger;
  }

  /** Trusted text a run's prompt carries besides its guidance — a styleguide's rules. */
  trust(run: AgentRun, part: string): void {
    this.ledgerOf(run).trusted.add(part);
  }

  /**
   * Stamps what produced the run (#305): the model, the prompt hash and the
   * learnings rendered. Guarded on the run still being ours, like every write
   * the processor makes, and never thrown: attribution is observability, and
   * it must not fail a run that did its work.
   */
  protected async stamp(run: AgentRun, agent: ResolvedAgent): Promise<void> {
    const ledger = this.ledgers.get(run.id) ?? { guidance: null, trusted: new Set<string>(), learningIds: [] };
    this.ledgers.delete(run.id);
    try {
      await this.prisma.agentRun.updateMany({
        where: { id: run.id, status: 'running' },
        data: {
          providerId: agent.config.enabled ? agent.config.providerId : null,
          model: agent.config.enabled ? agent.config.model || null : null,
          promptHash: promptHashOf(agent.instructions, ledger.trusted),
          learningIds: ledger.learningIds,
        },
      });
    } catch (error) {
      this.logger.warn(`Agent run ${run.id} could not record its attribution: ${String(error)}`);
    }
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
  async runScope(run: AgentRun, principal: Principal): Promise<AccessScope> {
    return this.permissions.audienceScope(await this.permissions.scopeFor(principal, run.workspaceId), WORKSPACE_AUDIENCE);
  }

  /** The tool context every agent loop runs with: the owner, clamped like {@link runScope}. */
  toolCtx(run: AgentRun, principal: Principal) {
    return { principal, workspaceId: run.workspaceId, audience: WORKSPACE_AUDIENCE, channel: 'agent' as const };
  }

  /**
   * The one model call of a JSON-answering agent: a single JSON call for a
   * model that cannot call tools, else the tool loop with the contract on its
   * last round — `json: true` sets response_format, which suppresses tool
   * calls. `tools` defaults to the read tools, read only on the tool path.
   */
  async callModel(
    call: AiCallContext,
    agent: ResolvedAgent,
    messages: ChatCompletionMessageParam[],
    execute: ToolExecutor,
    tools?: ChatCompletionFunctionTool[],
  ): Promise<string> {
    if (agent.missing.includes('tools')) return this.client.chat(call, messages, { json: true });
    return (await this.client.runWithTools(call, messages, tools ?? this.readTools.definitions(), execute, { jsonFinalRound: true })).content;
  }

  /** The read tools as the run's owner, clamped like {@link runScope}. */
  readTool(run: AgentRun, principal: Principal) {
    return (name: string, args: Record<string, unknown>) => this.readTools.execute(name, args, this.toolCtx(run, principal));
  }

  /**
   * Whether a failed call ends the pass: every later call would fail the same
   * way when the provider refused the account, or — for a caller that passes
   * `budgetSpent` — when the workspace's budget is spent (429). Says so on the
   * run; anything else costs the caller one item, not the rest.
   */
  async stopsPass(error: unknown, report: AgentReporter, budgetSpent?: () => string): Promise<boolean> {
    if (budgetSpent && error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
      await report({ warning: budgetSpent() });
      return true;
    }
    if (error instanceof ProviderAccountError) {
      await report({ warning: t('agent.warning.stopped', { error: error.message }) });
      return true;
    }
    return false;
  }
}

/** What a warning shows: the message, never `ServiceUnavailableException: …`. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The page filter a page-scoped run (#70) adds to its gathering query, or
 * nothing. Spread beside the run's `visibilityWhere`, never instead of it:
 * naming a page the owner cannot open narrows the run to nothing, it does not
 * widen what the run may read.
 */
export function pageScope(run: AgentRun): { id?: { in: string[] } } {
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
