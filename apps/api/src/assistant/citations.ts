import type { AnswerCitation, AnswerSignals, AssistantSource, AssistantToolCall } from '@knowledge/contracts';
import { assistantSourceKey, isPageSource, verificationIsStale } from '@knowledge/contracts';
import { FREE_TOOLS } from './assistant-tool-types.js';
import { askEach } from '../common/ask-each.js';
import { wrapUntrusted } from '../common/untrusted.js';

/**
 * Sentence-level citations (docs/features/38, issue #67 phase 1). Nest-free on
 * purpose: the streamed path, the one-shot `/ask` path and the unit tests all
 * run the same functions, and none of them should need a module to do it.
 *
 * The contract with the model is small. Every source it is handed carries a
 * label — `S1`, `S2`, … — and it is asked to end each factual sentence with the
 * labels that sentence rests on: `… [S2]`, `… [S1, S3]`. That is a formatting
 * rule, and a rule a prompt cannot enforce; what *is* enforced is here. Labels
 * that name no gathered source are stripped and counted, so a model that
 * invents `[S9]` lowers its own confidence rather than pointing the reader at
 * nothing. Markers inside code are left alone: a fenced block is quoted
 * material, and `[S1]` in it is somebody's array index.
 *
 * The stored text keeps the `[S2]` form rather than renumbering to `[2]`. A
 * bare `[2]` collides with ordinary prose and with markdown reference links;
 * `[S2]` cannot, so the web can decorate it without a false positive and an
 * agent reading the text over MCP can resolve it against `sources[].cite`.
 */

/** A citation marker as the model writes it: `[S1]`, `[S1, S3]`, `[S1][S3]` collapsed by the normalizer. */
export const CITE_MARKER_RE = /\[\s*(S\d+(?:\s*[,;]\s*S\d+)*)\s*\]/gi;

/** Labels inside one marker. */
export function labelsOf(marker: string): string[] {
  return marker
    .replace(/^\[|\]$/g, '')
    .split(/[,;]/)
    .map((l) => l.trim().toUpperCase())
    .filter((l) => /^S\d+$/.test(l));
}

/**
 * Hands out `S1`, `S2`, … in order of first sight, keyed by source identity
 * (`assistantSourceKey`), so a page returned by three searches is one label.
 * One instance per turn; the grounding page is labelled first so it is `S1`.
 */
export class CiteLabels {
  private readonly byKey = new Map<string, string>();

  label(source: AssistantSource | string): string {
    const key = typeof source === 'string' ? source : assistantSourceKey(source);
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const next = `S${this.byKey.size + 1}`;
    this.byKey.set(key, next);
    return next;
  }

  /** Stamp a source with its label, returning the same object. */
  tag<T extends AssistantSource>(source: T): T {
    (source as { cite?: string }).cite = this.label(source);
    return source;
  }

  known(): Set<string> {
    return new Set(this.byKey.values());
  }

  get size(): number {
    return this.byKey.size;
  }
}

export interface Span {
  start: number;
  end: number;
}

/**
 * Where the fenced code blocks are, so nothing below reads inside one. Indented
 * code is not detected — a list continuation is indented too, and a false
 * "code" there would drop a real citation.
 */
export function codeSpans(text: string): Span[] {
  const spans: Span[] = [];
  const fence = /^(\s*)(`{3,}|~{3,})[^\n]*\n/gm;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    const marker = m[2]!;
    const close = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`, 'm');
    const rest = text.slice(m.index + m[0].length);
    const c = close.exec(rest);
    const end = c ? m.index + m[0].length + c.index + c[0].length : text.length;
    spans.push({ start: m.index, end });
    fence.lastIndex = end;
  }
  return spans;
}

function inside(spans: Span[], at: number): boolean {
  return spans.some((s) => at >= s.start && at < s.end);
}

/**
 * Sentence spans outside code. A sentence ends at `.`, `!`, `?` or `…` followed
 * by whitespace or the end, at a line break that closes a block (a heading, a
 * list item, a table row), or at the end of the text. Trailing citation
 * markers belong to the sentence they follow, which is what lets a marker after
 * the full stop still count for that sentence.
 */
