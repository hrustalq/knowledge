import { describe, expect, it } from 'vitest';
import { INTERVIEW_MAX_QUESTIONS } from '@knowledge/contracts';
import { readRound, transcriptOf } from '../src/assistant/interview-round.js';

const q = (name: string) => ({ type: 'choice', name, label: `Q ${name}`, options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] });

describe('interview round (shared by Describe it and the purpose interview)', () => {
  it('caps a round at the default, and at an asker’s tighter cap', () => {
    const raw = Array.from({ length: 9 }, (_, i) => q(`q${i}`));
    expect(readRound(raw).questions).toHaveLength(INTERVIEW_MAX_QUESTIONS);
    expect(readRound(raw, { questions: 2, options: 1 }).questions.map((f) => (f.type === 'choice' ? f.options.length : 0))).toEqual([1, 1]);
    expect(readRound('nonsense').questions).toEqual([]);
  });

  it('renders answers as labels, and a missing one as skipped', () => {
    const round = readRound([q('one'), q('two'), { type: 'text', name: 'three', label: 'Why' }]);
    const text = transcriptOf([{ ...round, answers: { one: 'b', three: 'because' } }]);
    expect(text).toBe('Round 1\nQ: Q one\nA: Beta\nQ: Q two\nA: (skipped)\nQ: Why\nA: because');
  });
});
