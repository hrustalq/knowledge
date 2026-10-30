import { diff3Merge } from 'node-diff3';
import type { MergeConflictHunk } from '@knowledge/contracts';

/**
 * A line-level 3-way merge that agrees with `git merge-file` (#636, doc 71):
 * `node-diff3` with `excludeFalseConflicts`, over lines that keep their `\n`,
 * matched git on 3,000 of 3,000 fuzzed edits in the spike. Users resolve a
 * conflict with local git, so the verdict has to be git's.
 *
 * `target` is ours and `source` theirs, as in `git merge <source>` on the
 * target. A conflict's `text` carries git's markers, labelled with the branch
 * names, for a person to resolve.
 */
export type ThreeWayResult = { clean: true; text: string } | { clean: false; text: string; hunks: MergeConflictHunk[] };

const lines = (s: string): string[] => (s === '' ? [] : s.split(/(?<=\n)/));
/** A side that ends without a newline still needs one before the next marker. */
const block = (ls: string[]): string => {
  const s = ls.join('');
  return s === '' || s.endsWith('\n') ? s : `${s}\n`;
};

export function threeWay(
  base: string,
  target: string,
  source: string,
  labels: { target: string; source: string } = { target: 'target', source: 'source' },
): ThreeWayResult {
  const regions = diff3Merge(lines(target), lines(base), lines(source), { excludeFalseConflicts: true });
  const hunks: MergeConflictHunk[] = [];
  let text = '';
  for (const r of regions) {
    if (r.ok) {
      text += r.ok.join('');
      continue;
    }
    const c = r.conflict!;
    hunks.push({
      base: { start: c.oIndex + 1, count: c.o.length },
      target: { start: c.aIndex + 1, count: c.a.length },
      source: { start: c.bIndex + 1, count: c.b.length },
    });
    text += `<<<<<<< ${labels.target}\n${block(c.a)}=======\n${block(c.b)}>>>>>>> ${labels.source}\n`;
  }
  return hunks.length ? { clean: false, text, hunks } : { clean: true, text };
}

/**
 * Whether a body still holds a conflict — never stored as a resolution. The
 * opening and closing markers, not `=======`, which is also a setext heading.
 */
export const hasConflictMarkers = (text: string): boolean => /^<{7} /m.test(text) && /^>{7} /m.test(text);
