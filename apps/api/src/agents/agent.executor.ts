import { Injectable, Logger } from '@nestjs/common';
import type { AgentRun } from '@prisma/client';
import type { AgentFinding, AgentFindingKind, Locale } from '@knowledge/contracts';
import { AGENT_FINDING_KINDS } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { GraphService } from '../graph/graph.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { AgentRegistryService, type ResolvedAgent } from './agent-registry.service.js';

/**
 * Agents with a background executor. Exported so the API can refuse a run at
 * the point somebody asks for it, rather than accepting it and failing in the
 * worker a second later with nothing to show for the round trip.
 */
export const RUNNABLE_AGENTS = new Set(['curator']);

/** How many pages the curator will look at in one pass. */
const MAX_PAGES = 60;
/** How many it will describe to the model — the rest are summarised as counts. */
const MAX_DESCRIBED = 30;
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
  ) {}

  async run(run: AgentRun, agent: ResolvedAgent): Promise<AgentRunResult> {
    if (agent.key !== 'curator') {
      // Only the curator has a background executor so far. Failing loudly beats
      // running an agent as if it did something.
      throw new Error(`Agent "${agent.key}" has no background executor.`);
    }
    return this.curate(run, agent);
  }

  private async curate(run: AgentRun, agent: ResolvedAgent): Promise<AgentRunResult> {
    const documents = await this.prisma.document.findMany({
      where: { workspaceId: run.workspaceId },
      select: { id: true, title: true, category: true, projectId: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_PAGES,
    });
    if (documents.length === 0) {
      return { summary: 'This workspace has no pages yet.', findings: [] };
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
        title: `"${doc.title}" is not connected to anything`,
        detail:
          'This page declares no relations and nothing references it, so it will not surface through the ' +
          'graph — only through search. Adding a relation in its frontmatter puts it back on the map.',
        documentIds: [doc.id],
        documentTitles: [doc.title],
      });
    }

    // The judgement half: duplicates, contradictions and gaps across the recent
    // set. Skipped entirely when no model is configured — the orphan findings
    // above are still worth returning.
    let summary = `Looked at ${documents.length} pages. ${orphans.length} are unconnected.`;
    if (agent.config.enabled && agent.missing.length === 0) {
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
        const raw = await this.client.chat(
          {
            config: agent.config,
            userId: run.createdBy,
            operation: 'agent',
            locale: run.locale as Locale,
          },
          [
            { role: 'system', content: `${agent.instructions}\n\n${OUTPUT_CONTRACT}` },
            {
              role: 'user',
              content:
                (run.input && typeof (run.input as { note?: string }).note === 'string'
                  ? `Extra instructions: ${(run.input as { note?: string }).note}\n\n`
                  : '') +
                `Pages in this workspace (id | category | title | last updated):\n${listing}`,
            },
          ],
          { json: true },
        );
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
