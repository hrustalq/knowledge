import {
  LINT_POLICIES,
  type AgentFinding,
  type DiffHunk,
  type LintPolicy,
  type LintPolicySettings,
  type LintViolation,
  type MergeRequestCheckCounts,
  type StyleRule,
  type StyleRuleSeverity,
} from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import { normalizeQuote } from '../review-anchor.js';

/**
 * The merge request style lint (#74, phase 2), Nest-free: what the trigger,
 * the linter run and the publisher must agree on, kept where a spec can pin it
 * without a database.
 */

/** The agent a merge request lint runs as. */
export const LINT_AGENT_KEY = 'linter';

/** Context kept around an anchored quote, so it re-finds itself once the page moves. */
const ANCHOR_CONTEXT = 32;

const rank = (p: LintPolicy) => LINT_POLICIES.indexOf(p);
const asPolicy = (v: string | null | undefined): LintPolicy | null =>
  LINT_POLICIES.includes(v as LintPolicy) ? (v as LintPolicy) : null;

/**
 * One scope's lint policy. A project inherits the workspace's row, the
 * workspace the ceiling; whatever is asked for is clamped to the ceiling and
 * never widened by it, and a disabled `linter` turns it off. `source` names
 * the step that decided it, so the settings page can say so.
 */
export function resolveLintPolicy(input: {
  workspaceId: string;
  projectId: string | null;
  ceiling: LintPolicy;
  workspacePolicy: string | null | undefined;
  projectPolicy: string | null | undefined;
  linterEnabled: boolean;
}): LintPolicySettings {
  const { ceiling } = input;
  const clamp = (p: LintPolicy) => (rank(p) <= rank(ceiling) ? p : ceiling);
  const workspace = asPolicy(input.workspacePolicy);
  const requested = input.projectId ? asPolicy(input.projectPolicy) : workspace;
  const inherited = input.projectId ? clamp(workspace ?? ceiling) : ceiling;
  const asked = requested === null ? inherited : clamp(requested);

  let source: LintPolicySettings['source'] =
    requested === null ? (input.projectId && workspace !== null ? 'inherited' : 'ceiling') : asked === requested ? 'scope' : 'ceiling';
  let effective = asked;
  if (!input.linterEnabled && effective !== 'off') {
    effective = 'off';
    source = 'agent-disabled';
  }
  return {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    requested,
    inherited,
    ceiling,
    effective,
    source,
    linterEnabled: input.linterEnabled,
  };
}

/**
 * What a lint reads of a change: the added lines, each run of consecutive ones
 * kept together, runs a blank line apart. A line that only lost something is
 * not the author's to restyle, and a passage the merge request did not touch
 * is somebody else's — so neither is linted.
 */
export function changedText(hunks: DiffHunk[]): string {
  const runs: string[] = [];
  for (const hunk of hunks) {
    let run: string[] = [];
    for (const line of hunk.lines) {
      if (line.kind === 'added') {
        run.push(line.text);
        continue;
      }
      if (line.kind === 'context' && run.length > 0) {
        runs.push(run.join('\n'));
        run = [];
      }
    }
    if (run.length > 0) runs.push(run.join('\n'));
  }
  return runs.filter((r) => r.trim()).join('\n\n');
}

/** A rule's severity in the vocabulary findings speak. */
export function findingSeverity(severity: StyleRuleSeverity): AgentFinding['severity'] {
  return severity === 'suggestion' ? 'info' : severity;
}

function ruleSeverity(severity: AgentFinding['severity']): StyleRuleSeverity {
  return severity === 'info' ? 'suggestion' : severity;
}

/**
 * Violations → `style` findings, anchored to the head they were read from.
 *
 * `readLintViolations` grounded each quote in the linted text; this grounds it
 * again in the whole page, because the linted text joins separate runs and a
 * quote straddling the join exists in neither the page nor the rendered view —
 * a thread anchored to it would point at nothing. Comparison is on collapsed
 * whitespace, the way `validateThreadAnchor` and the reader resolve anchors.
 */
export function styleFindings(
  violations: LintViolation[],
  rules: StyleRule[],
  page: { documentId: string; title: string; revisionId: string; markdown: string },
): AgentFinding[] {
  const text = normalizeQuote(page.markdown);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const out: AgentFinding[] = [];
  for (const v of violations) {
    const quote = normalizeQuote(v.quote);
    const at = text.indexOf(quote);
    if (!quote || at < 0) continue;
    const prefix = text.slice(Math.max(0, at - ANCHOR_CONTEXT), at).trim();
    const suffix = text.slice(at + quote.length, at + quote.length + ANCHOR_CONTEXT).trim();
    out.push({
      kind: 'style',
      severity: findingSeverity(v.severity),
      title: byId.get(v.ruleId)?.text ?? v.ruleId,
      detail: v.message,
      documentIds: [page.documentId],
      documentTitles: [page.title],
      ruleId: v.ruleId,
      anchor: {
        type: 'text',
        revisionId: page.revisionId,
        quote,
        ...(prefix ? { prefix } : {}),
        ...(suffix ? { suffix } : {}),
      },
      ...(v.suggestion ? { suggestion: v.suggestion } : {}),
    });
  }
  return out;
}

