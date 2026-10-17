// ---------------------------------------------------------------------------
// Docs quality (#74, phase 4). The auditor agent scores every page on six
// dimensions and stores each audit as one `document_quality_scores` row; the
// history is the rows. The weights and the rubric version are the API's
// (`agents/quality.ts`), so a reader of these types only ever sees results.
// ---------------------------------------------------------------------------

/**
 * Closed: each is computed by one place in the auditor. `clarity`,
 * `completeness` and `style` are the model's half, the rest are facts read
 * without one (links resolved, an owner set, a near-identical page).
 */
export const QUALITY_DIMENSIONS = ['clarity', 'completeness', 'links', 'ownership', 'duplication', 'style'] as const;
export type QualityDimension = (typeof QUALITY_DIMENSIONS)[number];

/** 0–100 per dimension; null = not measured (no model, no styleguide, no embedding). */
export type QualityDimensionScores = Record<QualityDimension, number | null>;

export type QualityIssueSeverity = 'error' | 'warning' | 'info';

/** One reason a page lost points. Capped per page; each names the dimension it cost. */
export interface QualityIssue {
  dimension: QualityDimension;
  severity: QualityIssueSeverity;
  message: string;
  /** A passage of the page, copied verbatim — dropped when the model's quote is not in the page. */
  quote?: string;
  /** The styleguide rule a `style` issue breaks. */
  ruleId?: string;
  /** The link destination a `links` issue could not resolve, as written. */
  link?: string;
  /** The peer a `duplication` issue points at. */
  documentId?: string;
}

/** A page whose mean head embedding is within the duplicate threshold of this one's. */
export interface QualityDuplicate {
  documentId: string;
  /** Mean-embedding cosine, 0–1, four decimals. */
  similarity: number;
}

/** One audit of one page at one revision. */
export interface QualityScore {
  id: string;
  documentId: string;
  projectId: string;
  revisionId: string;
  agentRunId: string | null;
  rubricVersion: number;
  /** 0–100: the weighted mean of the measured dimensions. */
  overall: number;
  dimensions: QualityDimensionScores;
  issues: QualityIssue[];
  duplicates: QualityDuplicate[];
  createdAt: string;
}

/** A point on a page's or a scope's score history. */
export interface QualityHistoryPoint {
  /** ISO date (UTC day). */
  date: string;
  overall: number;
}
