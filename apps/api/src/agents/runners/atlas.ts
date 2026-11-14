import type { AgentRun } from '@prisma/client';
import type { Locale } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import type { StoredCommunity } from '../../graph/graph.service.js';
import { communityHierarchy, graphFingerprint, pagePairs } from '../communities.js';
import { wrapUntrusted } from '../../common/untrusted.js';
import { visibilityWhere } from '../../permissions/access-scope.js';
import type { ResolvedAgent } from '../agent-registry.service.js';
import type { Principal } from '../../auth/principal.js';
import { parseModelJson } from '../../common/model-json.js';
import type { AgentServices, AgentRunner, AgentReporter, AgentRunResult } from '../agent-services.js';

export const atlasRunner: AgentRunner = { key: 'atlas', run: chart };

/**
 * The atlas (#81, phase 7): communities of pages for global questions. The
 * grouping is deterministic — Louvain over the page-to-page projection of
 * the live graph, as the run's audience may see it, repeated on the
 * aggregated graph for the levels above (#475) — and skipped outright when
 * the projection's fingerprint is the one the stored communities were built
 * from. The model summarises each level-0 community from its pages' titles
 * and opening excerpts, and each community above from its children's
 * summaries; each summary is embedded so a question can find it. One
 * COMMUNITY_MAX_PER_RUN budget across levels, finest first. Written whole at
 * the end, so a failed run leaves the last good set.
 */
async function chart(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  if (!svc.config.get('COMMUNITY_SUMMARIES_ENABLED', { infer: true })) {
    return { summary: t('agent.charting.disabled'), findings: [] };
  }
  await report({ stage: 'scanning', progress: 0.05 });
  const scope = await svc.runScope(run, principal);
  const acl = await svc.permissions.documentFilterFor(scope);
  const graph = await svc.graph.getWorkspaceRelationGraph(run.workspaceId, acl);
  const pairs = pagePairs(graph.edges);
  const fingerprint = graphFingerprint(pairs);
  if ((await svc.graph.communityFingerprint(run.workspaceId)) === fingerprint) {
    return { summary: t('agent.charting.unchanged'), findings: [] };
  }
  const tree = communityHierarchy(pairs);
  if (tree.length === 0) return { summary: t('agent.charting.noCommunities'), findings: [] };
  const budget = svc.config.get('COMMUNITY_MAX_PER_RUN', { infer: true });

  // Titles from PG under the run's scope (#76); an opening excerpt per page
  // from its live chunks — the first chunk is the page's own introduction.
  // Level 0 holds every page of the tree.
  const memberIds = tree.filter((n) => n.level === 0).flatMap((n) => n.members);
  const docs = await svc.prisma.document.findMany({
    where: { id: { in: memberIds }, workspaceId: run.workspaceId, AND: [visibilityWhere(scope)] },
    select: { id: true, title: true },
  });
  const titleOf = new Map(docs.map((d) => [d.id, d.title]));
  const opening = new Map<string, { idx: number; text: string }>();
  for (const c of await svc.graph.liveChunks(run.workspaceId, acl)) {
    const held = opening.get(c.documentId);
    if (!held || c.idx < held.idx) opening.set(c.documentId, { idx: c.idx, text: c.text });
  }

  const call = { config: agent.config, userId: run.createdBy, operation: 'community' as const, locale: run.locale as Locale };
  const system = agent.instructions + (await svc.guidance(run, agent));
  const built = new Map<string, StoredCommunity & { embedding: number[] }>();
  let attempted = 0;
  let partial = false;
  for (const node of tree) {
    if (attempted >= budget) break;
    const pages = node.members.filter((m) => titleOf.has(m));
    // An upper community is written from its children's summaries, so it
    // needs two of them; level 0 needs two pages.
    const children = node.children.flatMap((id) => built.get(id) ?? []);
    if (node.level === 0 ? pages.length < 2 : children.length < 2) continue;
    attempted++;
    await report({ stage: 'summarising', progress: 0.1 + (0.85 * attempted) / Math.min(budget, tree.length) });
    const listing = (
      node.level === 0
        ? pages.slice(0, 25).map((id) => wrapUntrusted(`## ${titleOf.get(id)}\n${(opening.get(id)?.text ?? '').slice(0, 600)}`, 'atlas', 'page'))
        : children.slice(0, 25).map((c) => wrapUntrusted(`## ${c.title}\n${c.summary}`, 'atlas', 'page'))
    ).join('\n\n');
    try {
      const raw = await svc.client.chat(call, [{ role: 'system', content: system }, { role: 'user', content: listing }], { json: true });
      const parsed = parseModelJson(raw);
      const title = typeof parsed?.title === 'string' ? parsed.title.trim().slice(0, 120) : '';
      const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim().slice(0, 2_000) : '';
      if (!title || !summary) continue;
      built.set(node.id, {
        communityId: node.id,
        level: node.level,
        parentId: node.parentId,
        title,
        summary,
        members: pages,
        embedding: await svc.embedding.embed(`${title}\n${summary}`),
      });
    } catch (error) {
      if (await svc.stopsPass(error, report, () => t('agent.charting.budgetSpent', { done: built.size }))) {
        partial = true;
        break;
      }
      svc.logger.warn(`Atlas could not summarise one community: ${String(error)}`);
    }
  }
  if (built.size === 0) return { summary: t('agent.charting.noneWritten'), findings: [] };
  // A parent the budget or the model left unwritten makes its children
  // roots, so every stored non-root has a stored parent.
  const written = [...built.values()].map((c) => ({ ...c, parentId: c.parentId && built.has(c.parentId) ? c.parentId : null }));
  // A partial set is stored but not fingerprinted, so the next run finishes it.
  await svc.graph.replaceCommunities(run.workspaceId, written, partial ? '' : fingerprint);
  const pages = new Set(written.flatMap((c) => c.members)).size;
  return { summary: t('agent.charting.summary', { n: written.length, pages }), findings: [] };
}