/** The identity of a violation across pushes: the rule it breaks and what it quotes. */
export function violationKey(ruleId: string | null, quote: string | null | undefined): string {
  return `${ruleId ?? ''}\u0000${normalizeQuote(quote ?? '')}`;
}

/** A lint thread an earlier check opened on the same merge request. */
export interface PriorLintThread {
  threadId: string;
  ruleId: string | null;
  quote: string | null;
  resolved: boolean;
}

/**
 * How a check's findings meet the threads earlier checks opened:
 *
 * - a violation that already has a thread keeps it — open or resolved, since a
 *   person who resolved it has answered it, and a second thread would ask again;
 * - a new violation gets a thread;
 * - an open thread whose violation is gone is resolved.
 *
 * "Already has a thread" is the same rule and quote — or, failing that, the
 * same rule and a quote one contains the other of: a model asked twice quotes
 * the same sentence a little wider or narrower, and that is one violation, not
 * a fixed one and a new one.
 *
 * Only lint threads are ever passed in, so a person's thread is never touched.
 */
export function planLintThreads(
  prior: PriorLintThread[],
  findings: AgentFinding[],
): { create: AgentFinding[]; keep: Array<{ threadId: string; finding: AgentFinding }>; resolve: string[] } {
  const byKey = new Map<string, PriorLintThread>();
  for (const thread of prior) {
    const key = violationKey(thread.ruleId, thread.quote);
    // Two threads for one violation (a race, or a rule edited back): the open one speaks.
    const seen = byKey.get(key);
    if (!seen || (seen.resolved && !thread.resolved)) byKey.set(key, thread);
  }
  const create: AgentFinding[] = [];
  const keep: Array<{ threadId: string; finding: AgentFinding }> = [];
  const keptIds = new Set<string>();
  const live = new Set<string>();
  const overlapping = (ruleId: string | null, quote: string) =>
    prior.find((p) => {
      if (keptIds.has(p.threadId) || p.ruleId !== ruleId || !p.quote) return false;
      const theirs = normalizeQuote(p.quote);
      return theirs.includes(quote) || quote.includes(theirs);
    });
  for (const finding of findings) {
    const quote = normalizeQuote(finding.anchor?.type === 'text' ? finding.anchor.quote : '');
    const key = violationKey(finding.ruleId ?? null, quote);
    if (live.has(key)) continue;
    live.add(key);
    const exact = byKey.get(key);
    const thread = exact && !keptIds.has(exact.threadId) ? exact : quote ? overlapping(finding.ruleId ?? null, quote) : undefined;
    if (thread) {
      keptIds.add(thread.threadId);
      keep.push({ threadId: thread.threadId, finding });
    } else create.push(finding);
  }
  const resolve = prior.filter((p) => !p.resolved && !keptIds.has(p.threadId)).map((p) => p.threadId);
  return { create, keep, resolve };
}

export function countsOf(findings: AgentFinding[]): MergeRequestCheckCounts {
  const counts: MergeRequestCheckCounts = { error: 0, warning: 0, suggestion: 0 };
  for (const f of findings) counts[ruleSeverity(f.severity)] += 1;
  return counts;
}

/**
 * Text from a page or a model, made safe for a discussion: no raw HTML, and no
 * `@handle` that would notify somebody because a page happened to contain one
 * (the drift report's rule).
 */
function defuse(text: string): string {
  return text.replace(/</g, '&lt;').replace(/@(?=\w)/g, '@​');
}

/**
 * The opening comment of a lint thread: the rule, the quoted passage, what the
 * linter said and its suggestion. The rule is the admins' text; the rest came
 * from the page or the model and is defused.
 */
export function lintThreadBody(finding: AgentFinding): string {
  const quote = finding.anchor?.type === 'text' ? finding.anchor.quote : '';
  const lines = [`**${t(`agent.lint.severity.${ruleSeverity(finding.severity)}`)}** · ${defuse(finding.title)}`];
  if (quote) lines.push('', `> ${defuse(quote)}`);
  if (finding.detail && finding.detail !== finding.title) lines.push('', defuse(finding.detail));
  if (finding.suggestion) lines.push('', `${t('agent.lint.suggestion')} ${defuse(finding.suggestion)}`);
  return lines.join('\n');
}
