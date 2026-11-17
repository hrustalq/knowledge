import { describe, expect, it } from 'vitest';
import { termPattern } from '@knowledge/contracts';
import { TERM_MATCH_CASES } from '@knowledge/contracts/content/term-cases';
import { matchTerms } from '../src/context/context.service.js';
import { countOccurrences } from '../src/glossary/glossary.service.js';

// #1210: one table, run by every matcher. The web linker runs it too
// (apps/web/src/entities/document/model/glossary.spec.ts).

const label = (c: (typeof TERM_MATCH_CASES)[number]) => `${c.term} in "${c.text}" → ${c.match ?? 'nothing'}`;

describe('termPattern', () => {
  it.each(TERM_MATCH_CASES)('$term in "$text"', (c) => {
    const found = c.text.match(new RegExp(termPattern(c.term, { caseSensitive: c.caseSensitive }), c.caseSensitive ? 'u' : 'iu'));
    expect(found?.[0] ?? null, label(c)).toBe(c.match);
  });
});

describe('countOccurrences', () => {
  // It takes no casing rule (AI proposals carry none), so only the case-insensitive rows apply.
  it.each(TERM_MATCH_CASES.filter((c) => !c.caseSensitive))('$term in "$text"', (c) => {
    expect(countOccurrences(c.text, c.term), label(c)).toBe(c.match ? 1 : 0);
  });
});

describe('matchTerms', () => {
  it.each(TERM_MATCH_CASES)('$term in "$text"', (c) => {
    const term = { id: 't', term: c.term, aliases: [], matchAliases: true, caseSensitive: !!c.caseSensitive };
    expect(matchTerms(c.text, [term], 3).length, label(c)).toBe(c.match ? 1 : 0);
  });
});
