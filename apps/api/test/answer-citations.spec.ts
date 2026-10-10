import { describe, expect, it } from 'vitest';
import type { AssistantSource } from '@knowledge/contracts';
import {
  CITATION_CLAUSE,
  CiteLabels,
  answerSignals,
  codeSpans,
  finalizeCitations,
  labelsOf,
  splitSentences,
} from '../src/assistant/citations.js';

/**
 * Sentence-level citations (docs/features/38, issue #67 phase 1).
 *
 * The model is asked to end sentences with `[S#]`; what is pinned here is the
 * part a prompt cannot promise — that an invented label never reaches the
 * reader, that markers inside code are quoted material, and that a marker
 * after the full stop still belongs to the sentence it closes.
 */

const known = new Set(['S1', 'S2', 'S3']);

describe('CiteLabels', () => {
  it('hands out S1, S2, … once per source identity', () => {
    const labels = new CiteLabels();
    const page: AssistantSource = { documentId: 'a', title: 'A' };
    expect(labels.label(page)).toBe('S1');
    expect(labels.label({ documentId: 'a', title: 'A again' })).toBe('S1');
    expect(labels.label({ kind: 'web', url: 'https://x.test/p', site: 'x.test', title: 'X' })).toBe('S2');
    expect(labels.tag({ documentId: 'b', title: 'B' }).cite).toBe('S3');
    expect([...labels.known()]).toEqual(['S1', 'S2', 'S3']);
  });
});

describe('labelsOf', () => {
  it('reads one marker in its loose forms', () => {
    expect(labelsOf('[S1]')).toEqual(['S1']);
    expect(labelsOf('[S1, S3]')).toEqual(['S1', 'S3']);
    expect(labelsOf('[ s2 ;S1 ]')).toEqual(['S2', 'S1']);
  });
});

describe('codeSpans / splitSentences', () => {
  it('finds fenced blocks and keeps sentences out of them', () => {
    const text = 'Run it. [S1]\n\n```ts\nconst a = b[S1]. Done.\n```\n\nThen stop. [S2]';
    const code = codeSpans(text);
    expect(code).toHaveLength(1);
    expect(text.slice(code[0]!.start, code[0]!.end)).toContain('const a');
    const spans = splitSentences(text).map((s) => text.slice(s.start, s.end));
    expect(spans).toEqual(['Run it. [S1]', 'Then stop. [S2]']);
  });

  it('ends a sentence at a line break and keeps trailing markers with it', () => {
    const text = '## Heading\n- first point [S1]\n- second point. [S2] [S3]\nTail without stop [S1]';
    const spans = splitSentences(text).map((s) => text.slice(s.start, s.end));
    expect(spans).toEqual(['## Heading', '- first point [S1]', '- second point. [S2] [S3]', 'Tail without stop [S1]']);
  });

  it('does not split on decimals or e.g.', () => {
    const text = 'Version 1.2 ships e.g. the fix. [S1] Next one.';
    const spans = splitSentences(text).map((s) => text.slice(s.start, s.end));
    expect(spans).toEqual(['Version 1.2 ships e.g. the fix. [S1]', 'Next one.']);
  });
});

describe('finalizeCitations', () => {
  it('maps sentences to the labels that close them', () => {
    const out = finalizeCitations('Sessions expire after a day. [S1] Keys never do [S2, S3].', known);
    expect(out.unknown).toBe(0);
    expect(out.sentences).toBe(2);
    expect(out.citations).toHaveLength(2);
    expect(out.text.slice(out.citations[0]!.start, out.citations[0]!.end)).toBe('Sessions expire after a day. [S1]');
    expect(out.citations[0]!.cites).toEqual(['S1']);
    expect(out.citations[1]!.cites).toEqual(['S2', 'S3']);
    expect([...out.citedLabels]).toEqual(['S1', 'S2', 'S3']);
  });

  it('strips labels nobody returned and counts them', () => {
    const out = finalizeCitations('A fact. [S9] Another fact. [S1, S7]', known);
    expect(out.text).toBe('A fact. Another fact. [S1]');
    expect(out.unknown).toBe(2);
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0]!.cites).toEqual(['S1']);
    expect(out.sentences).toBe(2);
  });

  it('normalizes marker spacing and merges adjacent markers', () => {
    const out = finalizeCitations('Fact one.[S1][S2] Fact two . [ S3 ;S1 ]', known);
    expect(out.text).toBe('Fact one. [S1, S2] Fact two . [S3, S1]');
    expect(out.citations.map((c) => c.cites)).toEqual([['S1', 'S2'], ['S3', 'S1']]);
  });

  it('leaves markers inside code alone, and does not count them', () => {
    const src = 'Use the index. [S1]\n\n```\nitems[S1]\narr[S99]\n```\n';
    const out = finalizeCitations(src, known);
    expect(out.text).toBe(src);
    expect(out.unknown).toBe(0);
    expect(out.citations).toHaveLength(1);
  });

  it('offsets point into the returned text, not the input', () => {
    const out = finalizeCitations('Dropped. [S42] Kept. [S2]', known);
    for (const c of out.citations) expect(out.text.slice(c.start, c.end)).toBe('Kept. [S2]');
  });

  it('reports no citations for an uncited answer', () => {
    const out = finalizeCitations('I do not know.', known);
    expect(out.citations).toEqual([]);
    expect(out.sentences).toBe(1);
    expect(out.citedLabels.size).toBe(0);
  });
});

describe('answerSignals', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const sources: AssistantSource[] = [
    { documentId: 'a', title: 'A', cite: 'S1', verification: 'verified', changedAt: '2026-10-01T00:00:00Z', score: 0.8, factClass: 'explicit' },
    { documentId: 'b', title: 'B', cite: 'S2', verification: 'outdated', changedAt: '2025-01-01T00:00:00Z', score: 0.3, factClass: 'inferred' },
    { documentId: 'c', title: 'C', cite: 'S3', verification: 'unverified', changedAt: '2026-09-01T00:00:00Z' },
  ];

  it('counts only the cited sources for freshness and verification', () => {
    const final = finalizeCitations('One. [S1] Two. [S2] Three without.', new Set(['S1', 'S2', 'S3']));
    const s = answerSignals({ final, sources, trace: [], toolErrors: 0, maxToolCalls: 24, staleAfterDays: 180, now });
    expect(s).toMatchObject({
      sentences: 3,
      citedSentences: 2,
      sources: 3,
      citedSources: 2,
      unknownCitations: 0,
      maxScore: 0.8,
      staleSources: 1,
      verifiedSources: 1,
      flaggedSources: 0,
      inferredOnly: false,
      budgetExhausted: false,
    });
  });

  it('sees an answer built only from inferred edges, and a spent budget', () => {
    const final = finalizeCitations('Only this. [S2]', new Set(['S1', 'S2', 'S3']));
    const trace = Array.from({ length: 3 }, () => ({ tool: 'search_knowledge', arguments: '{}', ok: true }));
    trace.push({ tool: 'ask_user', arguments: '{}', ok: true });
    const s = answerSignals({ final, sources, trace, toolErrors: 1, maxToolCalls: 3, staleAfterDays: 180, now });
    expect(s.inferredOnly).toBe(true);
    expect(s.budgetExhausted).toBe(true);
    expect(s.toolErrors).toBe(1);
  });
});

describe('CITATION_CLAUSE', () => {
  it('names the label scheme and the current page', () => {
    expect(CITATION_CLAUSE).toContain('S1');
    expect(CITATION_CLAUSE).toContain('[S2]');
  });
});
