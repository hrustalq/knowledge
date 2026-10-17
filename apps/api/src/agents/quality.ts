import { createHash } from 'node:crypto';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  QUALITY_DIMENSIONS,
  extractPageLinks,
  type LintViolation,
  type PageRefResolver,
  type QualityDimension,
  type QualityDimensionScores,
  type QualityDuplicate,
  type QualityIssue,
  type StyleRule,
  type StyleRuleSeverity,
} from '@knowledge/contracts';
import { cosine } from './coverage.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { t } from '../i18n/t.js';
import { enabledRules, readLintViolations, renderStyleguide } from './lint.js';

/**
 * The quality auditor's rubric (#74, phase 4), Nest-free so every number it
 * produces is reproducible in a spec.
 *
 * Half of a score is fact and half is judgement, and the split is the
 * curator's: links, ownership and duplication are read from the database and
 * the vector store, so they are exactly right and cost nothing; clarity,
 * completeness and style are one model call, made only when the page's
 * revision (or the rubric, or the styleguide) changed since it was last scored.
 */

/**
 * Bumped whenever a weight, a penalty or the prompt changes, so every page is
 * re-scored on the next run instead of mixing two rubrics on one dashboard.
 */
export const RUBRIC_VERSION = 1;

/** Sum to 1. A dimension that was not measured drops out and the rest are renormalised. */
export const QUALITY_WEIGHTS: Record<QualityDimension, number> = {
  clarity: 0.25,
  completeness: 0.25,
  links: 0.15,
  ownership: 0.1,
  duplication: 0.1,
  style: 0.15,
};

/** How much one style violation costs, by the rule's severity. */
const STYLE_PENALTY: Record<StyleRuleSeverity, number> = { error: 25, warning: 10, suggestion: 3 };
/** What one near-duplicate peer costs: one is a warning, two is a page that should not exist. */
const DUPLICATE_PENALTY = 60;
/** Issues kept per page, per source, so one bad page cannot bury the rest of its row. */
export const MAX_ISSUES_PER_SOURCE = 5;
/** How much of a page the model is shown — the reviewer's cap. */
export const MAX_AUDIT_CHARS = 40_000;
const MESSAGE_MAX = 500;
const MIN_QUOTE = 3;

/** The dimensions the model half owns — reused as a block when the revision is unchanged. */
export const MODEL_DIMENSIONS = ['clarity', 'completeness', 'style'] as const satisfies readonly QualityDimension[];

export function emptyDimensions(): QualityDimensionScores {
  return Object.fromEntries(QUALITY_DIMENSIONS.map((d) => [d, null])) as QualityDimensionScores;
}

/** Weighted mean of the measured dimensions, 0–100. A page with nothing measured scores 0. */
export function overallScore(dimensions: QualityDimensionScores): number {
  let weight = 0;
  let total = 0;
  for (const d of QUALITY_DIMENSIONS) {
    const value = dimensions[d];
    if (value === null || value === undefined) continue;
    weight += QUALITY_WEIGHTS[d];
    total += QUALITY_WEIGHTS[d] * clampScore(value);
  }
  return weight === 0 ? 0 : Math.round(total / weight);
}

