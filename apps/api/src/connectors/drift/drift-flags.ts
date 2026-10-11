import type { AgentFinding, AgentRunPullRequest } from '@knowledge/contracts';

/**
 * Which pages a drift check flags, and what the flag says (docs/features/39,
 * issue #66 phase 4). Pure, like `drift-report.ts` beside it, so the rule can
 * be tested without a run.
 */

/**
 * One finding per page: the first that is more than `info` and cites a page.
 * Two findings about one page are one flag, and an `info` finding is a remark
 * rather than a claim the page is wrong — the same bar the pull request
 * comment does not apply, because a comment lists and a flag asserts.
 */
export function pagesToFlag(findings: AgentFinding[]): Map<string, AgentFinding> {
  const pages = new Map<string, AgentFinding>();
  for (const finding of findings) {
    const id = finding.documentIds[0];
    if (!id || finding.severity === 'info' || pages.has(id)) continue;
    pages.set(id, finding);
  }
  return pages;
}

/**
 * The note shown on the page beside the flag: which pull request, and what
 * the check said, on one line. Flattened like the comment's detail but not
 * HTML-escaped — the page renders a note as text, and `&lt;` would show as
 * written. `VerificationService.flag` caps the length.
 */
export function flagNote(finding: AgentFinding, pr: AgentRunPullRequest): string {
  const text = (finding.detail || finding.title).replace(/\s+/g, ' ').trim();
  return `${pr.title} (#${pr.number}): ${text}`;
}
