import type { AgentFinding, AgentRunPullRequest, ApiDriftSpec, DriftAffectedUsages } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';

/**
 * The comment a drift check leaves on a pull request (docs/features/35).
 *
 * Pure, so the wording can be tested without a host, and translated through
 * `t()` in the run's frozen locale — the comment is read by the same team that
 * reads the product.
 */

/**
 * How the one comment is found again. Keyed by connector, so two workspaces
 * (or two connectors) watching one repository keep a comment each rather than
 * overwriting each other's.
 */
export function driftCommentMarker(connectorId: string): string {
  return `<!-- knowledge:drift-check:${connectorId} -->`;
}

export interface DriftReportEntry {
  finding: AgentFinding;
  /** The knowledge-base merge request proposing the fix, when there is one. */
  mergeRequestId: string | null;
}

/** Pages the Affected usages section lists before it only counts them; usage files per page likewise. */
const MAX_AFFECTED_PAGES = 15;
const MAX_SITES_PER_PAGE = 3;

export function renderDriftComment(input: {
  webBaseUrl: string;
  connectorName: string;
  pullRequest: AgentRunPullRequest;
  entries: DriftReportEntry[];
  /** Where the changed component code is used (#236); absent when the change touched none. */
  affected?: DriftAffectedUsages | null;
  /** The specs the change ties (#78, phase 8): their own diff and what they now disagree with. */
  apiSpecs?: ApiDriftSpec[] | null;
}): string {
  const base = input.webBaseUrl.replace(/\/+$/, '');
  const sha = input.pullRequest.headSha.slice(0, 7);
  const lines = [`### ${t('agent.drift.comment.heading')}`, ''];
  const usages = [
    ...(input.affected ? affectedSection(input.affected, base) : []),
    ...apiSection(input.apiSpecs ?? [], base),
  ];

  if (input.entries.length === 0) {
    lines.push(t('agent.drift.comment.clean', { sha, connector: input.connectorName }));
    if (usages.length > 0) lines.push('', ...usages, '', `<sub>${t('agent.drift.comment.footer')}</sub>`);
    return lines.join('\n');
  }

  lines.push(t('agent.drift.comment.intro', { sha, count: input.entries.length, connector: input.connectorName }), '');
  for (const { finding, mergeRequestId } of input.entries) {
    const id = finding.documentIds[0];
    const title = finding.documentTitles[0] ?? finding.title;
    const page = id ? `[${escapeLink(title)}](${base}/documents/${id})` : escapeLink(title);
    const fix = mergeRequestId
      ? ` · [${t('agent.drift.comment.proposed')}](${base}/merge-requests/${mergeRequestId})`
      : '';
    // One line per page: the detail is a paragraph, and a pull request
    // comment that scrolls is one nobody reads to the end.
    lines.push(`- ${page}${fix}  \n  ${oneLine(finding.detail)}`);
  }
  if (usages.length > 0) lines.push('', ...usages);
  lines.push('', `<sub>${t('agent.drift.comment.footer')}</sub>`);
  return lines.join('\n');
}

/**
 * Affected usages (#236): the files that use the changed component code,
 * grouped by the page documenting them, so a reviewer sees which docs sit
 * downstream of the change even where nothing has drifted yet. A page the
 * check did not read — past the page cap, or with no model — says so; a page
 * the run's owner may not open is a count; a usage file no page documents is
 * listed on its own line.
 */
function affectedSection(affected: DriftAffectedUsages, base: string): string[] {
  const lines: string[] = [];
  for (const page of affected.pages.slice(0, MAX_AFFECTED_PAGES)) {
    const sites = andMore(page.sites.map(code), MAX_SITES_PER_PAGE);
    const uses = t('agent.drift.comment.uses', { files: andMore(page.uses.map(code), MAX_SITES_PER_PAGE) });
    const unread = page.judged ? '' : ` · _${t('agent.drift.comment.notChecked')}_`;
    lines.push(`- [${escapeLink(page.title)}](${base}/documents/${page.documentId}) — ${sites} · ${uses}${unread}`);
  }
  const more = affected.pages.length - MAX_AFFECTED_PAGES;
  if (more > 0) lines.push(`- ${t('agent.drift.comment.morePages', { count: more })}`);
  if (affected.hiddenPages > 0) lines.push(`- ${t('agent.drift.comment.hiddenPages', { count: affected.hiddenPages })}`);
  if (affected.undocumentedTotal > 0) {
    const shown = affected.undocumented.map(code);
    const rest = affected.undocumentedTotal - shown.length;
    const files = rest > 0 ? t('agent.drift.comment.andMore', { list: shown.join(', '), count: rest }) : shown.join(', ');
    lines.push(`- ${t('agent.drift.comment.undocumented', { files })}`);
  }
  if (lines.length === 0) return [];
  return [`#### ${t('agent.drift.comment.usagesHeading')}`, '', t('agent.drift.comment.usagesIntro'), '', ...lines];
}

/** Whether a spec has anything for the comment to say: its own diff, or a disagreement the change introduced. */
export function apiSpecWorthListing(spec: ApiDriftSpec): boolean {
  const changes = spec.changes ? spec.changes.breaking + spec.changes.nonBreaking + spec.changes.info : 0;
  return changes > 0 || spec.mismatchTotal > 0;
}

/**
 * API specs (#78, phase 8): per spec the change ties, the classified diff of
 * the spec file when the change edits it, and how many disagreements with the
 * routes it introduces. The disagreements themselves are the spec's line in
 * the findings above; this is the summary a reviewer of the spec reads.
 */
function apiSection(specs: ApiDriftSpec[], base: string): string[] {
  const lines: string[] = [];
  for (const spec of specs.filter(apiSpecWorthListing)) {
    const parts: string[] = [];
    if (spec.changes) parts.push(t('agent.drift.comment.apiChanges', { breaking: spec.changes.breaking, nonBreaking: spec.changes.nonBreaking }));
    if (spec.routes === 0) parts.push(`_${t('agent.drift.comment.apiNoRoutes')}_`);
    else if (spec.mismatchTotal > 0) parts.push(t('agent.drift.comment.apiDisagreements', { count: spec.mismatchTotal }));
    else parts.push(t('agent.drift.comment.apiAgrees'));
    lines.push(`- [${escapeLink(spec.title)}](${base}/documents/${spec.documentId}) ${code(spec.specPath)} — ${parts.join(' · ')}`);
  }
  if (lines.length === 0) return [];
  return [`#### ${t('agent.drift.comment.apiHeading')}`, '', ...lines];
}

/** A path as inline code. A backtick cannot appear in one, so it cannot close the span early. */
function code(path: string): string {
  return `\`${path.replace(/`/g, '')}\``;
}

function andMore(items: string[], max: number): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? t('agent.drift.comment.andMore', { list: shown, count: items.length - max }) : shown;
}

/** Text from a model inside a link label must not close the label or open another. */
function escapeLink(text: string): string {
  return text.replace(/[[\]]/g, '\\$&');
}

/**
 * A model's detail, made safe to put on one list line of a stranger's pull
 * request: no line breaks, no raw HTML, and no `@mention` that would notify
 * somebody because a page happened to contain a handle.
 */
function oneLine(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/</g, '&lt;')
    .replace(/@(?=\w)/g, '@​')
    .trim()
    .slice(0, 400);
}