/** A model's number, or anything else, as an integer 0–100; null when it is not a number at all. */
export function readScore(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? clampScore(n) : null;
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Fingerprint of the rules the model half read: a changed styleguide makes an
 * old style score a judgement against rules that no longer exist. Null when no
 * rule is enabled, which is also what an unstyled workspace stores.
 */
export function styleguideHash(rules: StyleRule[]): string | null {
  const live = enabledRules(rules).map((r) => [r.id, r.severity, r.text, r.example?.bad ?? '', r.example?.good ?? '']);
  if (live.length === 0) return null;
  return createHash('sha256').update(JSON.stringify(live)).digest('hex').slice(0, 16);
}

// --------------------------------------------------------------------- links

/** What a link may resolve against: ids of live pages in the workspace, and titles through the web's resolver. */
export interface LinkIndex {
  documentIds: ReadonlySet<string>;
  resolve: PageRefResolver;
}

/**
 * Broken internal links. An id link is broken when no live page of this
 * workspace has that id (a deleted page, or one in another workspace: the
 * index only holds this one's). A title reference is broken when the web's
 * resolver would leave it as literal brackets — no page by that title, or more
 * than one and none in this page's project. 100 with no links at all.
 */
export function linkCheck(markdown: string, index: LinkIndex): { score: number; issues: QualityIssue[]; broken: number } {
  const links = extractPageLinks(markdown);
  if (links.length === 0) return { score: 100, issues: [], broken: 0 };
  const issues: QualityIssue[] = [];
  const seen = new Set<string>();
  let broken = 0;
  for (const link of links) {
    const ok = link.kind === 'id' ? index.documentIds.has(link.documentId) : index.resolve(link.title) !== null;
    if (ok) continue;
    broken += 1;
    if (seen.has(link.href) || issues.length >= MAX_ISSUES_PER_SOURCE) continue;
    seen.add(link.href);
    issues.push({
      dimension: 'links',
      severity: 'warning',
      message:
        link.kind === 'id'
          ? t('agent.quality.brokenIdLink', { text: link.text })
          : t('agent.quality.brokenTitleLink', { text: link.text, title: link.title }),
      link: link.href,
    });
  }
  return { score: Math.round((100 * (links.length - broken)) / links.length), issues, broken };
}

// ----------------------------------------------------------------- ownership

/** Feature 39's owner: present or not. A fact, so it is always measured. */
export function ownershipCheck(ownerId: string | null): { score: number; issues: QualityIssue[] } {
  if (ownerId) return { score: 100, issues: [] };
  return { score: 0, issues: [{ dimension: 'ownership', severity: 'info', message: t('agent.quality.noOwner') }] };
}

// --------------------------------------------------------------- duplication

/**
 * Near-duplicate peers of each audited page, by mean head-embedding cosine.
 * `means` holds every page the audited ones are compared with (the audited
 * pages among them); a page compared with itself is skipped. Each pair is also
 * returned once, in `pairs`, so a finding cites it a single time however many
 * of its two pages were audited.
 */
export function duplicatePeers(
  means: ReadonlyMap<string, number[]>,
  audited: readonly string[],
  threshold: number,
): { peers: Map<string, QualityDuplicate[]>; pairs: Array<{ a: string; b: string; similarity: number }> } {
  const peers = new Map<string, QualityDuplicate[]>();
  const pairs = new Map<string, { a: string; b: string; similarity: number }>();
  for (const id of audited) {
    const mine = means.get(id);
    if (!mine) continue;
    const found: QualityDuplicate[] = [];
    for (const [other, theirs] of means) {
      if (other === id || theirs.length !== mine.length) continue;
      const similarity = Number(cosine(mine, theirs).toFixed(4));
      if (similarity < threshold) continue;
      found.push({ documentId: other, similarity });
      const [a, b] = id < other ? [id, other] : [other, id];
      pairs.set(`${a}|${b}`, { a, b, similarity });
    }
    found.sort((x, y) => y.similarity - x.similarity);
    peers.set(id, found.slice(0, MAX_ISSUES_PER_SOURCE));
  }
  return { peers, pairs: [...pairs.values()].sort((x, y) => y.similarity - x.similarity) };
}

/** Null when the page has no embedding to compare: not measured is not "unique". */
export function duplicationCheck(
  hasEmbedding: boolean,
  peers: QualityDuplicate[],
  titleOf: (id: string) => string,
): { score: number | null; issues: QualityIssue[] } {
  if (!hasEmbedding) return { score: null, issues: [] };
  return {
    score: Math.max(0, 100 - DUPLICATE_PENALTY * peers.length),
    issues: peers.map((p) => ({
      dimension: 'duplication' as const,
      severity: 'warning' as const,
      message: t('agent.quality.duplicate', { title: titleOf(p.documentId), similarity: Math.round(p.similarity * 100) }),
      documentId: p.documentId,
    })),
  };
}

// --------------------------------------------------------------- model half

/** The rubric's two messages: instructions + styleguide (trusted), then the page (untrusted). */
export function auditMessages(instructions: string, rules: StyleRule[], title: string, markdown: string): ChatCompletionMessageParam[] {
  const styled = enabledRules(rules).length > 0;
  return [
    {
      role: 'system',
      content:
        instructions +
        (styled
          ? `\n\n${STYLE_CLAUSE}${renderStyleguide(rules)}`
          : '\n\nThere is no styleguide: return "violations" as an empty list.'),
    },
    {
      role: 'user',
      content: wrapUntrusted(`Title: ${title || '(untitled)'}\n\n${markdown.slice(0, MAX_AUDIT_CHARS)}`, 'audit', 'page'),
    },
  ];
}

const STYLE_CLAUSE =
  'Also list in "violations" each passage that breaks one of the rules below: "ruleId" is the id in brackets ' +
  'before the rule, "quote" the shortest breaking passage copied character for character, "message" one ' +
  'sentence on how it breaks the rule. Never flag anything for a rule that is not listed.';

export interface ModelHalf {
  clarity: number | null;
  completeness: number | null;
  /** Null when no styleguide rule is enabled. */
  style: number | null;
  issues: QualityIssue[];
  violations: LintViolation[];
}

/**
 * What the harness accepts of the model's answer. Scores are clamped to 0–100;
 * an issue's quote is kept only if the page holds it verbatim (the issue
 * itself survives without it — "the intro never says who this is for" quotes
 * nothing). Style violations go through the linter's own gate, so an unknown
 * rule or an ungrounded quote is dropped and the severity is the rule's.
 */
export function readModelHalf(parsed: Record<string, unknown> | null, rules: StyleRule[], markdown: string): ModelHalf {
  const text = markdown.slice(0, MAX_AUDIT_CHARS);
  const issues: QualityIssue[] = [];
  const raw = Array.isArray(parsed?.issues) ? (parsed.issues as unknown[]) : [];
  for (const entry of raw) {
    if (issues.length >= MAX_ISSUES_PER_SOURCE) break;
    const v = entry as Record<string, unknown> | null;
    const message = typeof v?.message === 'string' ? v.message.trim() : '';
    if (!message) continue;
    const dimension: QualityDimension = v?.dimension === 'completeness' ? 'completeness' : 'clarity';
    const severity = v?.severity === 'error' || v?.severity === 'warning' ? v.severity : 'info';
    const quote = typeof v?.quote === 'string' ? v.quote.trim() : '';
    issues.push({
      dimension,
      severity,
      message: clip(message, MESSAGE_MAX),
      ...(quote.length >= MIN_QUOTE && text.includes(quote) ? { quote: clip(quote, MESSAGE_MAX) } : {}),
    });
  }

  const styled = enabledRules(rules).length > 0;
  const { violations } = styled ? readLintViolations(parsed, rules, text, MAX_ISSUES_PER_SOURCE * 3) : { violations: [] };
  for (const v of violations.slice(0, MAX_ISSUES_PER_SOURCE)) {
    issues.push({
      dimension: 'style',
      severity: v.severity === 'error' ? 'error' : v.severity === 'warning' ? 'warning' : 'info',
      message: v.message,
      quote: v.quote,
      ruleId: v.ruleId,
    });
  }

  return {
    clarity: readScore(parsed?.clarity),
    completeness: readScore(parsed?.completeness),
    style: styled ? styleScore(violations) : null,
    issues,
    violations,
  };
}

/** 100 less each violation's penalty, floored at 0. */
export function styleScore(violations: LintViolation[]): number {
  return Math.max(0, 100 - violations.reduce((sum, v) => sum + STYLE_PENALTY[v.severity], 0));
}

// -------------------------------------------------------------------- reuse

/** The parts of a stored score the next audit may need. */
export interface PriorScore {
  revisionId: string;
  rubricVersion: number;
  styleguideHash: string | null;
  createdAt: Date;
  dimensions: unknown;
  issues: unknown;
}

/**
 * The model half of a stored score, if it still describes this page: same
 * revision, same rubric, same styleguide. Then the audit recomputes only the
 * facts, and a nightly run over an unchanged corpus makes no model call.
 * Null when the stored row was scored without a model (both judgements null),
 * so a workspace that turns its model on gets the judgement next run.
 */
export function reusableModelHalf(prior: PriorScore | null, revisionId: string, hash: string | null): ModelHalf | null {
  if (!prior || prior.revisionId !== revisionId || prior.rubricVersion !== RUBRIC_VERSION || prior.styleguideHash !== hash) {
    return null;
  }
  const dims = (prior.dimensions ?? {}) as Partial<QualityDimensionScores>;
  const clarity = readScore(dims.clarity);
  const completeness = readScore(dims.completeness);
  if (clarity === null && completeness === null) return null;
  const issues = Array.isArray(prior.issues) ? (prior.issues as QualityIssue[]) : [];
  return {
    clarity,
    completeness,
    style: readScore(dims.style),
    issues: issues.filter((i) => (MODEL_DIMENSIONS as readonly string[]).includes(i?.dimension)),
    violations: [],
  };
}

/**
 * Whether a page is due: never scored, scored at another revision, under an
 * older rubric or another styleguide, or longer ago than the audit interval —
 * or scored without a judgement (no model then, or its call failed) while a
 * model is available now, so turning a model on does not wait out the interval.
 */
export function isDue(
  prior: PriorScore | null,
  headRevisionId: string,
  hash: string | null,
  auditDays: number,
  now: Date,
  modelOn: boolean,
): boolean {
  if (!prior) return true;
  if (prior.revisionId !== headRevisionId || prior.rubricVersion < RUBRIC_VERSION || prior.styleguideHash !== hash) return true;
  if (modelOn && !reusableModelHalf(prior, headRevisionId, hash)) return true;
  return now.getTime() - prior.createdAt.getTime() >= auditDays * 86_400_000;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
