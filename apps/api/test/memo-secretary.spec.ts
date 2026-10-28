import { describe, expect, it } from 'vitest';
import type { MemoSegment } from '@knowledge/contracts';
import { memoClock as clock } from '@knowledge/contracts';
import { memoCitedIds, memoPrompt, readMemoProposals, type MemoProposalContext } from '../src/agents/memo.js';

/**
 * The secretary (#551): what is pinned here is what a confident model answer
 * must not get past — a citation of a moment the recording does not have, an
 * update to a page the run never retrieved or the uploader cannot read — and
 * that every kept proposal links back to its moments by time alone.
 */
const PAGE = '11111111-2222-4333-8444-555555555555';
const HIDDEN = '66666666-7777-4888-8999-000000000000';
const BODY = 'A full page body that is clearly longer than one sentence. '.repeat(6);

const segments: MemoSegment[] = [
  { i: 0, start: 0, end: 4, text: 'Good morning everyone' },
  { i: 1, start: 61.4, end: 70, text: 'We move billing to the new queue next Tuesday' },
  { i: 2, start: 3725, end: 3730, text: 'Retries stay at three' },
];

function ctx(overrides: Partial<MemoProposalContext> = {}): MemoProposalContext {
  return {
    retrieved: new Set([PAGE, HIDDEN]),
    visible: new Map([[PAGE, 'Billing queue']]),
    segments,
    max: 3,
    linkAt: (s) => `https://kb/memos/m1?t=${s}`,
    label: (time) => `Memo · ${time}`,
    ...overrides,
  };
}

describe('readMemoProposals', () => {
  it('keeps a grounded update and a grounded create, linking each to its moments by time only', () => {
    const { summary, findings, dropped } = readMemoProposals(
      {
        summary: 'Billing moves to the new queue.',
        proposals: [
          { action: 'update', documentId: PAGE, title: 'Billing queue', detail: 'New queue from Tuesday', markdown: BODY, segments: [1] },
          { action: 'create', title: 'Retry policy', detail: 'Three retries', markdown: BODY, segments: [2, 1] },
        ],
      },
      ctx(),
    );
    expect(summary).toBe('Billing moves to the new queue.');
    expect(dropped).toEqual([]);
    expect(findings[0]).toMatchObject({ documentIds: [PAGE], documentTitles: ['Billing queue'], memo: { action: 'update', segments: [1] } });
    expect(findings[0]!.sources).toEqual([{ kind: 'web', url: 'https://kb/memos/m1?t=61', site: '', title: 'Memo · 1:01' }]);
    // A create cites no page, and its moments are in recording order.
    expect(findings[1]).toMatchObject({ documentIds: [], memo: { action: 'create', segments: [1, 2] } });
    expect(findings[1]!.sources!.map((s) => s.title)).toEqual(['Memo · 1:01', 'Memo · 1:02:05']);
  });

  it('drops a proposal citing a segment the transcript does not have, or citing none', () => {
    const { findings, dropped } = readMemoProposals(
      {
        proposals: [
          { action: 'create', title: 'Invented', detail: '', markdown: BODY, segments: [1, 9] },
          { action: 'create', title: 'Uncited', detail: '', markdown: BODY },
        ],
      },
      ctx(),
    );
    expect(findings).toEqual([]);
    expect(dropped).toEqual([
      { title: 'Invented', reason: 'unknown-segment' },
      { title: 'Uncited', reason: 'unknown-segment' },
    ]);
  });

  it('drops an update to a page the run never retrieved, even one the uploader may read', () => {
    const { findings, dropped } = readMemoProposals(
      { proposals: [{ action: 'update', documentId: PAGE, title: 'Billing queue', markdown: BODY, segments: [1] }] },
      ctx({ retrieved: new Set() }),
    );
    expect(findings).toEqual([]);
    expect(dropped).toEqual([{ title: 'Billing queue', reason: 'unknown-page' }]);
  });

  it('drops an update to a page the uploader cannot read, even one a tool returned', () => {
    const { findings, dropped } = readMemoProposals(
      { proposals: [{ action: 'update', documentId: HIDDEN, title: 'Restricted', markdown: BODY, segments: [1] }] },
      ctx(),
    );
    expect(findings).toEqual([]);
    expect(dropped).toEqual([{ title: 'Restricted', reason: 'unknown-page' }]);
  });

  it('drops a sentence posing as a page, a second update of one page, and anything past the limit', () => {
    const { findings, dropped } = readMemoProposals(
      {
        proposals: [
          { action: 'create', title: 'Short', markdown: 'One line.', segments: [1] },
          { action: 'update', documentId: PAGE, title: 'First', markdown: BODY, segments: [1] },
          { action: 'update', documentId: PAGE, title: 'Again', markdown: BODY, segments: [2] },
          { action: 'create', title: 'Over', markdown: BODY, segments: [2] },
        ],
      },
      ctx({ max: 1 }),
    );
    expect(findings.map((f) => f.title)).toEqual(['First']);
    expect(dropped).toEqual([
      { title: 'Short', reason: 'too-short' },
      { title: 'Again', reason: 'duplicate' },
      { title: 'Over', reason: 'over-limit' },
    ]);
  });

  it('reads small talk as nothing to propose', () => {
    expect(readMemoProposals({ summary: 'Small talk.', proposals: [] }, ctx())).toEqual({
      summary: 'Small talk.',
      findings: [],
      dropped: [],
    });
    expect(readMemoProposals('not json', ctx())).toEqual({ summary: null, findings: [], dropped: [] });
  });
});

describe('the memo prompt', () => {
  it('shows the transcript as numbered, timed lines inside the untrusted wrapper', () => {
    const prompt = memoPrompt('Daily', segments);
    expect(prompt).toContain('<recording-transcript tool="memo">');
    expect(prompt).toContain('[1] 1:01–1:10 We move billing to the new queue next Tuesday');
    expect(prompt.indexOf('"Daily"')).toBeLessThan(prompt.indexOf('<recording-transcript'));
  });

  it('collects the ids an answer names, for one visibility query', () => {
    expect(memoCitedIds({ proposals: [{ documentId: PAGE }, { title: 'x' }, null] })).toEqual([PAGE]);
    expect(clock(59.9)).toBe('0:59');
  });
});
