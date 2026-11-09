import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma, type AgentRun } from '@prisma/client';
import type { AgentFinding, AgentRunDetails, AgentRunInput } from '@knowledge/contracts';
import { LISTED_PAGE } from '../../common/listed-page.js';
import { t } from '../../i18n/t.js';
import { visibilityWhere } from '../../permissions/access-scope.js';
import type { Principal } from '../../auth/principal.js';
import { type AgentServices, type AgentRunner, type AgentReporter, type AgentRunResult, MAX_FINDINGS, reasonOf, pageScope } from '../agent-services.js';

/** Pages the glossarist scans in one pass — also one model call each. */
const MAX_GLOSSARY_PAGES = 15;

export const glossaristRunner: AgentRunner = { key: 'glossarist', run: buildGlossary };

/**
 * Proposes glossary terms across the workspace's pages.
 *
 * This calls the very `GlossaryService.suggest` the settings page calls,
 * which is why GlossaryCoreModule exists: the prompt, the occurrence check
 * that drops ungrounded terms, and the "already defined in this project"
 * lookup are one implementation, not two. Terms are proposed as findings —
 * nothing is written to the glossary, exactly as a background agent never
 * writes. Each finding carries the term itself, so *Add to glossary* is a
 * person's click and not a second model call.
 *
 * Incremental (#74): a page whose head revision an earlier run already read
 * is skipped, so successive runs walk the whole workspace, most recently
 * active first, instead of rereading the same newest pages. The watermark is
 * the runs' own `details.glossaryScanned` — no column, no table. Pages a
 * person named on the run are read regardless: they asked.
 */
async function buildGlossary(
  svc: AgentServices,
  run: AgentRun,
  _agent: unknown,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  const scope = await svc.runScope(run, principal);
  const named = ((run.input ?? {}) as AgentRunInput).documentIds?.length ?? 0;
  const pages = (
    await svc.prisma.document.findMany({
      where: {
        workspaceId: run.workspaceId,
        kind: 'page',
        archivedAt: null,
        ...LISTED_PAGE,
        ...pageScope(run),
        AND: [visibilityWhere(scope)],
      },
      select: { id: true, title: true, defaultBranch: true, branches: { select: { name: true, headRevisionId: true } } },
      orderBy: { lastActivityAt: 'desc' },
    })
  )
    .map((p) => ({ id: p.id, title: p.title, headRevisionId: p.branches.find((b) => b.name === p.defaultBranch)?.headRevisionId ?? null }))
    .filter((p): p is typeof p & { headRevisionId: string } => p.headRevisionId !== null);
  if (pages.length === 0) return { summary: t('agent.curation.noPages'), findings: [] };

  const scannedBefore = named > 0 ? new Set<string>() : await glossaryScanned(svc, run.workspaceId, pages.map((p) => p.headRevisionId));
  const documents = pages.filter((p) => !scannedBefore.has(p.headRevisionId)).slice(0, MAX_GLOSSARY_PAGES);
  if (documents.length === 0) return { summary: t('agent.glossary.allScanned'), findings: [] };

  const findings: AgentFinding[] = [];
  // Proposed once per run: the same term found on four pages is one entry to
  // add, and four findings saying so is a wall, not a review.
  const seen = new Set<string>();
  // Recorded only once `suggest` answered, so a page that failed is read again next run.
  const scanned: string[] = [];
  const details = (): AgentRunDetails | undefined => (scanned.length > 0 ? { glossaryScanned: scanned } : undefined);

  for (const [at, doc] of documents.entries()) {
    if (findings.length >= MAX_FINDINGS) break;
    // Also one model call per page — the reviewer's shape, so the same
    // heartbeat (docs/features/29).
    await report({ stage: 'terms', progress: at / documents.length });
    try {
      const res = await svc.glossary.suggest(
        { workspaceId: run.workspaceId, documentId: doc.id, title: doc.title },
        principal,
      );
      // The provider is off for this workspace — every later page would say
      // the same, so stop rather than making the same failed call per page.
      if (!res.enabled) {
        return { summary: t('agent.glossary.disabled'), findings, details: details() };
      }
      scanned.push(doc.headRevisionId);
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
          // `suggest` takes the project from the page, so the term lands where it was found.
          ...(res.projectId
            ? { term: { term: s.term, aliases: s.aliases, definition: s.definition, projectId: res.projectId } }
            : {}),
        });
        if (findings.length >= MAX_FINDINGS) break;
      }
    } catch (error) {
      // A budget refusal is terminal — every later page would hit it too.
      // Matched on the status, not the message: the message is localized
      // (docs/features/18), so a text match would only work in English.
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        return {
          summary: t('agent.glossary.budgetSpent', { pages: t('agent.count.pages', { count: scanned.length }) }),
          findings,
          details: details(),
        };
      }
      if (await svc.stopsPass(error, report)) break;
      svc.logger.warn(`Glossarist could not scan "${doc.title}": ${String(error)}`);
      await report({ warning: t('agent.warning.pageNotScanned', { title: doc.title, error: reasonOf(error) }) });
    }
  }

  return {
    summary:
      findings.length === 0
        ? t('agent.glossary.nothingNew', { pages: t('agent.count.pages', { count: scanned.length }) })
        : t('agent.glossary.summary', {
            pages: t('agent.count.pages', { count: scanned.length }),
            terms: t('agent.count.terms', { count: findings.length }),
          }),
    findings,
    details: details(),
  };
}

/**
 * Which of these head revisions an earlier glossarist run already read.
 * Asked only about the candidates, so the answer stays as small as the
 * workspace however many runs there have been.
 */
async function glossaryScanned(svc: AgentServices, workspaceId: string, revisionIds: string[]): Promise<Set<string>> {
  if (revisionIds.length === 0) return new Set();
  const rows = await svc.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT rev AS id
      FROM agent_runs, jsonb_array_elements_text(COALESCE(details -> 'glossaryScanned', '[]'::jsonb)) AS rev
     WHERE workspace_id = ${workspaceId}::uuid
       AND agent_key = 'glossarist'
       AND status = 'succeeded'
       AND rev = ANY(${revisionIds}::text[])`);
  return new Set(rows.map((r) => r.id));
}
