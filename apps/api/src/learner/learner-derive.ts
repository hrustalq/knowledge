import { AGENT_LEARNING_MAX_CHARS, MCP_LEARNING_TARGET, type AgentLearningEvidenceRef, type AgentLearningSideCounts } from '@knowledge/contracts';
import { wrapUntrusted } from '../common/untrusted.js';
import { cosine } from '../agents/coverage.js';

/**
 * The deterministic half of the learner (#305): which dismissed findings are
 * one recurring mistake, whether that recurrence counts, where a new piece of
 * evidence belongs, and whether an active learning helped. No Nest and no
 * database, so every threshold here is tested against hand-made vectors.
 *
 * The model (`coach`) is spent on exactly one thing: wording the correction
 * for a cluster that already qualified and belongs to no existing learning.
 */

/**
 * One failure as the learner's queries return it — already past the ACL
 * filter: a dismissed finding of a built-in agent, or (agent `mcp`) an MCP
 * agent's capture a person turned down or answer a person downvoted.
 */
export type DismissedFinding = AgentLearningEvidenceRef & {
  agentKey: string;
  /** The project of the first page it cites: what a derived learning is scoped to. */
  projectId: string;
  kind: string;
  title: string;
  detail: string;
  dismissedBy: string;
  dismissedAt: Date;
  /** Its run's locale, which the coach answers in. */
  locale: string;
};

/** An existing learning a cluster may fold into. */
export interface FoldCandidate {
  id: string;
  status: string;
  agentKey: string | null;
  projectId: string | null;
  evidence: AgentLearningEvidenceRef[];
}

export interface LearnerThresholds {
  threshold: number;
  minDismissals: number;
  minPeople: number;
}

/** Longest finding text embedded and shown to the coach. A title and the start of its detail. */
const MAX_FINDING_CHARS = 600;
/** Findings of one cluster shown to the coach. The rest add nothing a rule needs. */
export const MAX_COACH_FINDINGS = 12;

export const refKey = (ref: AgentLearningEvidenceRef): string =>
  'runId' in ref ? `${ref.runId}#${ref.findingIndex}` : 'captureId' in ref ? `capture:${ref.captureId}` : `feedback:${ref.feedbackId}`;

/** Just the ref of a failure — what a learning's `evidence` stores. */
export const refOf = (f: AgentLearningEvidenceRef): AgentLearningEvidenceRef =>
  'runId' in f ? { runId: f.runId, findingIndex: f.findingIndex } : 'captureId' in f ? { captureId: f.captureId } : { feedbackId: f.feedbackId };

/** The text a finding is embedded as — the same for the cluster and the calibration. */
export function findingText(f: Pick<DismissedFinding, 'kind' | 'title' | 'detail'>): string {
  return `${f.kind}: ${f.title}\n${f.detail}`.replace(/[ \t]+/g, ' ').trim().slice(0, MAX_FINDING_CHARS);
}

/** The group a finding is clustered in: one agent in one project. */
export const targetKey = (agentKey: string | null, projectId: string | null): string =>
  `${agentKey ?? ''}\u0000${projectId ?? ''}`;

/**
 * Greedy clustering by raw cosine to a running centroid — the surveyor's
 * method (`clusterSignals`), over findings instead of questions. Visited in
 * dismissal order, oldest first, so a cluster's seed is stable from one pass
 * to the next and a later dismissal joins it rather than reshuffling it.
 * `vectors` is keyed by `refKey`; a finding without one is skipped.
 */
