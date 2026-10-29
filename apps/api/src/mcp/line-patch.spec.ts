import { describe, expect, it } from 'vitest';
import { applyLineEdits } from './line-patch.js';

const page = 'one\ntwo\nthree\nfour\n';

describe('applyLineEdits (#603)', () => {
  it('numbers every edit off the base text, whatever order they come in', () => {
    expect(
      applyLineEdits(page, [
        { startLine: 4, endLine: 4, content: 'FOUR' },
        { startLine: 1, endLine: 2, content: 'ONE' },
      ]),
    ).toBe('ONE\nthree\nFOUR\n');
  });

  it('inserts, appends and deletes', () => {
    expect(applyLineEdits(page, [{ startLine: 2, endLine: 1, content: 'one and a half' }])).toBe('one\none and a half\ntwo\nthree\nfour\n');
    expect(applyLineEdits(page, [{ startLine: 5, endLine: 4, content: 'five\nsix' }])).toBe(page + 'five\nsix\n');
    expect(applyLineEdits(page, [{ startLine: 2, endLine: 3, content: '' }])).toBe('one\nfour\n');
    expect(applyLineEdits('', [{ startLine: 1, endLine: 0, content: 'first' }])).toBe('first');
  });

  it('keeps an insert before a replacement that starts on the same line', () => {
    expect(
      applyLineEdits(page, [
        { startLine: 2, endLine: 2, content: 'TWO' },
        { startLine: 2, endLine: 1, content: 'before' },
      ]),
    ).toBe('one\nbefore\nTWO\nthree\nfour\n');
  });

  it('refuses overlaps and lines past the end', () => {
    expect(() =>
      applyLineEdits(page, [
        { startLine: 1, endLine: 3, content: 'x' },
        { startLine: 3, endLine: 4, content: 'y' },
      ]),
    ).toThrow(/overlap/);
    expect(() => applyLineEdits(page, [{ startLine: 6, endLine: 6, content: 'x' }])).toThrow(/4 lines/);
    expect(() => applyLineEdits(page, [{ startLine: 2, endLine: 9, content: 'x' }])).toThrow(/endLine 9/);
  });
});
