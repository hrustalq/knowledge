/**
 * A whole number from `min` to `max`, or `fallback` when `value` is not a
 * finite number (#1109): a page size or depth from a query string, before it
 * reaches a query. `Number('abc')` is NaN, and Prisma's `take: NaN` is a 500.
 */
export function clampInt(value: number | string | null | undefined, min: number, max: number, fallback: number): number {
  const n = typeof value === 'string' ? (value.trim() ? Number(value) : Number.NaN) : (value ?? Number.NaN);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : fallback;
}