export function splitSentences(text: string): Span[] {
  const code = codeSpans(text);
  const out: Span[] = [];
  let start = 0;
  const push = (end: number) => {
    let s = start;
    while (s < end && /\s/.test(text[s]!)) s++;
    let e = end;
    while (e > s && /\s/.test(text[e - 1]!)) e--;
    if (e > s && !inside(code, s) && /[\p{L}\p{N}]/u.test(text.slice(s, e))) out.push({ start: s, end: e });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    if (inside(code, i)) {
      const block = code.find((c) => i >= c.start && i < c.end)!;
      push(block.start);
      start = block.end;
      i = block.end - 1;
      continue;
    }
    const ch = text[i]!;
    if (ch === '\n') {
      // A block boundary: one newline ends a list item, heading or table row;
      // two end a paragraph. Either way the sentence cannot continue past it.
      push(i);
      continue;
    }
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      // Decimal points and abbreviations like "e.g." are not sentence ends.
      const next = text[i + 1];
      if (next !== undefined && !/\s/.test(next)) continue;
      if (ch === '.' && /\b(?:e\.g|i\.e|etc|vs|т\.е|т\.д|напр)$/i.test(text.slice(Math.max(0, i - 5), i))) continue;
      // Pull trailing markers into this sentence: `… text. [S1] [S2]`.
      let j = i + 1;
      for (;;) {
        const rest = text.slice(j);
        const m = /^\s*\[\s*S\d+(?:\s*[,;]\s*S\d+)*\s*\]/i.exec(rest);
        if (!m || rest.slice(0, m[0].length).includes('\n')) break;
        j += m[0].length;
      }
      push(j);
      i = j - 1;
    }
  }
  push(text.length);
  return out;
}

export interface FinalizedCitations {
  /** The answer with unknown labels removed and marker spacing normalized. */
  text: string;
  citations: AnswerCitation[];
  /** Sentences outside code, for the coverage signal. */
  sentences: number;
  /** Markers the model wrote that named no gathered source. */
  unknown: number;
  /** Distinct labels the kept markers reference. */
  citedLabels: Set<string>;
}

/**
 * Settle a finished answer against the labels this turn actually handed out.
 *
 * Runs once, at the end of the turn, on the final text: markers are normalized
 * to `[S1, S3]` form, unknown labels are dropped (a marker left with none is
 * removed entirely, along with the space before it), and each surviving marker
 * is attributed to the sentence it closes. Offsets in the result refer to the
 * returned text, never the input.
 */
export function finalizeCitations(text: string, known: ReadonlySet<string>): FinalizedCitations {
  const code = codeSpans(text);
  let unknown = 0;
  let out = '';
  let last = 0;
  CITE_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_MARKER_RE.exec(text))) {
    if (inside(code, m.index)) continue;
    const labels = labelsOf(m[0]);
    const kept = [...new Set(labels)].filter((l) => known.has(l));
    unknown += labels.length - kept.length;
    let before = text.slice(last, m.index);
    if (kept.length === 0) {
      // Nothing left to cite: take the marker and the whitespace that led to it.
      before = before.replace(/[ \t]+$/, '');
      out += before;
    } else {
      // One space before a marker, never two, never none after a word.
      before = before.replace(/[ \t]+$/, '');
      out += before + (before.length > 0 && !/[\s(]$/.test(before) ? ' ' : '') + `[${kept.join(', ')}]`;
    }
    last = m.index + m[0].length;
  }
  out += text.slice(last);
  // Two markers that were adjacent (`[S1][S2]`, `[S1] [S2]`) become one.
  out = out.replace(/\[(S\d+(?:, S\d+)*)\]\s*\[(S\d+(?:, S\d+)*)\]/g, (_, a: string, b: string) => {
    const merged = [...new Set([...a.split(', '), ...b.split(', ')])];
    return `[${merged.join(', ')}]`;
  });

  const spans = splitSentences(out);
  const citations: AnswerCitation[] = [];
  const citedLabels = new Set<string>();
  const outCode = codeSpans(out);
  for (const span of spans) {
    const slice = out.slice(span.start, span.end);
    const cites = new Set<string>();
    const re = new RegExp(CITE_MARKER_RE.source, 'gi');
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(slice))) {
      if (inside(outCode, span.start + mm.index)) continue;
      for (const l of labelsOf(mm[0])) if (known.has(l)) cites.add(l);
    }
    if (cites.size > 0) {
      citations.push({ start: span.start, end: span.end, cites: [...cites] });
      for (const l of cites) citedLabels.add(l);
    }
  }
  // A sentence that is nothing but a marker (the model put `[S1]` on its own
  // line) is not prose and must not count against coverage.
  const sentences = spans.filter((s) => out.slice(s.start, s.end).replace(new RegExp(CITE_MARKER_RE.source, 'gi'), '').trim().length > 0).length;
  return { text: out, citations, sentences, unknown, citedLabels };
}

/** The clause appended to every chat and `/ask` system prompt. */
export const CITATION_CLAUSE =
  '\n\nCitations. Every page you are given carries a label like S1 or S2 — the current page is S1, and ' +
  'each search_knowledge, read_document, explore_document_graph and list_relations result shows its label in a ' +
  '`cite` field. End each factual sentence with the labels it rests on, in square brackets: "… [S2]" or ' +
  '"… [S1, S3]". Cite only labels you were actually given; a label you did not see is stripped from your ' +
  'answer and counts against it. A sentence that comes from no page — a greeting, a summary of your own ' +
  'steps, a statement that the workspace does not cover something — carries no label. Never put labels ' +
  'inside code blocks. Each search result also carries a verification `status`: prefer verified pages, and ' +
  'when you rely on one that is outdated, expired or edited since verification, say so in the sentence that ' +
  'cites it.';

