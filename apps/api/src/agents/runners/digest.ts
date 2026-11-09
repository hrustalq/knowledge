import type { AgentRun } from '@prisma/client';
import type { Locale } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { visibilityWhere } from '../../permissions/access-scope.js';
import type { ResolvedAgent } from '../agent-registry.service.js';
import type { Principal } from '../../auth/principal.js';
import { DIGEST_OUTPUT_CONTRACT, MAX_DIGEST_MERGES, MAX_DIGEST_PAGES, digestKnown, digestListing, digestMarkdown, digestSince, highlightFinding, isQuietDigest, isoDay, readDigestHighlights, type DigestFacts, type DigestHighlight } from '../digest.js';
import { parseModelJson } from '../../common/model-json.js';
import { type AgentServices, type AgentRunner, type AgentReporter, type AgentRunResult, reasonOf, runBrief } from '../agent-services.js';

export const digestRunner: AgentRunner = { key: 'digest', run: digest };

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
async function digest(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  await report({ stage: 'scanning', progress: 0.05 });
  const facts = await digestFacts(svc, run, principal);
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
            await svc.guidance(run, agent),
        },
        { role: 'user', content: runBrief(run.input) + digestListing(facts) },
      ];
      const raw = await svc.callModel(call, agent, messages, svc.readTool(run, principal));
      const parsed = parseModelJson(raw);
      highlights = readDigestHighlights(parsed, known);
      if (typeof parsed?.summary === 'string' && parsed.summary.trim()) {
        summary = parsed.summary.trim().slice(0, 2_000);
      }
    } catch (error) {
      // The lists are the digest's facts and stand without the model.
      svc.logger.warn(`Digest model pass failed: ${String(error)}`);
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
async function digestFacts(svc: AgentServices, run: AgentRun, principal: Principal): Promise<DigestFacts> {
  const until = new Date();
  const previous = await svc.prisma.agentRun.findFirst({
    where: { workspaceId: run.workspaceId, agentKey: 'digest', status: 'succeeded', id: { not: run.id } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const since = digestSince(previous?.createdAt ?? null, until);
  const scope = await svc.runScope(run, principal);
  const visible = { workspaceId: run.workspaceId, archivedAt: null, AND: [visibilityWhere(scope)] };
  const page = { id: true, title: true, category: true } as const;

  const [created, revisions, merged, runs, agents] = await Promise.all([
    svc.prisma.document.findMany({
      where: { ...visible, createdAt: { gte: since } },
      select: { ...page, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_DIGEST_PAGES,
    }),
    // Indexed revisions only — a draft that never reached the index changed
    // nothing a reader can see. Bounded; the default-branch check is a
    // column-to-column compare Prisma cannot express, so it runs below.
    svc.prisma.documentRevision.findMany({
      where: { createdAt: { gte: since }, status: 'indexed', document: visible },
      select: { documentId: true, branch: { select: { name: true } }, document: { select: { ...page, defaultBranch: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
    svc.prisma.mergeRequest.findMany({
      where: { status: 'merged', mergedAt: { gte: since }, document: visible },
      select: { title: true, mergedAt: true, document: { select: page } },
      orderBy: { mergedAt: 'desc' },
      take: MAX_DIGEST_MERGES,
    }),
    svc.prisma.agentRun.findMany({
      where: {
        workspaceId: run.workspaceId,
        status: 'succeeded',
        finishedAt: { gte: since },
        agentKey: { not: 'digest' },
      },
      select: { agentKey: true, findings: true },
      take: 200,
    }),
    svc.registry.list(run.workspaceId),
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
