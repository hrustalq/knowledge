import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { MCP_LEARNING_TARGET, type AgentLearningArchiveCheck, type AgentLearningEvidenceRef, type Locale } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { AgentOutcomesService } from '../ai/agent-outcomes.service.js';
import { evidenceRefsOf } from '../ai/agent-learnings.service.js';
import { clampToAudience, systemScope, visibilitySql } from '../permissions/access-scope.js';
import { restrictedNodeIds } from '../permissions/acl-read.js';
import { listedSql } from '../common/listed-page.js';
import {
  clusterFindings,
  clusterLocale,
  coachInput,
  findingText,
  foldByEvidence,
  nearDuplicate,
  noDrop,
  qualifies,
  readCoachLearning,
  refKey,
  refOf,
  targetKey,
  type DismissedFinding,
  type FoldCandidate,
  type LearnerThresholds,
} from './learner-derive.js';

/**
 * No person proposed a derived learning, and `agent_learnings.created_by` is
 * NOT NULL: the zeros stub, the house spelling of "nobody" (merge requests,
 * share links). The coach's usage rows are billed to it for the same reason.
 */
export const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';
/** Texts sent to the embedding provider in one call. */
const EMBED_BATCH = 64;
/** Dismissed findings one workspace pass reads at most, newest first. */
const MAX_FINDINGS = 2_000;
const DAY_MS = 86_400_000;

interface FindingRow {
  run_id: string;
  finding_index: number;
  agent_key: string;
  project_id: string;
  kind: string | null;
  title: string | null;
  detail: string | null;
  dismissed_by: string | null;
  dismissed_at: Date;
  locale: string;
}

interface McpFailureRow {
  capture_id: string | null;
  feedback_id: string | null;
  project_id: string;
  kind: string | null;
  title: string | null;
  detail: string | null;
  dismissed_by: string;
  dismissed_at: Date;
}

/**
 * Who wrote a capture an MCP agent sent: not the in-app assistant and not a
 * chat harvest (#82, `origin` set) — those are the platform's own agents.
 */
const MCP_CAPTURE_SQL = Prisma.sql`c.origin IS NULL AND COALESCE(c.session->>'client', '') NOT IN ('assistant', 'chat')`;

export interface DerivationResult {
  proposed: number;
  folded: number;
  /** Clusters that qualified but the coach declined, or could not be asked. */
  declined: number;
}

/**
 * The learner's pass over one workspace (#305, phase 2). Two jobs, both only
 * ever proposals:
 *
 * - **Derivation.** Dismissed findings in the window, clustered per agent and
 *   project by raw cosine; a qualifying cluster that no existing learning rests
 *   on is worded by the `coach` and written as a `proposed`, `derived` row with
 *   its evidence. A cluster that shares a finding with a proposed or active
 *   learning folds into that row; one sharing a finding with an archived row
 *   is an admin's "no" and writes nothing.
 * - **Lifecycle.** An active learning with enough runs on each side of its
 *   activation and no drop in dismissals gets the proposed-archive flag.
 *
 * "The worker generates, the API publishes" holds: nothing here activates,
 * archives or attributes an act to a person. Activation stays admin-only on
 * the API's PATCH route.
 *
 * **ACL.** A finding enters derivation only when every page it cites exists in
 * the workspace, is listed, and is open to the whole workspace — the base
 * audience: no restricted node anywhere on its chain, so a restricted page and
 * its subtree never contribute. That is `visibilitySql` over the system scope
 * clamped to the workspace audience, applied in the query. The coach's "quote
 * nothing" rule is only a prompt; this filter is the enforcement.
 */
