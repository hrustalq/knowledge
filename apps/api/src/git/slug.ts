/** Stems Windows refuses as a file name, whatever the extension. */
export const RESERVED_STEM = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/**
 * One character no file name may hold, on any system a tree is checked out
 * on: path separators, Windows' reserved punctuation, control characters.
 * Not global, so `.test()` keeps no state; build a `/g` copy to replace.
 */
// eslint-disable-next-line no-control-regex
export const FILENAME_FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f\u007f]/;
const MAX_BYTES = 80;

/**
 * A page's file name in its project's git tree, from its title (#636, docs/features/71
 * "Slug rules"). Cyrillic stays Cyrillic. The migration that backfilled
 * `documents.slug` spells the same rule in SQL (`20261221100000_project_commits`);
 * a stored slug never flips, so the two only have to agree on new titles.
 */
export function slugFor(title: string): string {
  const trim = (s: string) => s.replace(/^[-.]+|[-.]+$/g, '');
  const cleaned = trim(
    title
      .normalize('NFC')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(new RegExp(FILENAME_FORBIDDEN.source, 'g'), '')
      .replace(/-{2,}/g, '-'),
  );
  // Cut on a character boundary: Array.from walks code points, not UTF-16 units.
  const chars = Array.from(cleaned);
  while (Buffer.byteLength(chars.join('')) > MAX_BYTES) chars.pop();
  const s = trim(chars.join('')) || 'page';
  return RESERVED_STEM.test(s) ? `${s}-page` : s;
}
