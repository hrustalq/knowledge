import { describe, expect, it } from 'vitest';
import { queryStems, snippetPartsOf } from '../src/search/snippet.js';

/** #443: the result row's snippet is a window around the match, the matched words marked. */
const hits = (parts: { text: string; hit: boolean }[]) => parts.filter((p) => p.hit).map((p) => p.text);

describe('snippetPartsOf', () => {
  it('marks every form of a Russian word, either way round', () => {
    const text = 'Сервис биллинга. Настройки сервиса и сервисы рядом.';
    expect(hits(snippetPartsOf(text, 'сервис'))).toEqual(['Сервис', 'сервиса', 'сервисы']);
    expect(hits(snippetPartsOf(text, 'СЕРВИСА'))).toEqual(['Сервис', 'сервиса', 'сервисы']);
  });

  it('opens the window near a match past the first 300 characters', () => {
    const text = `${'filler '.repeat(80)}the Deploy runbook says deploying needs a tag`;
    const parts = snippetPartsOf(text, 'deploy');
    expect(hits(parts)).toEqual(['Deploy', 'deploying']);
    // Starts on a whole word, ends where the chunk does.
    expect(parts.map((p) => p.text).join('')).toMatch(/^…filler .* needs a tag$/);
  });

  it('invents no mark when nothing matches', () => {
    const text = 'a'.repeat(400);
    expect(snippetPartsOf(text, 'meaning only')).toEqual([{ text: `${'a'.repeat(300)}…`, hit: false }]);
  });

  it('drops words too short to mark', () => {
    expect(queryStems('и a to сервиса Users')).toEqual(['серви', 'user']);
  });
});
