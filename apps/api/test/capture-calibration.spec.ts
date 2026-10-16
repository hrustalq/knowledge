import { describe, expect, it } from 'vitest';
import {
  amendErrors,
  dedupeErrors,
  MIN_SECTION_CHARS,
  pickCase,
  probeTexts,
  sectionKey,
  splitScores,
  templatedHeadings,
  thresholdGrid,
  type CalibrationChunk,
  type CaseScores,
} from '../src/captures/capture-calibration.js';

/**
 * Capture threshold calibration (issue #234): which section of a page stands
 * in for a capture, how its scores split, and what each threshold gets wrong.
 */

const page = { documentId: 'd1', title: 'Webhook delivery' };
const body = 'x'.repeat(MIN_SECTION_CHARS);
const lead = 'Webhooks are delivered at least once, signed, and retried with backoff for a day.';
const chunk = (idx: number, headingPath: string[], text: string): CalibrationChunk => ({ documentId: 'd1', idx, headingPath, text });

describe('pickCase', () => {
  it('takes a single-chunk section under a heading and the first long paragraph', () => {
    const c = pickCase(page, [chunk(1, ['Retries'], body), chunk(0, [], `Short.\n\n${lead}`)]);
    expect(c).toMatchObject({ section: sectionKey(['Retries']), sectionTitle: 'Retries', sectionText: body, lead });
  });

  it('refuses a page whose only section could be removed', () => {
    expect(pickCase(page, [chunk(0, ['Retries'], `${lead}\n\n${body}`)])).toBeNull();
  });

  it('skips a section split across chunks, one without a heading, and a thin one', () => {
    const chunks = [chunk(0, [], lead), chunk(1, ['Long'], body), chunk(2, ['Long'], body), chunk(3, ['Thin'], 'short')];
    expect(pickCase(page, chunks)).toBeNull();
  });

  it('never samples a template slot', () => {
    const chunks = [chunk(0, [], lead), chunk(1, ['**2. Foreign keys**'], body), chunk(2, ['Retries'], body)];
    const templated = templatedHeadings([chunks, [chunk(0, ['Foreign keys'], body)], [chunk(0, ['1. foreign keys'], body)]]);
    expect([...templated]).toEqual(['foreign keys']);
    expect(pickCase(page, chunks, templated)?.sectionTitle).toBe('Retries');
  });

  it('picks the same section every run', () => {
    const chunks = [chunk(0, [], lead), chunk(1, ['A'], body), chunk(2, ['B'], body), chunk(3, ['C'], body)];
    expect(pickCase(page, chunks)?.section).toBe(pickCase(page, [...chunks].reverse())?.section);
  });
});

describe('probeTexts', () => {
  it('embeds what a capture would: its title, a blank line, the text', () => {
    const c = pickCase(page, [chunk(0, [], lead), chunk(1, ['Retries'], body)])!;
    expect(probeTexts(c)).toEqual({
      amend: `Retries\n\n${body}`,
      sameTitle: `Webhook delivery\n\n${body}`,
      restatement: `Webhook delivery\n\n${lead}`,
    });
  });
});

describe('splitScores', () => {
  const c = pickCase(page, [chunk(0, [], lead), chunk(1, ['Retries'], body)])!;
  const scored = [
    { documentId: 'd1', headingPath: ['Retries'], score: 0.99 },
    { documentId: 'd1', headingPath: [], score: 0.7 },
    { documentId: 'd2', headingPath: [], score: 0.6 },
    { documentId: 'd3', headingPath: [], score: 0.65 },
  ];

  it('leaves the removed section out of its own page', () => {
    expect(splitScores(c, scored, true)).toEqual({ own: 0.7, other: 0.65, otherDocumentId: 'd3' });
  });

  it('keeps it for a restatement', () => {
    expect(splitScores(c, scored, false)).toEqual({ own: 0.99, other: 0.65, otherDocumentId: 'd3' });
  });
});

describe('error shares', () => {
  const s = (own: number, other: number) => ({ own, other });
  const cases: CaseScores[] = [
    { amend: s(0.85, 0.6), sameTitle: s(0.9, 0.6), restatement: s(0.95, 0.6) },
    { amend: s(0.7, 0.75), sameTitle: s(0.8, 0.7), restatement: s(0.88, 0.9) },
  ];

  it('counts a scattered subject, a wrong page and a false amend', () => {
    expect(amendErrors(cases, 0.8)).toEqual({ threshold: 0.8, scattered: 0.5, wrongPage: 0, falseAmend: 0 });
    expect(amendErrors(cases, 0.72)).toEqual({ threshold: 0.72, scattered: 0, wrongPage: 0.5, falseAmend: 0.5 });
  });

  it('counts a missed restatement and a dropped new fact', () => {
    // The second restatement is outranked by another page, so it is missed at any threshold.
    expect(dedupeErrors(cases, 0.92)).toEqual({ threshold: 0.92, missed: 0.5, dropped: 0 });
    expect(dedupeErrors(cases, 0.85)).toEqual({ threshold: 0.85, missed: 0.5, dropped: 0.5 });
  });
});

it('steps the grid without float drift', () => {
  const grid = thresholdGrid();
  expect(grid[0]).toBe(0.5);
  expect(grid.at(-1)).toBe(0.98);
  expect(grid).toContain(0.92);
});