/**
 * The observable facts `assessAnswer` reads, gathered from the finished turn.
 * Pure, so the same function can be replayed by the backtest (issue #67
 * phase 5) over persisted messages.
 */
export function answerSignals(input: {
  final: FinalizedCitations;
  /** Sources after provenance resolution, in label order. */
  sources: readonly AssistantSource[];
  trace: readonly AssistantToolCall[];
  toolErrors: number;
  /** The turn's tool budget — used to tell "ran out" from "stopped early". */
  maxToolCalls: number;
  /** Days after which an unchanged page counts as stale evidence. */
  staleAfterDays: number;
  now?: Date;
}): AnswerSignals {
  const { final, sources, trace } = input;
  const cited = sources.filter((s) => s.cite && final.citedLabels.has(s.cite));
  const pages = cited.filter(isPageSource);
  const staleBefore = (input.now ?? new Date()).getTime() - input.staleAfterDays * 86_400_000;
  // The raw cosine, never the fused `score`: RRF scores peak near 0.03 and a
  // BM25-only search normalises its top to 1.0, so neither is on the cosine
  // scale `lowScoreBelow` is (#403). A page only BM25 found contributes
  // nothing, so a turn with no vector evidence at all skips the check.
  const scores = sources.filter(isPageSource).flatMap((s) => (typeof s.vectorScore === 'number' ? [s.vectorScore] : []));
  const spent = trace.filter((c) => !FREE_TOOLS.has(c.tool)).length;
  return {
    sentences: final.sentences,
    citedSentences: final.citations.length,
    sources: sources.length,
    citedSources: cited.length,
    unknownCitations: final.unknown,
    maxScore: scores.length ? Math.max(...scores) : null,
    // A stamp that no longer vouches for the page (edited since, expired, or
    // declared outdated — docs/features/39) counts as stale beside plain age.
    staleSources: pages.filter(
      (s) =>
        (s.verification !== undefined && verificationIsStale(s.verification)) ||
        (s.changedAt !== undefined && Date.parse(s.changedAt) < staleBefore),
    ).length,
    flaggedSources: pages.filter((s) => s.verification === 'flagged').length,
    verifiedSources: pages.filter((s) => s.verification === 'verified').length,
    inferredOnly: pages.length > 0 && pages.every((s) => s.factClass === 'inferred'),
    toolErrors: input.toolErrors,
    budgetExhausted: input.maxToolCalls > 0 && spent >= input.maxToolCalls,
  };
}

/** Passage text kept per label for the support check; a page longer than this is checked against its start. */
export const SUPPORT_PASSAGE_CHARS = 12_000;

/**
 * Remember what a label's source said, for the support check (#530): the text
 * the turn handed out under that label, appended once per distinct piece and
 * capped at SUPPORT_PASSAGE_CHARS.
 */
export function notePassage(passages: Map<string, string>, label: string | undefined, text: string | undefined): void {
  if (!label || !text?.trim()) return;
  const held = passages.get(label) ?? '';
  if (held.includes(text) || held.length >= SUPPORT_PASSAGE_CHARS) return;
  passages.set(label, (held ? `${held}\n\n${text}` : text).slice(0, SUPPORT_PASSAGE_CHARS));
}

/** The decision model's question for one cited sentence (#530), as measured in docs/features/67. */
export const SUPPORT_QUESTION = {
  instructions: 'Does the passage support the sentence?',
  criteria: {
    true: 'The passage states or directly implies what the sentence says.',
    false: 'The sentence claims something the passage does not state: a different value, an added condition, or an overreach.',
  },
};

/**
 * Mark each citation supported or unsupported (#530). One question per cited
 * sentence, over the passages its labels name — only what the turn handed
 * out, never a new retrieval. A sentence none of whose labels has a passage,
 * or whose question failed, stays unmarked. The text is never touched.
 */
export async function checkSupport(
  text: string,
  citations: readonly AnswerCitation[],
  passages: ReadonlyMap<string, string>,
  ask: (state: { sentence: string; passages: Record<string, string> }) => Promise<number>,
  threshold: number,
  isFatal: (error: unknown) => boolean,
): Promise<AnswerCitation[]> {
  const asks = citations.flatMap((c, i) => {
    const cited = Object.fromEntries(
      c.cites.flatMap((label) => {
        const passage = passages.get(label);
        return passage ? [[label, wrapUntrusted(passage, 'cite', 'page')]] : [];
      }),
    );
    if (Object.keys(cited).length === 0) return [];
    const sentence = text.slice(c.start, c.end).replace(new RegExp(CITE_MARKER_RE.source, 'gi'), '').trim();
    return [{ i, state: { sentence, passages: cited } }];
  });
  const { answers } = await askEach(asks, (a) => ask(a.state), isFatal);
  const out = citations.map((c) => ({ ...c }));
  asks.forEach((a, k) => {
    const p = answers[k];
    if (p !== null && p !== undefined) out[a.i]!.support = p >= threshold ? 'supported' : 'unsupported';
  });
  return out;
}
