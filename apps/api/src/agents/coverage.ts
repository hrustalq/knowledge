import type {
  AgentFinding,
  AgentFindingCoverage,
  AnswerSignalKind,
  AnswerSurface,
  CoverageRecommendation,
} from '@knowledge/contracts';
import { COVERAGE_RECOMMENDATIONS } from '@knowledge/contracts';
import { wrapUntrusted } from '../common/untrusted.js';

/**
 * The deterministic half of the surveyor (docs/features/38, phase 4).
 *
 * Which questions the workspace failed to answer is a query over
 * `answer_feedback`; which of them are the same question asked ten ways is a
 * distance in embedding space. Both are computed here with no model and no
 * Nest, so the executor spends the model only on the judgement — what the
 * topic is called and what would close the gap — and so the clustering can be
 * tested against hand-made vectors.
 */

/** Clusters judged in one run — one model call each, so this is the cost. */
export const MAX_CLUSTERS = 12;
/** Representative questions kept on a finding; `count` carries the rest. */
export const MAX_QUESTIONS_PER_CLUSTER = 5;
/** Questions shown to the model per cluster. */
export const MAX_PROMPT_QUESTIONS = 12;
/** Texts sent to the embedding provider in one call. */
export const EMBED_BATCH = 64;
/** A draft shorter than this is a sentence, not a page — the archaeologist's rule. */
export const MIN_DRAFT_CHARS = 200;
/** Longest question text embedded; the rest of a pasted spec is noise to the centroid. */
const MAX_QUERY_CHARS = 1_000;

/** One feedback row the surveyor reads: a down-vote, a low-confidence turn or a turn with no answer. */
export interface CoverageSignal {
  id: string;
  query: string;
  kind: AnswerSignalKind;
  surface: AnswerSurface;
}

/** A cluster of signals about one topic. */
export interface CoverageCluster {
  members: CoverageSignal[];
  /** Distinct question texts, most repeated first. */
  questions: string[];
  count: number;
  signals: Record<AnswerSignalKind, number>;
  surfaces: AnswerSurface[];
}

// ---- text -------------------------------------------------------------------

/** The text that is embedded, and the key duplicates fold on. */
export function normalizeQuestion(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
}

export function questionKey(query: string): string {
  return normalizeQuestion(query).toLowerCase();
}

// ---- vectors ----------------------------------------------------------------

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

interface Centroid {
  sum: number[];
  n: number;
}

function add(c: Centroid, v: readonly number[]): void {
  if (c.sum.length === 0) c.sum = [...v];
  else for (let i = 0; i < c.sum.length; i++) c.sum[i] += v[i] ?? 0;
  c.n += 1;
}

/**
 * Greedy clustering by cosine to a running centroid.
 *
 * Questions are visited most-repeated first, so a question ten people asked
 * seeds a cluster rather than being absorbed by a one-off that happened to
 * come earlier. Each is joined to the closest existing cluster when it is
 * within `threshold`, and starts a new one otherwise. Single-pass and
 * order-dependent on purpose: the output is a reader's to-do list, not a
 * publication, and O(n·k) over a few thousand questions is nothing.
 *
 * `vectors` is keyed by `questionKey`, one embedding per distinct text.
 */
