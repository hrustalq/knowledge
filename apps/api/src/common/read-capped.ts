/**
 * A response body read up to `maxBytes`, the rest cancelled unread (#1109).
 *
 * `Response.text()` / `arrayBuffer()` read the whole body before any size rule
 * can apply, and a host can send a body with no length, or lie about one. This
 * reads chunk by chunk and stops once it holds more than the ceiling: memory is
 * bounded by `maxBytes` plus one chunk. `whole` is false when the body held
 * more; the bytes are then its first `maxBytes`, for a caller that truncates,
 * while a caller that cannot use a partial body refuses it.
 *
 * Lifted from the web research tool, which truncated, so its fetches and the
 * connector fetches share one reader.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; whole: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), whole: true };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  try {
    while (total <= maxBytes) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  // Bytes, not text: a PDF or a PNG has to reach its reader unmangled.
  const bytes = new Uint8Array(Math.min(total, maxBytes));
  let at = 0;
  for (const chunk of chunks) {
    if (at >= bytes.length) break;
    const part = chunk.subarray(0, bytes.length - at);
    bytes.set(part, at);
    at += part.length;
  }
  return { bytes, whole: done && total <= maxBytes };
}
