import { consolidationDay, consolidationPrompt, readConsolidation, refinement } from '../src/memory/memory-observations.js';
import { preferObservations } from '../src/memory/memory-recall.service.js';

/**
 * #993: the consolidator's answer is a claim, and the reader keeps only what
 * the facts it was shown prove. A quote must be verbatim in the fact it
 * cites; an observation left with no evidence is not written.
 */
describe('readConsolidation', () => {
  const facts = [{ text: 'Alice prefers tea over coffee.' }, { text: 'Alice drinks green tea every morning.' }, { text: 'Bob joined the billing team in May.' }];
  const observations = [{ text: 'Alice likes tea.' }];

  it('keeps a new observation whose quotes are verbatim in their facts', () => {
    const out = readConsolidation(
      { observations: [{ observation: null, text: 'Alice drinks tea, green in the morning.', evidence: [{ fact: 'F1', quote: 'prefers tea over coffee' }, { fact: 'F2', quote: 'green tea every morning' }] }] },
      facts,
      observations,
    );
    expect(out).toEqual([{ target: null, text: 'Alice drinks tea, green in the morning.', evidence: [{ fact: 0, quote: 'prefers tea over coffee' }, { fact: 1, quote: 'green tea every morning' }] }]);
  });

  it('drops a quote that is not verbatim, and an entry left with no evidence', () => {
    const out = readConsolidation(
      {
        observations: [
          // Paraphrased: "prefers tea to coffee" is not in F1.
          { observation: null, text: 'Alice prefers tea.', evidence: [{ fact: 'F1', quote: 'prefers tea to coffee' }] },
          // One good quote survives beside a bad one.
          { observation: 'O1', evidence: [{ fact: 'F2', quote: 'Green tea' }, { fact: 'F2', quote: 'green tea' }] },
        ],
      },
      facts,
      observations,
    );
    expect(out).toEqual([{ target: 0, text: null, evidence: [{ fact: 1, quote: 'green tea' }] }]);
  });

  it('drops labels it never handed out, a new observation with no text, and a second refine of one observation', () => {
    const ev = [{ fact: 'F3', quote: 'joined the billing team' }];
    const out = readConsolidation(
      {
        observations: [
          { observation: 'O2', text: 'x', evidence: ev },
          { observation: null, evidence: ev },
          { observation: null, text: 'Bob is on billing.', evidence: [{ fact: 'F9', quote: 'Bob' }] },
          { observation: 'O1', text: 'Alice likes tea; Bob is on billing.', evidence: ev },
          { observation: 'O1', text: 'Second refine.', evidence: ev },
        ],
      },
      facts,
      observations,
    );
    expect(out).toEqual([{ target: 0, text: 'Alice likes tea; Bob is on billing.', evidence: [{ fact: 2, quote: 'joined the billing team' }] }]);
  });

  it('reads nothing from an answer of the wrong shape', () => {
    expect(readConsolidation(null, facts, observations)).toEqual([]);
    expect(readConsolidation({ observations: 'all of them' }, facts, observations)).toEqual([]);
    expect(readConsolidation({ observations: [null, 7, { evidence: 'F1' }] }, facts, observations)).toEqual([]);
  });

  it('wraps the facts and the observations it shows the model as untrusted', () => {
    const prompt = consolidationPrompt(facts, observations, 'Remember preferences.');
    expect(prompt).toContain('What this memory bank is for: Remember preferences.');
    expect(prompt).toMatch(/<memories tool="consolidate">\n[^\n]*\nF1: Alice prefers tea over coffee\.\nF2:/);
    expect(prompt).toMatch(/<memories tool="consolidate">\n[^\n]*\nO1: Alice likes tea\./);
    expect(consolidationPrompt(facts, [], '')).toContain('Existing observations:\n(none yet)');
  });
});

describe('refinement', () => {
  it('keeps the text it replaces for the history row', () => {
    expect(refinement('Alice likes tea.', { text: 'Alice switched from tea to coffee in June.' })).toEqual({ text: 'Alice switched from tea to coffee in June.', previous: 'Alice likes tea.' });
  });

  it('writes no history when only evidence is added or the wording is unchanged', () => {
    expect(refinement('Alice likes tea.', { text: null })).toEqual({ text: 'Alice likes tea.', previous: null });
    expect(refinement('Alice likes tea.', { text: 'Alice likes tea.' })).toEqual({ text: 'Alice likes tea.', previous: null });
  });
});

describe('consolidationDay', () => {
  it('is the UTC day, so the cap resets at midnight UTC', () => {
    expect(consolidationDay(Date.parse('2026-11-12T23:59:59Z'))).toBe('2026-11-12');
    expect(consolidationDay(Date.parse('2026-11-13T00:00:00Z'))).toBe('2026-11-13');
  });
});

describe('preferObservations', () => {
  const r = (id: string, factType: string, evidence: string[] = [], text = 'x'.repeat(40)) => ({ text, row: { id, factType, evidence: evidence.map((factId) => ({ factId })) } });

  it('drops the facts a kept observation stands on and backfills the freed room', () => {
    // 10 tokens each; a budget of 30 keeps three.
    const rows = [r('f1', 'world'), r('o1', 'observation', ['f1', 'f2']), r('f2', 'world'), r('f3', 'world'), r('f4', 'world')];
    expect(preferObservations(rows, 30).map((x) => x.row.id)).toEqual(['o1', 'f3', 'f4']);
  });

  it('settles when an observation backfilled in covers more facts', () => {
    const rows = [r('f1', 'world'), r('o1', 'observation', ['f1']), r('f2', 'world'), r('o2', 'observation', ['f2']), r('f3', 'world')];
    expect(preferObservations(rows, 30).map((x) => x.row.id)).toEqual(['o1', 'o2', 'f3']);
  });

  it('changes nothing when no observation is kept', () => {
    const rows = [r('f1', 'world'), r('f2', 'world'), r('o1', 'observation', ['f1'])];
    expect(preferObservations(rows, 20).map((x) => x.row.id)).toEqual(['f1', 'f2']);
  });
});
