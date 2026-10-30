/** Stems Windows refuses as a file name, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
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
      // eslint-disable-next-line no-control-regex
      .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '')
      .replace(/-{2,}/g, '-'),
  );
  // Cut on a character boundary: Array.from walks code points, not UTF-16 units.
  const chars = Array.from(cleaned);
  while (Buffer.byteLength(chars.join('')) > MAX_BYTES) chars.pop();
  const s = trim(chars.join('')) || 'page';
  return RESERVED.test(s) ? `${s}-page` : s;
}
