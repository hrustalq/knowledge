import type { AgentRun } from '@prisma/client';
import { type AgentFinding, type AgentFindingKind, type AssistantWebSource, type Locale, AGENT_FINDING_KINDS } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { visibilityWhere } from '../../permissions/access-scope.js';
import type { ResolvedAgent } from '../agent-registry.service.js';
import type { Principal } from '../../auth/principal.js';
import { parseModelJson } from '../../common/model-json.js';
import { type AgentServices, type AgentRunner, type AgentReporter, type AgentRunResult, MAX_FINDINGS, reasonOf, pageScope, runBrief } from '../agent-services.js';

/** How many pages the curator will look at in one pass. */
export const MAX_PAGES = 60;

/** How many it will describe to the model — the rest are summarised as counts. */
export const MAX_DESCRIBED = 30;

/** Web citations kept on one finding — the reader is checking a claim, not reading a bibliography. */
const MAX_SOURCES_PER_FINDING = 8;

const OUTPUT_CONTRACT =
  'Respond ONLY with a json object of the shape ' +
  '{"summary": string, "findings": [{"kind": "duplicate"|"contradiction"|"gap"|"stale"|"other", ' +
  '"severity": "info"|"warning"|"error", "title": string, "detail": string, "documentIds": string[]}]}. ' +
  'Every finding MUST cite at least one page id from the list, copied exactly. ' +
  'A finding you cannot tie to a listed page must be left out. ' +
  'You are looking at titles and dates only — say what they suggest, and never assert what a page ' +
  'contains as though you had read it. At most 12 findings; returning none is a valid answer.';

export const curatorRunner: AgentRunner = { key: 'curator', run: curate };

async function curate(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  await report({ stage: 'scanning', progress: 0.05 });
  const scope = await svc.runScope(run, principal);
  const documents = await svc.prisma.document.findMany({
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
  const latest = await svc.prisma.documentRevision.groupBy({
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
    const relations = await svc.graph.getWorkspaceRelationGraph(
      run.workspaceId,
      await svc.permissions.documentFilterFor(scope),
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
    svc.logger.warn(`Curator could not read the relation graph: ${String(error)}`);
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
            await svc.guidance(run, agent),
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
      const raw = await svc.callModel(call, agent, messages, svc.readTool(run, principal));
      const parsed = parseModelJson(raw);
      const proposals = Array.isArray(parsed?.findings) ? (parsed.findings as unknown[]) : [];
      const known = new Map(documents.map((d) => [d.id, d.title]));
      for (const proposal of proposals) {
        const finding = readFinding(proposal, known);
        if (!finding) continue; // ungrounded or malformed — dropped, never shown
        findings.push(finding);
        if (findings.length >= MAX_FINDINGS) break;
      }
      if (typeof parsed?.summary === 'string' && parsed.summary.trim()) {
        summary = parsed.summary.trim().slice(0, 2_000);
      }
    } catch (error) {
      // A flaky model must not lose the deterministic findings already made.
      svc.logger.warn(`Curator model pass failed: ${String(error)}`);
      summary += ` ${t('agent.warning.modelPassFailedStructuralOnly')}`;
      await report({ warning: t('agent.warning.modelPassFailed', { error: reasonOf(error) }) });
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
export function readFinding(value: unknown, known: Map<string, string>): AgentFinding | null {
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
