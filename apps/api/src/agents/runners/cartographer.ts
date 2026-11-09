import type { AgentRun } from '@prisma/client';
import { type AgentFinding, type AuthorableRelationType, type Locale, type RelationInput, isAuthorableRelationType } from '@knowledge/contracts';
import { normalizeRelation } from '../../common/relations.js';
import { t } from '../../i18n/t.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { visibilityWhere } from '../../permissions/access-scope.js';
import type { ResolvedAgent } from '../agent-registry.service.js';
import type { Principal } from '../../auth/principal.js';
import { parseModelJson } from '../../common/model-json.js';
import { type AgentServices, type AgentRunner, type AgentReporter, type AgentRunResult, MAX_FINDINGS, reasonOf, runBrief } from '../agent-services.js';
import { MAX_DESCRIBED, MAX_PAGES, readFinding } from './curator.js';

const RELATION_OUTPUT_CONTRACT =
  'Respond ONLY with a json object of the shape ' +
  '{"summary": string, "findings": [{"kind": "relation", "severity": "info"|"warning", "title": string, ' +
  '"detail": string, "documentIds": string[], "relations": [{"type": string, "targetKey": string}]}]}. ' +
  'Every finding MUST cite at least one page id from the list, copied exactly, and the FIRST id is the page ' +
  'whose frontmatter would gain the relations. Every finding MUST carry at least one relation; a finding ' +
  'with none is dropped. Do not propose a relation the page already declares — they are listed beside it. ' +
  'You are looking at titles, categories and existing relations only: propose a connection where those give ' +
  'you real grounds, and leave it out otherwise. At most 12 findings; returning none is a valid answer.';

export const cartographerRunner: AgentRunner = { key: 'cartographer', run: mapRelations };

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
async function mapRelations(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  await report({ stage: 'scanning', progress: 0.05 });
  const scope = await svc.runScope(run, principal);
  const documents = await svc.prisma.document.findMany({
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
    const graph = await svc.graph.getWorkspaceRelationGraph(
      run.workspaceId,
      await svc.permissions.documentFilterFor(scope),
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
    svc.logger.warn(`Cartographer could not read the relation graph: ${String(error)}`);
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
            await svc.guidance(run, agent),
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
      const raw = await svc.callModel(call, agent, messages, svc.readTool(run, principal));

      const parsed = parseModelJson(raw);
      for (const proposal of Array.isArray(parsed?.findings) ? (parsed.findings as unknown[]) : []) {
        const finding = readRelationFinding(proposal, known);
        if (!finding) continue;
        findings.push(finding);
        if (findings.length >= MAX_FINDINGS) break;
      }
      if (typeof parsed?.summary === 'string' && parsed.summary.trim()) {
        summary = parsed.summary.trim().slice(0, 2_000);
      }
    } catch (error) {
      svc.logger.warn(`Cartographer model pass failed: ${String(error)}`);
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
function readRelationFinding(value: unknown, known: Map<string, string>): AgentFinding | null {
  const base = readFinding(value, known);
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
