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

// ---------------------------------------------------------------------------
// The read side (#74, phase 5): the Quality tab of knowledge health, the page
// rail and `knowledge_get_page_quality`. Every figure is computed from each
// page's newest row at read time — no stored aggregate — and only over pages
// the caller may open.
// ---------------------------------------------------------------------------

/** Score bands of the distribution, low to high; each lower bound inclusive. */
export const QUALITY_BANDS = [0, 20, 40, 60, 80] as const;

/** The band `overall` falls in: an index into `QUALITY_BANDS`. */
export function qualityBand(overall: number): number {
  let band = 0;
  for (const [i, floor] of QUALITY_BANDS.entries()) if (overall >= floor) band = i;
  return band;
}

/** One page's newest score, as a list shows it. */
export interface QualityPageRow {
  documentId: string;
  projectId: string;
  title: string;
  overall: number;
  dimensions: QualityDimensionScores;
  issueCount: number;
  /** The page changed after this score: its head is not the scored revision. */
  stale: boolean;
  scoredAt: string;
}

export interface QualityDimensionMean {
  /** Mean 0–100 over the pages where it was measured; null when none were. */
  mean: number | null;
  measured: number;
}

/** A styleguide rule, by how many of the latest scores it cost points. */
export interface QualityRuleCount {
  ruleId: string;
  /** The rule's text in the styleguide that applies to the scope; null when it is no longer there. */
  text: string | null;
  /** Issues citing it, across pages. */
  count: number;
  pages: number;
}

export interface QualitySummaryResponse {
  /** Listed, unarchived pages in scope the caller may open. */
  totalPages: number;
  scoredPages: number;
  /** Mean overall of the scored pages; null when none are. */
  average: number | null;
  /** Page counts per `QUALITY_BANDS` entry. */
  distribution: number[];
  dimensions: Record<QualityDimension, QualityDimensionMean>;
  /** Per audit day: the mean of each page's newest score as of that day. */
  history: QualityHistoryPoint[];
  /** Lowest-scoring pages first. */
  worst: QualityPageRow[];
  /** Most-cited styleguide rules first. */
  rules: QualityRuleCount[];
  lastAuditAt: string | null;
  /** QUALITY_FINDING_THRESHOLD: below it a page is reported as low quality. */
  lowThreshold: number;
}

export const QUALITY_SORTS = ['worst', 'best', 'title', 'recent'] as const;
export type QualitySort = (typeof QUALITY_SORTS)[number];

export interface QualityListResponse {
  rows: QualityPageRow[];
  total: number;
  nextCursor: string | null;
}

/** A near-duplicate peer the caller may open, with its title. */
export interface QualityPeer extends QualityDuplicate {
  title: string;
}

/** One page's quality: its newest score (null until audited) and its history. */
export interface DocumentQualityResponse {
  documentId: string;
  /** Peers the caller may not open, and the issues naming them, are left out. */
  score: QualityScore | null;
  peers: QualityPeer[];
  /** The page changed after its newest score. */
  stale: boolean;
  /** One point per audit day, oldest first. */
  history: QualityHistoryPoint[];
  /** QUALITY_FINDING_THRESHOLD: below it a page is reported as low quality. */
  lowThreshold: number;
}