export function clusterFindings(
  findings: readonly DismissedFinding[],
  vectors: ReadonlyMap<string, readonly number[]>,
  threshold: number,
): DismissedFinding[][] {
  const ordered = [...findings].sort(
    (a, b) => a.dismissedAt.getTime() - b.dismissedAt.getTime() || refKey(a).localeCompare(refKey(b)),
  );
  const clusters: Array<{ sum: number[]; members: DismissedFinding[] }> = [];
  for (const f of ordered) {
    const v = vectors.get(refKey(f));
    if (!v) continue;
    let best: (typeof clusters)[number] | null = null;
    let bestScore = -1;
    for (const c of clusters) {
      const score = cosine(c.sum, v);
      if (score >= threshold && score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    if (best) {
      for (let i = 0; i < best.sum.length; i++) best.sum[i] += v[i] ?? 0;
      best.members.push(f);
    } else {
      clusters.push({ sum: [...v], members: [f] });
    }
  }
  return clusters.map((c) => c.members);
}

/**
 * Whether a cluster is a recurring failure rather than one person's taste:
 * enough findings, dismissed by enough different people. Three from one
 * person is one opinion repeated, and does not qualify.
 */
export function qualifies(cluster: readonly DismissedFinding[], t: Pick<LearnerThresholds, 'minDismissals' | 'minPeople'>): boolean {
  return cluster.length >= t.minDismissals && new Set(cluster.map((f) => f.dismissedBy)).size >= t.minPeople;
}

export type FoldDecision =
  /** Add these refs to an existing learning's evidence. Empty when it already has them all. */
  | { kind: 'fold'; learningId: string; added: AgentLearningEvidenceRef[] }
  /** The cluster overlaps a learning an admin archived: they said no; write nothing. */
  | { kind: 'rejected'; learningId: string }
  /** No learning shares a finding with it: a candidate for a new one. */
  | { kind: 'new' };

/**
 * Where a cluster belongs, by shared evidence: a cluster that holds a finding
 * some learning for the same agent and project already rests on is that
 * learning's — a fourth similar dismissal folds into the row the first three
 * made, never into a second row. The learning sharing the most findings wins.
 */
export function foldByEvidence(cluster: readonly DismissedFinding[], candidates: readonly FoldCandidate[]): FoldDecision {
  if (cluster.length === 0) return { kind: 'new' };
  const target = targetKey(cluster[0].agentKey, cluster[0].projectId);
  const keys = new Set(cluster.map(refKey));
  let best: { c: FoldCandidate; shared: number } | null = null;
  for (const c of candidates) {
    if (targetKey(c.agentKey, c.projectId) !== target) continue;
    const shared = c.evidence.filter((r) => keys.has(refKey(r))).length;
    if (shared > 0 && (!best || shared > best.shared)) best = { c, shared };
  }
  if (!best) return { kind: 'new' };
  if (best.c.status === 'archived') return { kind: 'rejected', learningId: best.c.id };
  const have = new Set(best.c.evidence.map(refKey));
  const added = cluster.filter((f) => !have.has(refKey(f))).map(refOf);
  return { kind: 'fold', learningId: best.c.id, added };
}

/**
 * The existing learning a freshly drafted one near-duplicates (raw cosine of
 * the two texts at or above `threshold`), so the draft folds into it instead
 * of becoming a second row saying the same thing. Best match wins.
 */
export function nearDuplicate(
  draft: readonly number[],
  candidates: ReadonlyArray<{ id: string; vector: readonly number[] }>,
  threshold: number,
): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const score = cosine(draft, c.vector);
    if (score >= threshold && score > bestScore) {
      best = c.id;
      bestScore = score;
    }
  }
  return best;
}

/** The coach's user turn: the cluster's findings, wrapped untrusted — they were written from page content. */
export function coachInput(agentKey: string, cluster: readonly DismissedFinding[]): string {
  const lines = cluster
    .slice(0, MAX_COACH_FINDINGS)
    .map((f, i) => `${i + 1}. ${findingText(f).replace(/\n/g, ' — ')}`)
    .join('\n');
  const who = agentKey === MCP_LEARNING_TARGET ? 'external agents connected over MCP (Claude Code, Cursor and others)' : agentKey;
  return (
    `Agent: ${who}\n` +
    `${cluster.length} findings of this agent, dismissed by ${new Set(cluster.map((f) => f.dismissedBy)).size} different people:\n` +
    wrapUntrusted(lines, 'coach', 'findings')
  );
}

/** The most common locale among the cluster's runs: the language the people who dismissed them read. */
export function clusterLocale(cluster: readonly DismissedFinding[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const f of cluster) counts.set(f.locale, (counts.get(f.locale) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? fallback;
}

/**
 * The coach's answer as a learning's text, or null. Anything that is not one
 * non-empty string within `AGENT_LEARNING_MAX_CHARS` is no answer: the coach
 * declining (`null`) is a good outcome, and nothing is written for it.
 */
export function readCoachLearning(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    return null;
  }
  const text = (parsed as { learning?: unknown } | null)?.learning;
  if (typeof text !== 'string') return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean && clean.length <= AGENT_LEARNING_MAX_CHARS ? clean : null;
}

/** A side's dismissal rate. A side with no findings dismissed nothing. */
const rate = (s: AgentLearningSideCounts): number => (s.findings === 0 ? 0 : s.dismissed / s.findings);

/**
 * The lifecycle verdict on an active learning (#305): null while either side
 * has fewer than `minRuns` runs (too few to say anything), true when the
 * dismissal rate did not drop after it was activated — which raises the
 * proposed-archive flag — and false when it helped.
 */
export function noDrop(check: { before: AgentLearningSideCounts; after: AgentLearningSideCounts }, minRuns: number): boolean | null {
  if (check.before.runs < minRuns || check.after.runs < minRuns) return null;
  return rate(check.after) >= rate(check.before);
}
