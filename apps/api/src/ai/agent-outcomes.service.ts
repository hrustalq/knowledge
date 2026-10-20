import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AGENT_OUTCOME_MIN_RUNS,
  AGENT_OUTCOME_SETTLE_DAYS,
  AGENT_OUTCOMES,
  type AgentOutcome,
  type AgentOutcomeGroup,
  type AgentOutcomeSource,
  type AgentOutcomeSplit,
  type AgentOutcomesResponse,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';

/** The window when the caller names none. */
const DEFAULT_SINCE_DAYS = 90;

export interface AgentOutcomesQuery {
  workspaceId: string;
  agentKey?: string;
  projectId?: string;
  since?: string;
  split?: AgentOutcomeSplit;
}

/**
 * `outcomeFor` in SQL (#305), clause for clause, over the aliases the queries
 * below use: `f.finding` (one element of `agent_runs.findings`), `mr` (the
 * merge request it was proposed as, LEFT JOINed), `r` (its run), `af` (an
 * `answer_feedback` vote). The two must agree; `agent-outcomes.e2e-spec.ts`
 * runs this CASE in Postgres against `outcomeFor` over the same rows.
 */
export function outcomeCaseSql(source: AgentOutcomeSource, now: Date): Prisma.Sql {
  if (source === 'answer') {
    return Prisma.sql`CASE WHEN af.rating = 'up' THEN 'accepted' WHEN af.rating = 'down' THEN 'downvoted' ELSE 'pending' END`;
  }
  const settled = new Date(now.getTime() - AGENT_OUTCOME_SETTLE_DAYS * 86_400_000);
  return Prisma.sql`CASE
    WHEN COALESCE(f.finding->>'dismissedAt', '') <> '' THEN 'dismissed'
    WHEN mr.status = 'merged' THEN 'accepted'
    WHEN mr.status = 'closed' THEN 'dismissed'
    WHEN mr.status IS NOT NULL THEN 'pending'
    WHEN r.finished_at <= ${settled}::timestamptz THEN 'accepted'
    ELSE 'pending'
  END`;
}

/** The inverse: the rows `outcomeFor` files under `outcome`, as a predicate. */
export function outcomeFilterSql(source: AgentOutcomeSource, outcome: AgentOutcome, now: Date): Prisma.Sql {
  return Prisma.sql`(${outcomeCaseSql(source, now)}) = ${outcome}`;
}

/** A finding's elements, tolerating a run whose findings column is null or not an array. */
const FINDINGS = Prisma.sql`jsonb_array_elements(CASE WHEN jsonb_typeof(r.findings) = 'array' THEN r.findings ELSE '[]'::jsonb END)`;

/** The merge request a finding was proposed as. The guard keeps a malformed id from failing the cast. */
const FINDING_MR = Prisma.sql`LEFT JOIN merge_requests mr ON mr.id = (
  CASE WHEN f.finding->>'mergeRequestId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       THEN (f.finding->>'mergeRequestId')::uuid END)`;

interface CountRow {
  agent_key: string | null;
  split: string | null;
  n: number;
  accepted?: number;
  dismissed?: number;
  downvoted?: number;
  pending?: number;
}

/**
 * The ledger's read side (#305): what became of each agent's output.
 *
 * No ledger table and no stored aggregate: a `Promise.all` of three grouped
 * counts over rows that already exist — succeeded runs (the n), their findings
 * per outcome, and votes on answers per outcome. The outcome of each row is
 * `outcomeCaseSql`, derived on read; nothing classified is ever written.
 *
 * Counts only, never a title, so a page an admin may not open costs nothing
 * here. A project narrows findings to those citing one of its pages (and the
 * runs to those that produced one), and answers to those citing one.
 */
@Injectable()
export class AgentOutcomesService {
  constructor(private readonly prisma: PrismaService) {}

