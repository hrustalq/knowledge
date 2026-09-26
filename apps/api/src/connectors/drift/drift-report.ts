import type { AgentFinding, AgentRunPullRequest } from '@knowledge/contracts';
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

export function renderDriftComment(input: {
  webBaseUrl: string;
  connectorName: string;
  pullRequest: AgentRunPullRequest;
  entries: DriftReportEntry[];
}): string {
  const base = input.webBaseUrl.replace(/\/+$/, '');
  const sha = input.pullRequest.headSha.slice(0, 7);
  const lines = [`### ${t('agent.drift.comment.heading')}`, ''];

  if (input.entries.length === 0) {
    lines.push(t('agent.drift.comment.clean', { sha, connector: input.connectorName }));
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
  lines.push('', `<sub>${t('agent.drift.comment.footer')}</sub>`);
  return lines.join('\n');
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
