import { describe, expect, it } from 'vitest';
import { hasConflictMarkers, threeWay } from '../src/documents/three-way.js';

// #636 phase 2: the verdicts doc 71's spike measured against `git merge-file`.
const P = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}.\n\n`).join('');
const base = P(6);
const labels = { target: 'main', source: 'fix' };

describe('threeWay', () => {
  it('merges edits to different paragraphs', () => {
    const merged = threeWay(base, base.replace('Paragraph 2.', 'Two.'), base.replace('Paragraph 5.', 'Five.'), labels);
    expect(merged).toEqual({ clean: true, text: base.replace('Paragraph 2.', 'Two.').replace('Paragraph 5.', 'Five.') });
  });

  it('takes one edit made on both sides once', () => {
    const both = base.replace('Paragraph 1.', 'X.');
    expect(threeWay(base, both, both, labels)).toEqual({ clean: true, text: both });
  });

  it('conflicts on adjacent lines, as git does', () => {
    expect(threeWay('a\nb\nc\nd\n', 'a\nB\nc\nd\n', 'a\nb\nC\nd\n', labels).clean).toBe(false);
  });

  it('marks an overlap with git markers and 1-based hunks', () => {
    const merged = threeWay(base, base.replace('Paragraph 3.', 'A.'), base.replace('Paragraph 3.', 'B.'), labels);
    expect(merged.clean).toBe(false);
    if (merged.clean) return;
    expect(merged.hunks).toEqual([{ base: { start: 5, count: 1 }, target: { start: 5, count: 1 }, source: { start: 5, count: 1 } }]);
    expect(merged.text).toContain('<<<<<<< main\nA.\n=======\nB.\n>>>>>>> fix\n');
    expect(hasConflictMarkers(merged.text)).toBe(true);
  });

  it('closes a side that ends without a newline before the next marker', () => {
    const merged = threeWay('x', 'y', 'z', labels);
    expect(merged.text).toBe('<<<<<<< main\ny\n=======\nz\n>>>>>>> fix\n');
  });

  it('merges against an empty base', () => {
    expect(threeWay('', '', 'new\n', labels)).toEqual({ clean: true, text: 'new\n' });
  });

  it('does not read a setext heading as a conflict', () => {
    expect(hasConflictMarkers('Title\n=======\n\nBody\n')).toBe(false);
  });
});
