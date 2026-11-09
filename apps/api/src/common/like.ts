/** `s` as a literal inside a LIKE / ILIKE pattern: `\`, `%` and `_` escaped (`\` is Postgres's default escape). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
