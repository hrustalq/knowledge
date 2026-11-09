/**
 * The JSON object in a model reply, or null. Models told to answer in JSON
 * still wrap it in a ```json fence or a sentence of prose, so this tries, in
 * order: the whole reply minus an outer fence, the first fenced block, and the
 * span from the first `{` to the last `}`. Anything that is not an object
 * (a string, a number, `null`) reads as no answer.
 */
export function parseModelJson<T = Record<string, unknown>>(raw: string): T | null {
  const text = raw.trim();
  const candidates = [text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) candidates.push(fenced[1]!);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object') return value as T;
    } catch {
      /* next candidate */
    }
  }
  return null;
}
