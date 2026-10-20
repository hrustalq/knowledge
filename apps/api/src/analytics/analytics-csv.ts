/**
 * RFC 4180 CSV for the analytics exports (#79): CRLF rows, every field that
 * holds a comma, quote or line break quoted, quotes doubled. A text cell
 * opening with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`, so a
 * spreadsheet shows a typed query as text instead of running it as a formula.
 * Numbers are left alone: `-3` is a value, not an injection.
 */
export function toCsv(columns: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return [columns, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
