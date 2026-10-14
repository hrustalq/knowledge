/**
 * Glob → RegExp, shared by the code tools (docs/features/31) and the repo
 * wiki's include/exclude (docs/features/46). A leaf, so the connector adapters
 * can use it without importing the code-research service.
 */

/**
 * `src/**\/*.ts`, `*.go`, `apps/api/**` — the three shapes people write.
 * `**` crosses directories, `*` does not, and a bare filename pattern with no
 * slash matches at any depth, which is what `*.go` means to everyone.
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.replace(/^\.?\//, '').replace(/\/+$/, '');
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .replace(/\*\*\//g, '\uE000')
    .replace(/\*\*/g, '\uE001')
    .replace(/\*/g, '[^/]*')
    .replace(/\uE000/g, '(?:.*/)?')
    .replace(/\uE001/g, '.*');
  const anchored = pattern.includes('/') ? `^${body}(?:/.*)?$` : `^(?:.*/)?${body}$`;
  return new RegExp(anchored);
}