  async outcomes(query: AgentOutcomesQuery, now = new Date()): Promise<AgentOutcomesResponse> {
    const split = query.split ?? 'none';
    const since = query.since ? new Date(query.since) : new Date(now.getTime() - DEFAULT_SINCE_DAYS * 86_400_000);
    const ws = query.workspaceId;

    const runSplit =
      split === 'prompt' ? Prisma.sql`r.prompt_hash` : split === 'model' ? Prisma.sql`r.model` : Prisma.sql`NULL::text`;
    const answerSplit = split === 'model' ? Prisma.sql`af.model` : Prisma.sql`NULL::text`;

    const inProject = (ids: Prisma.Sql) =>
      Prisma.sql`EXISTS (
        SELECT 1 FROM documents d
         WHERE d.workspace_id = ${ws}::uuid AND d.project_id = ${query.projectId}::uuid
           AND d.id::text IN (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(${ids}) = 'array' THEN ${ids} ELSE '[]'::jsonb END))
      )`;
    const findingInProject = query.projectId ? inProject(Prisma.sql`f.finding->'documentIds'`) : null;

    const runWhere = Prisma.sql`r.workspace_id = ${ws}::uuid AND r.status = 'succeeded' AND r.created_at >= ${since}::timestamptz
      ${query.agentKey ? Prisma.sql`AND r.agent_key = ${query.agentKey}` : Prisma.empty}`;

    const counted = (source: AgentOutcomeSource) =>
      Prisma.join(
        AGENT_OUTCOMES.map(
          (o) => Prisma.sql`count(*) FILTER (WHERE ${outcomeFilterSql(source, o, now)})::int AS ${Prisma.raw(`"${o}"`)}`,
        ),
      );

    const runsQuery = this.prisma.$queryRaw<CountRow[]>`
      SELECT r.agent_key, ${runSplit} AS split, count(*)::int AS n
        FROM agent_runs r
       WHERE ${runWhere}
         ${findingInProject ? Prisma.sql`AND EXISTS (SELECT 1 FROM ${FINDINGS} AS f(finding) WHERE ${findingInProject})` : Prisma.empty}
       GROUP BY 1, 2
    `;
    const findingsQuery = this.prisma.$queryRaw<CountRow[]>`
      SELECT r.agent_key, ${runSplit} AS split, count(*)::int AS n, ${counted('finding')}
        FROM agent_runs r
       CROSS JOIN LATERAL ${FINDINGS} AS f(finding)
       ${FINDING_MR}
       WHERE ${runWhere}
         ${findingInProject ? Prisma.sql`AND ${findingInProject}` : Prisma.empty}
       GROUP BY 1, 2
    `;
    // Answers carry no agent key, so naming an agent leaves them out.
    const answersQuery: Promise<CountRow[]> = query.agentKey
      ? Promise.resolve([])
      : this.prisma.$queryRaw<CountRow[]>`
          SELECT NULL::text AS agent_key, ${answerSplit} AS split, count(*)::int AS n, ${counted('answer')}
            FROM answer_feedback af
           WHERE af.workspace_id = ${ws}::uuid AND af.kind = 'vote' AND af.created_at >= ${since}::timestamptz
             ${query.projectId ? Prisma.sql`AND ${inProject(Prisma.sql`af.cited_document_ids`)}` : Prisma.empty}
           GROUP BY 1, 2
        `;

    const [runs, findings, answers] = await Promise.all([runsQuery, findingsQuery, answersQuery]);

    const key = (agentKey: string | null, s: string | null) => `${agentKey ?? ''}\u0000${s ?? ''}`;
    const groups = new Map<string, AgentOutcomeGroup>();
    const groupFor = (source: AgentOutcomeSource, agentKey: string | null, s: string | null): AgentOutcomeGroup => {
      const k = `${source}\u0000${key(agentKey, s)}`;
      let g = groups.get(k);
      if (!g) {
        g = {
          source,
          agentKey,
          promptHash: split === 'prompt' ? s : null,
          model: split === 'model' ? s : null,
          runs: 0,
          counts: { accepted: 0, dismissed: 0, downvoted: 0, pending: 0 },
        };
        groups.set(k, g);
      }
      return g;
    };
    for (const row of runs) groupFor('finding', row.agent_key, row.split).runs = row.n;
    const add = (g: AgentOutcomeGroup, row: CountRow) => {
      for (const o of AGENT_OUTCOMES) g.counts[o] += row[o] ?? 0;
    };
    for (const row of findings) add(groupFor('finding', row.agent_key, row.split), row);
    for (const row of answers) {
      const g = groupFor('answer', null, row.split);
      g.runs = row.n;
      add(g, row);
    }

    const ordered = [...groups.values()].sort(
      (a, b) =>
        (a.source === b.source ? 0 : a.source === 'finding' ? -1 : 1) ||
        (a.agentKey ?? '').localeCompare(b.agentKey ?? '') ||
        b.runs - a.runs,
    );
    return {
      workspaceId: ws,
      since: since.toISOString(),
      split,
      settleDays: AGENT_OUTCOME_SETTLE_DAYS,
      minRuns: AGENT_OUTCOME_MIN_RUNS,
      groups: ordered,
    };
  }
}