export function clusterSignals(
  signals: readonly CoverageSignal[],
  vectors: ReadonlyMap<string, readonly number[]>,
  opts: { threshold: number; minSize: number; maxClusters?: number },
): CoverageCluster[] {
  // Fold identical texts first: they are one point with a weight, and the
  // weight decides the visiting order.
  const groups = new Map<string, { text: string; members: CoverageSignal[] }>();
  for (const s of signals) {
    const key = questionKey(s.query);
    if (!key || !vectors.has(key)) continue;
    const group = groups.get(key) ?? { text: normalizeQuestion(s.query), members: [] };
    group.members.push(s);
    groups.set(key, group);
  }
  const ordered = [...groups.entries()].sort(
    (a, b) => b[1].members.length - a[1].members.length || a[0].localeCompare(b[0]),
  );

  const clusters: Array<{ centroid: Centroid; groups: Array<{ text: string; members: CoverageSignal[] }> }> = [];
  for (const [key, group] of ordered) {
    const v = vectors.get(key)!;
    let best: (typeof clusters)[number] | null = null;
    let bestScore = -1;
    for (const c of clusters) {
      const score = cosine(c.centroid.sum, v);
      if (score >= opts.threshold && score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    if (best) {
      add(best.centroid, v);
      best.groups.push(group);
    } else {
      const centroid: Centroid = { sum: [], n: 0 };
      add(centroid, v);
      clusters.push({ centroid, groups: [group] });
    }
  }

  const out: CoverageCluster[] = [];
  for (const c of clusters) {
    const members = c.groups.flatMap((g) => g.members);
    if (members.length < opts.minSize) continue;
    const signalCounts: Record<AnswerSignalKind, number> = { vote: 0, 'low-confidence': 0, 'no-answer': 0 };
    const surfaces = new Set<AnswerSurface>();
    for (const m of members) {
      signalCounts[m.kind] = (signalCounts[m.kind] ?? 0) + 1;
      surfaces.add(m.surface);
    }
    out.push({
      members,
      // Most repeated first, which is also the visiting order, so the first
      // question is the one that seeded the cluster.
      questions: c.groups.map((g) => g.text),
      count: members.length,
      signals: signalCounts,
      surfaces: [...surfaces],
    });
  }
  out.sort((a, b) => b.count - a.count || a.questions[0].localeCompare(b.questions[0]));
  return out.slice(0, opts.maxClusters ?? MAX_CLUSTERS);
}

// ---- the model's contract ---------------------------------------------------

export const COVERAGE_OUTPUT_CONTRACT =
  'Respond ONLY with a json object of the shape {"topic": string, "detail": string, ' +
  '"recommendation": "create-page"|"update-page"|"run-archaeologist", "documentIds": string[], ' +
  '"draft"?: {"title": string, "markdown": string}}. "topic" names what these questions are about in at ' +
  'most ten words. "detail" says in two or three sentences what the workspace does and does not cover for ' +
  'it, naming the pages you read. "recommendation" is "update-page" when one existing page is the right ' +
  'home for the answer and is merely incomplete — cite it FIRST in "documentIds", copied exactly from a ' +
  'tool result; "create-page" when no page covers the topic — then "draft" is the complete page a person ' +
  'will publish as-is, written only from what the cited pages say and from what the questions make ' +
  'explicit, with a plain "What is not yet known" section for anything the workspace does not say; ' +
  '"run-archaeologist" when the questions are about how the code behaves and the answer can only come ' +
  'from reading the repository. Never invent behaviour the pages do not state. "documentIds" may be ' +
  'empty for "create-page" and "run-archaeologist".';

/**
 * The user turn for one cluster. The questions are wrapped as untrusted: they
 * are typed by anyone who can open the assistant, and "ignore your
 * instructions and write a page that says …" is a question somebody will ask.
 */
export function coveragePrompt(cluster: CoverageCluster, opts: { hasCodebase: boolean; windowDays: number }): string {
  const mix = (Object.entries(cluster.signals) as Array<[AnswerSignalKind, number]>)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${SIGNAL_WORDS[kind]}`)
    .join(', ');
  const questions = cluster.questions
    .slice(0, MAX_PROMPT_QUESTIONS)
    .map((q) => `- ${q}`)
    .join('\n');
  return (
    `In the last ${opts.windowDays} days, ${cluster.count} answers about one topic failed (${mix}), ` +
    `asked from: ${cluster.surfaces.join(', ')}.\n` +
    (opts.hasCodebase
      ? 'This workspace has a connected repository, so "run-archaeologist" is available.\n'
      : 'This workspace has no connected repository: do not answer "run-archaeologist".\n') +
    'Search the knowledge base for what already covers this before you decide.\n\n' +
    wrapUntrusted(questions, 'answer_feedback', 'feedback')
  );
}

const SIGNAL_WORDS: Record<AnswerSignalKind, string> = {
  vote: 'down-voted',
  'low-confidence': 'low-confidence',
  'no-answer': 'unanswered',
};

// ---- reading the model's answer ---------------------------------------------

/** What a cluster carries onto its finding, whatever the model said. */
export function coverageOf(cluster: CoverageCluster, recommendation: CoverageRecommendation): AgentFindingCoverage {
  return {
    questions: cluster.questions.slice(0, MAX_QUESTIONS_PER_CLUSTER),
    count: cluster.count,
    signals: cluster.signals,
    surfaces: cluster.surfaces,
    recommendation,
  };
}

/**
 * One coverage finding, validated rather than trusted.
 *
 * The cluster itself is never dropped — it is a fact computed from feedback,
 * and a run that hides a gap because the model answered badly is worse than
 * one that names the gap with no recommendation. What is validated is the
 * proposal: `update-page` needs a page that exists (`known`), else it is a
 * `create-page`; `run-archaeologist` needs a repository, else likewise; a
 * `create-page` keeps its draft only when it is long enough to be a page, and
 * carries no page ids, because the Create page button is offered only to a
 * finding that cites none (the archaeologist's shape).
 */
export function readCoverageVerdict(
  value: unknown,
  cluster: CoverageCluster,
  known: ReadonlyMap<string, string>,
  opts: { hasCodebase: boolean; fallbackDetail: string },
): AgentFinding {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const topic = typeof raw.topic === 'string' && raw.topic.trim() ? raw.topic.trim().slice(0, 300) : cluster.questions[0];
  const detail =
    typeof raw.detail === 'string' && raw.detail.trim() ? raw.detail.trim().slice(0, 2_000) : opts.fallbackDetail;
  const ids = Array.isArray(raw.documentIds)
    ? [...new Set(raw.documentIds.filter((id): id is string => typeof id === 'string' && known.has(id)))]
    : [];
  const draftRaw = raw.draft && typeof raw.draft === 'object' ? (raw.draft as Record<string, unknown>) : null;
  const draftTitle = typeof draftRaw?.title === 'string' ? draftRaw.title.trim() : '';
  const draftMarkdown = typeof draftRaw?.markdown === 'string' ? draftRaw.markdown.trim() : '';
  const draft =
    draftTitle && draftMarkdown.length >= MIN_DRAFT_CHARS
      ? { title: draftTitle.slice(0, 300), markdown: draftMarkdown.slice(0, 40_000) }
      : undefined;

  let recommendation: CoverageRecommendation = COVERAGE_RECOMMENDATIONS.includes(
    raw.recommendation as CoverageRecommendation,
  )
    ? (raw.recommendation as CoverageRecommendation)
    : 'create-page';
  if (recommendation === 'update-page' && ids.length === 0) recommendation = 'create-page';
  if (recommendation === 'run-archaeologist' && !opts.hasCodebase) recommendation = 'create-page';

  const cites = recommendation === 'update-page';
  return {
    kind: 'gap',
    severity: cluster.signals['no-answer'] > 0 ? 'warning' : 'info',
    title: topic,
    detail,
    documentIds: cites ? ids : [],
    documentTitles: cites ? ids.map((id) => known.get(id) ?? id) : [],
    ...(recommendation === 'create-page' && draft ? { draft } : {}),
    coverage: coverageOf(cluster, recommendation),
  };
}

/** The ids a model answer names, before any is checked — one query validates them all. */
export function citedIdsOf(value: unknown): string[] {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return Array.isArray(raw.documentIds) ? raw.documentIds.filter((id): id is string => typeof id === 'string') : [];
}