@Injectable()
export class LearnerService {
  private readonly logger = new Logger(LearnerService.name);
  private readonly t: LearnerThresholds;
  private readonly windowDays: number;
  private readonly minRuns: number;
  private readonly locale: Locale;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedding: EmbeddingProvider,
    private readonly agents: AgentRegistryService,
    private readonly client: AssistantClient,
    private readonly aiUsage: AiUsageService,
    private readonly outcomes: AgentOutcomesService,
    config: ConfigService<Env, true>,
  ) {
    this.t = {
      threshold: config.get('LEARNER_CLUSTER_THRESHOLD', { infer: true }),
      minDismissals: config.get('LEARNER_MIN_DISMISSALS', { infer: true }),
      minPeople: config.get('LEARNER_MIN_PEOPLE', { infer: true }),
    };
    this.windowDays = config.get('LEARNER_WINDOW_DAYS', { infer: true });
    this.minRuns = config.get('LEARNER_MIN_RUNS', { infer: true });
    this.locale = config.get('I18N_DEFAULT_LOCALE', { infer: true });
  }

  /** Every workspace, oldest first — the order a pass visits them in. */
  async workspaceIds(): Promise<string[]> {
    const rows = await this.prisma.workspace.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => r.id);
  }

  /** One workspace's pass: derivation, then the lifecycle check. */
  async pass(workspaceId: string, now = new Date()): Promise<DerivationResult & { flagged: number }> {
    const derived = await this.derive(workspaceId, now);
    const flagged = await this.checkLifecycle(workspaceId, now);
    return { ...derived, flagged };
  }

  /**
   * Dismissed findings in the window that may feed a learning: dismissed by a
   * person, citing at least one page, and every cited page visible to the
   * whole workspace. The project is the first cited page's.
   */
  async dismissedFindings(workspaceId: string, now = new Date()): Promise<DismissedFinding[]> {
    const scope = clampToAudience(systemScope(workspaceId), await restrictedNodeIds(this.prisma, workspaceId), new Set());
    const since = new Date(now.getTime() - this.windowDays * DAY_MS);
    const rows = await this.prisma.$queryRaw<FindingRow[]>`
      SELECT r.id AS run_id, (f.ord - 1)::int AS finding_index, r.agent_key, r.locale,
             f.finding->>'kind' AS kind, f.finding->>'title' AS title, f.finding->>'detail' AS detail,
             f.finding->>'dismissedBy' AS dismissed_by, (f.finding->>'dismissedAt')::timestamptz AS dismissed_at,
             first_page.project_id
        FROM agent_runs r
       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.findings) = 'array' THEN r.findings ELSE '[]'::jsonb END)
             WITH ORDINALITY AS f(finding, ord)
       CROSS JOIN LATERAL (
             SELECT d.project_id FROM documents d
              WHERE d.workspace_id = ${workspaceId}::uuid AND d.id::text = f.finding->'documentIds'->>0
       ) AS first_page
       WHERE r.workspace_id = ${workspaceId}::uuid
         AND r.status = 'succeeded'
         AND COALESCE(f.finding->>'dismissedAt', '') <> ''
         AND COALESCE(f.finding->>'dismissedBy', '') <> ''
         -- CASE, not AND: Postgres does not promise to test the emptiness first.
         AND CASE WHEN COALESCE(f.finding->>'dismissedAt', '') <> ''
                  THEN (f.finding->>'dismissedAt')::timestamptz >= ${since}::timestamptz ELSE FALSE END
         AND jsonb_typeof(f.finding->'documentIds') = 'array'
         AND jsonb_array_length(f.finding->'documentIds') > 0
         AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(f.finding->'documentIds') AS c(id)
                WHERE NOT EXISTS (
                      SELECT 1 FROM documents d
                       WHERE d.workspace_id = ${workspaceId}::uuid AND d.id::text = c.id
                         AND ${listedSql('d')} AND ${visibilitySql(scope, 'd')}
                )
         )
       ORDER BY dismissed_at DESC
       LIMIT ${MAX_FINDINGS}
    `;
    return rows.map((r) => ({
      runId: r.run_id,
      findingIndex: r.finding_index,
      agentKey: r.agent_key,
      projectId: r.project_id,
      kind: r.kind ?? 'other',
      title: r.title ?? '',
      detail: r.detail ?? '',
      dismissedBy: r.dismissed_by ?? '',
      dismissedAt: r.dismissed_at,
      locale: r.locale,
    }));
  }

  /**
   * The `mcp` target's failures in the window (#305, phase 3), in the shape of
   * a dismissed finding so they cluster the same way:
   *
   * - a capture an MCP agent sent that a person rejected in the inbox, or whose
   *   merge request a person closed unmerged — the person is the activity row's
   *   actor;
   * - a downvote on an answer built from `knowledge_search` (`surface: 'mcp'`
   *   with the search's `traceId`), its project the first cited page's.
   *
   * A `duplicate` capture is not here: dedupe worked, and counting it would
   * teach agents to stop capturing. The ACL rule is the findings' rule: every
   * page a row names — a capture's target, its payload's page ids, the page its
   * merge request proposes, an answer's citations — exists here, is open to the
   * whole workspace, and (but for a head-less proposed page) is listed; a
   * capture's project is not restricted.
   */
  async mcpFailures(workspaceId: string, now = new Date()): Promise<DismissedFinding[]> {
    const scope = clampToAudience(systemScope(workspaceId), await restrictedNodeIds(this.prisma, workspaceId), new Set());
    const since = new Date(now.getTime() - this.windowDays * DAY_MS);
    const denied = [...scope.denied];
    const openPage = (id: Prisma.Sql, listed = true) => Prisma.sql`EXISTS (
      SELECT 1 FROM documents d
       WHERE d.workspace_id = ${workspaceId}::uuid AND d.id::text = ${id}
         ${listed ? Prisma.sql`AND ${listedSql('d')}` : Prisma.empty} AND ${visibilitySql(scope, 'd')})`;
    const idsIn = (json: Prisma.Sql) =>
      Prisma.sql`jsonb_array_elements_text(CASE WHEN jsonb_typeof(${json}) = 'array' THEN ${json} ELSE '[]'::jsonb END)`;
    const rows = await this.prisma.$queryRaw<McpFailureRow[]>`
      SELECT c.id AS capture_id, NULL::uuid AS feedback_id, c.project_id, c.kind, c.title,
             a.metadata->>'reason' AS detail, a.actor AS dismissed_by, a.created_at AS dismissed_at
        FROM knowledge_captures c
        CROSS JOIN LATERAL (
              SELECT al.actor, al.created_at, al.metadata FROM activity_log al
               WHERE al.workspace_id = c.workspace_id
                 AND ((c.status = 'rejected' AND al.action = 'capture.rejected' AND al.subject_id = c.id)
                   OR (c.status = 'proposed' AND al.action = 'merge-request.closed' AND al.subject_id = c.merge_request_id
                       AND EXISTS (SELECT 1 FROM merge_requests mr WHERE mr.id = c.merge_request_id AND mr.status = 'closed')))
               ORDER BY al.created_at DESC
               LIMIT 1
        ) AS a
       WHERE c.workspace_id = ${workspaceId}::uuid
         AND ${MCP_CAPTURE_SQL}
         AND a.created_at >= ${since}::timestamptz
         AND a.actor <> ''
         ${denied.length ? Prisma.sql`AND NOT (c.project_id = ANY(${denied}::uuid[]))` : Prisma.empty}
         AND (c.target_document_id IS NULL OR ${openPage(Prisma.sql`c.target_document_id::text`)})
         AND (c.merge_request_id IS NULL OR EXISTS (
               SELECT 1 FROM merge_requests mr WHERE mr.id = c.merge_request_id AND ${openPage(Prisma.sql`mr.document_id::text`, false)}))
         AND NOT EXISTS (
               SELECT 1 FROM (
                 SELECT id FROM ${idsIn(Prisma.sql`c.payload->'citedDocumentIds'`)} AS x(id)
                 UNION ALL SELECT id FROM ${idsIn(Prisma.sql`c.payload->'relatedDocumentIds'`)} AS y(id)
                 UNION ALL SELECT c.payload->>'documentId' WHERE COALESCE(c.payload->>'documentId', '') <> ''
               ) AS named(id)
                WHERE NOT ${openPage(Prisma.sql`named.id`)})
      UNION ALL
      SELECT NULL::uuid, af.id, first_page.project_id, COALESCE(af.reason, 'other'), af.query,
             af.comment, af.created_by::text, af.created_at
        FROM answer_feedback af
        CROSS JOIN LATERAL (
              SELECT d.project_id FROM documents d
               WHERE d.workspace_id = ${workspaceId}::uuid AND d.id::text = af.cited_document_ids->>0
        ) AS first_page
       WHERE af.workspace_id = ${workspaceId}::uuid
         AND af.surface = 'mcp' AND af.kind = 'vote' AND af.rating = 'down'
         AND COALESCE(af.trace_id, '') <> ''
         AND af.created_at >= ${since}::timestamptz
         AND jsonb_typeof(af.cited_document_ids) = 'array'
         AND NOT EXISTS (SELECT 1 FROM ${idsIn(Prisma.sql`af.cited_document_ids`)} AS cited(id) WHERE NOT ${openPage(Prisma.sql`cited.id`)})
       ORDER BY dismissed_at DESC
       LIMIT ${MAX_FINDINGS}
    `;
    return rows.map((r) => ({
      ...(r.capture_id ? { captureId: r.capture_id } : { feedbackId: r.feedback_id! }),
      agentKey: MCP_LEARNING_TARGET,
      projectId: r.project_id,
      kind: r.kind ?? 'other',
      title: r.title ?? '',
      detail: r.detail ?? '',
      dismissedBy: r.dismissed_by,
      dismissedAt: r.dismissed_at,
      // No run, so no run locale: the deployment's.
      locale: this.locale,
    }));
  }

  async derive(workspaceId: string, now = new Date()): Promise<DerivationResult> {
    const result: DerivationResult = { proposed: 0, folded: 0, declined: 0 };
    const findings = (await Promise.all([this.dismissedFindings(workspaceId, now), this.mcpFailures(workspaceId, now)])).flat();
    if (findings.length < this.t.minDismissals) return result;

    const groups = new Map<string, DismissedFinding[]>();
    for (const f of findings) {
      const key = targetKey(f.agentKey, f.projectId);
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    // Only the groups that could hold a qualifying cluster are embedded.
    const eligible = [...groups.values()].filter((g) => g.length >= this.t.minDismissals);
    if (eligible.length === 0) return result;

    const learnings = await this.prisma.agentLearning.findMany({
      where: { workspaceId, OR: [{ status: { in: ['proposed', 'active'] } }, { evidence: { not: Prisma.DbNull } }] },
      select: { id: true, status: true, agentKey: true, projectId: true, text: true, evidence: true },
    });
    const candidates: FoldCandidate[] = learnings.map((l) => ({ ...l, evidence: evidenceRefsOf(l.evidence) }));
    const learningVectors = new Map<string, number[]>();

    for (const group of eligible) {
      const vectors = await this.embedAll(new Map(group.map((f) => [refKey(f), findingText(f)])));
      for (const cluster of clusterFindings(group, vectors, this.t.threshold)) {
        const decision = foldByEvidence(cluster, candidates);
        if (decision.kind === 'rejected') continue;
        if (decision.kind === 'fold') {
          if (decision.added.length && (await this.fold(decision.learningId, decision.added))) {
            candidates.find((c) => c.id === decision.learningId)?.evidence.push(...decision.added);
            result.folded += 1;
          }
          continue;
        }
        if (!qualifies(cluster, this.t)) continue;

        const text = await this.coach(workspaceId, cluster);
        if (!text) {
          result.declined += 1;
          continue;
        }
        const refs = cluster.map(refOf);
        const { agentKey, projectId } = cluster[0];
        // A draft saying what a proposed or active learning for the same agent
        // and project already says folds into that one.
        const same = learnings.filter(
          (l) => l.status !== 'archived' && l.agentKey === agentKey && l.projectId === projectId,
        );
        const missing = same.filter((l) => !learningVectors.has(l.id));
        if (missing.length) {
          const embedded = await this.embedAll(new Map(missing.map((l) => [l.id, l.text])));
          for (const [id, v] of embedded) learningVectors.set(id, v);
        }
        const [draftVector] = await this.embedding.embedBatch([text]);
        const dup = nearDuplicate(
          draftVector ?? [],
          same.flatMap((l) => (learningVectors.has(l.id) ? [{ id: l.id, vector: learningVectors.get(l.id)! }] : [])),
          this.t.threshold,
        );
        if (dup) {
          if (await this.fold(dup, refs)) {
            candidates.find((c) => c.id === dup)?.evidence.push(...refs);
            result.folded += 1;
          }
          continue;
        }
        const row = await this.prisma.agentLearning.create({
          data: {
            workspaceId,
            agentKey,
            projectId,
            text,
            status: 'proposed',
            sourceKind: 'derived',
            evidence: refs as unknown as Prisma.InputJsonValue,
            createdBy: AUTHOR_ID_STUB,
          },
          select: { id: true, status: true, agentKey: true, projectId: true, text: true, evidence: true },
        });
        learnings.push(row);
        candidates.push({ ...row, evidence: [...refs] });
        if (draftVector) learningVectors.set(row.id, draftVector);
        result.proposed += 1;
      }
    }
    if (result.proposed || result.folded) this.logger.log({ msg: 'learner derivation', workspaceId, ...result });
    return result;
  }

  /**
   * Adds refs to a proposed or active learning's evidence in one guarded
   * statement, de-duplicated in SQL, so a repeat changes nothing. Never the
   * text: folding is evidence, and an active learning's words stay the ones
   * an admin approved.
   */
  private async fold(learningId: string, refs: AgentLearningEvidenceRef[]): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE agent_learnings
         SET evidence = (
               SELECT jsonb_agg(DISTINCT e)
                 FROM jsonb_array_elements(COALESCE(evidence, '[]'::jsonb) || ${JSON.stringify(refs)}::jsonb) AS e
             ),
             updated_at = now()
       WHERE id = ${learningId}::uuid AND status IN ('proposed', 'active')
    `;
    return affected > 0;
  }

  /**
   * One coach call for one cluster, or null: the agent switched off, no
   * provider, the budget spent, a provider error, or the coach declining.
   * Billed to no person (`AUTHOR_ID_STUB`), as `coach`.
   */
  private async coach(workspaceId: string, cluster: DismissedFinding[]): Promise<string | null> {
    try {
      const agent = await this.agents.resolve(workspaceId, 'coach');
      if (!agent.enabled || !agent.config.enabled) return null;
      await this.aiUsage.assertWithinBudget(workspaceId, AUTHOR_ID_STUB);
      const raw = await this.client.chat(
        {
          config: agent.config,
          userId: AUTHOR_ID_STUB,
          operation: 'coach',
          locale: clusterLocale(cluster, this.locale) as Locale,
        },
        [
          { role: 'system', content: agent.instructions },
          { role: 'user', content: coachInput(cluster[0].agentKey, cluster) },
        ],
        { json: true },
      );
      return readCoachLearning(raw);
    } catch (error) {
      this.logger.warn({ msg: 'learner coach call failed', workspaceId, error: String(error) });
      return null;
    }
  }

  /**
   * Proposed archiving (#305): every active learning not already flagged, not
   * kept by an admin since its approval, with at least LEARNER_MIN_RUNS runs on
   * each side of its activation and no drop in dismissals, gets the flag. One
   * guarded statement each; the learning stays active either way.
   */
  async checkLifecycle(workspaceId: string, now = new Date()): Promise<number> {
    const active = await this.prisma.agentLearning.findMany({
      where: { workspaceId, status: 'active', archiveProposedAt: null, approvedAt: { not: null } },
      select: { id: true, agentKey: true, approvedAt: true, archiveCheck: true },
    });
    let flagged = 0;
    for (const l of active) {
      if ((l.archiveCheck as AgentLearningArchiveCheck | null)?.keptAt) continue;
      const counts = await this.outcomes.beforeAfter(workspaceId, { id: l.id, agentKey: l.agentKey, approvedAt: l.approvedAt! }, now);
      if (noDrop(counts, this.minRuns) !== true) continue;
      const check: AgentLearningArchiveCheck = { ...counts, checkedAt: now.toISOString() };
      const { count } = await this.prisma.agentLearning.updateMany({
        where: { id: l.id, status: 'active', archiveProposedAt: null },
        data: { archiveProposedAt: now, archiveCheck: check as unknown as Prisma.InputJsonValue },
      });
      flagged += count;
    }
    if (flagged) this.logger.log({ msg: 'learner proposed archiving', workspaceId, flagged });
    return flagged;
  }

  /** Embeds texts in batches, keyed as given. */
  private async embedAll(texts: Map<string, string>): Promise<Map<string, number[]>> {
    const entries = [...texts];
    const out = new Map<string, number[]>();
    for (let i = 0; i < entries.length; i += EMBED_BATCH) {
      const batch = entries.slice(i, i + EMBED_BATCH);
      const vectors = await this.embedding.embedBatch(batch.map(([, text]) => text));
      batch.forEach(([key], j) => {
        if (vectors[j]) out.set(key, vectors[j]);
      });
    }
    return out;
  }
}
