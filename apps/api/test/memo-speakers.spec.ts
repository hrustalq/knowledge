import { describe, expect, it } from 'vitest';
import { identifiedSpeakers, isNumberedVoice, resolveSpeakers, speakerLabels } from '../src/memos/speakers.js';
import { memoPrompt } from '../src/agents/memo.js';

const members = new Map([
  ['u-eldar', 'Eldar Khrustalev'],
  ['u-anna', 'Anna Petrova'],
  ['u-anna2', 'Anna Sidorova'],
]);
const resolve = (labels: string[], chosen = {}, earlier: object[] = []) =>
  Object.fromEntries(resolveSpeakers({ labels, chosen, earlier: earlier as never, members }).map((s) => [s.label, s]));

describe('memo speakers (#880)', () => {
  it('lists labels in the order they first speak', () => {
    const seg = (i: number, speaker?: string) => ({ i, start: i, end: i + 1, text: 'x', ...(speaker ? { speaker } : {}) });
    expect(speakerLabels([seg(0, 'B'), seg(1), seg(2, 'A'), seg(3, 'B')])).toEqual(['B', 'A']);
  });

  it('holds a match the uploader chose, and one remembered from their newest earlier memo', () => {
    const got = resolve(['Eldar', 'Boss'], { Eldar: 'u-eldar' }, [{ Boss: 'u-anna' }, { Boss: 'u-eldar' }]);
    expect(got.Eldar).toMatchObject({ userId: 'u-eldar', source: 'confirmed' });
    expect(got.Boss).toMatchObject({ userId: 'u-anna', source: 'remembered' });
  });

  it('lets "nobody here" on this memo silence what was remembered', () => {
    expect(resolve(['Boss'], { Boss: null }, [{ Boss: 'u-anna' }]).Boss).toMatchObject({ userId: null, source: 'confirmed', suggestedUserId: null });
  });

  it('only suggests from a name, and suggests nobody when the name is ambiguous', () => {
    expect(resolve(['eldar']).eldar).toMatchObject({ userId: null, source: null, suggestedUserId: 'u-eldar' });
    expect(resolve(['Anna Petrova'])['Anna Petrova']!.suggestedUserId).toBe('u-anna');
    expect(resolve(['Anna']).Anna!.suggestedUserId).toBeNull();
  });

  it('never remembers or guesses a numbered voice: Speaker 1 is someone else in the next recording', () => {
    expect(isNumberedVoice('Speaker 2') && isNumberedVoice('Участник 12')).toBe(true);
    expect(isNumberedVoice('Speaker Phone')).toBe(false);
    expect(resolve(['Speaker 1'], {}, [{ 'Speaker 1': 'u-anna' }])['Speaker 1']).toMatchObject({ userId: null, suggestedUserId: null });
    // Chosen on this memo, it holds like any other.
    expect(resolve(['Speaker 1'], { 'Speaker 1': 'u-anna' })['Speaker 1']!.userId).toBe('u-anna');
  });

  it('drops someone who is no longer a member, wherever they came from', () => {
    expect(resolve(['A'], { A: 'u-gone' }).A!.userId).toBeNull();
    expect(resolve(['B'], {}, [{ B: 'u-gone' }]).B!.userId).toBeNull();
  });

  it('tells the secretary only matches that hold, outside the untrusted wrapper', () => {
    const speakers = resolveSpeakers({ labels: ['Eldar', 'anna petrova'], chosen: { Eldar: 'u-eldar' }, earlier: [], members });
    const told = identifiedSpeakers(speakers, members);
    expect(told).toEqual([{ label: 'Eldar', name: 'Eldar Khrustalev' }]);
    const prompt = memoPrompt('Sync', [{ i: 0, start: 0, end: 1, text: 'hello', speaker: 'Eldar' }], told);
    expect(prompt.indexOf('"Eldar" is "Eldar Khrustalev"')).toBeGreaterThan(-1);
    expect(prompt.indexOf('"Eldar" is "Eldar Khrustalev"')).toBeLessThan(prompt.indexOf('hello'));
    expect(memoPrompt('Sync', [{ i: 0, start: 0, end: 1, text: 'hello' }])).not.toContain('identified');
  });
});
