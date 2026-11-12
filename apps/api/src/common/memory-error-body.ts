/**
 * The error shape a Hindsight client parses (#986): FastAPI's `{"detail": …}`.
 * Here rather than in memory/ for the reason `scim-error-body.ts` is: the
 * filter renders it for every failure on a memory path — an unmatched route or
 * a body-parser error never reaches a memory class.
 */

/** The Hindsight wire: bank routes, the per-bank MCP endpoint, and the two probes a client sends first. */
const MEMORY_PATH_PREFIXES = ['/v1/default/', '/mcp/'];
const MEMORY_PATHS = new Set(['/version', '/health']);

export function isMemoryPath(url: string): boolean {
  const path = url.split('?', 1)[0];
  return MEMORY_PATHS.has(path) || MEMORY_PATH_PREFIXES.some((p) => path.startsWith(p));
}

/**
 * A failed validation leaves as FastAPI's 422 with one entry per violation;
 * everything else keeps its status and carries the message as a string.
 */
export function memoryErrorBody(status: number, message: string, validationErrors?: unknown): { status: number; body: { detail: unknown } } {
  if (Array.isArray(validationErrors)) {
    return { status: 422, body: { detail: validationErrors.map((msg) => ({ loc: ['body'], msg: String(msg), type: 'value_error' })) } };
  }
  return { status, body: { detail: message } };
}
