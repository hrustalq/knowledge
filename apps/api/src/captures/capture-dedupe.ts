import { createHash } from 'node:crypto';
import { normalizeEntityKey, type CaptureSimilar } from '@knowledge/contracts';

/**
 * The pure half of capture dedupe (issue #73): what counts as the same
 * capture, and what a similarity ranking decides. The service does the I/O
 * (the vector leg, the glossary rows) and asks these.
 */

/** A title as a person would compare it: NFC, case-folded, single-spaced, no trailing punctuation. */
export function normalizeCaptureTitle(title: string): string {
  return title
    .normalize('NFC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?:;,]+$/, '')
    .trim();
}

/**
 * sha256 over the kind, the normalized title and the payload with its strings
 * trimmed and its keys sorted — so the same capture sent twice hashes the
 * same whatever order the agent's JSON came in. The session is left out on
 * purpose: two sessions capturing one fact are one fact.
 */
export function captureContentHash(kind: string, title: string, payload: unknown): string {
  return createHash('sha256')
    .update(stableJson({ kind, title: normalizeCaptureTitle(title), payload }))
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.trim().replace(/\s+/g, ' '));
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Chunk hits folded to one score per page (its best chunk), best first, at most `limit`. */
export function rankSimilar(
  hits: ReadonlyArray<{ documentId: string; score: number }>,
  titles: ReadonlyMap<string, string>,
  limit: number,
): CaptureSimilar[] {
  const best = new Map<string, number>();
  for (const hit of hits) {
    if (!titles.has(hit.documentId)) continue;
    best.set(hit.documentId, Math.max(best.get(hit.documentId) ?? -1, hit.score));
  }
  return [...best]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([documentId, score]) => ({ documentId, title: titles.get(documentId)!, score: Number(score.toFixed(4)) }));
}

export type PageDecision =
  | { outcome: 'none'; targetDocumentId: string }
  | { outcome: 'amend-page'; targetDocumentId: string }
  | { outcome: 'new-page'; targetDocumentId: null };

/**
 * What the nearest page says the capture is:
 * - at or above the duplicate threshold **and** under the same title — a
 *   restatement of that page, so nothing is proposed;
 * - at or above the amend threshold — a section for that page;
 * - otherwise a page of its own.
 *
 * Close is not enough for a duplicate: a page about the same subsystem scores
 * high whatever new thing the capture says about it, and dropping that would
 * lose exactly the knowledge this exists to keep.
 */
export function decidePage(
  similar: readonly CaptureSimilar[],
  title: string,
  thresholds: { dedupe: number; amend: number },
): PageDecision {
  const top = similar[0];
  if (!top) return { outcome: 'new-page', targetDocumentId: null };
  if (top.score >= thresholds.dedupe && normalizeCaptureTitle(top.title) === normalizeCaptureTitle(title)) {
    return { outcome: 'none', targetDocumentId: top.documentId };
  }
  if (top.score >= thresholds.amend) return { outcome: 'amend-page', targetDocumentId: top.documentId };
  return { outcome: 'new-page', targetDocumentId: null };
}

/** A term and its aliases as one set of folded keys — the glossary's sense of "the same word". */
export function foldTermKeys(term: string, aliases: readonly string[] = []): Set<string> {
  return new Set([term, ...aliases].map((s) => normalizeEntityKey(s.trim())).filter(Boolean));
}
