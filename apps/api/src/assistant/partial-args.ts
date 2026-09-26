/**
 * Reading a tool call's arguments while the model is still writing them.
 *
 * A streamed tool call arrives as JSON fragments — `{"op":"repl`, `ace","anc`,
 * … — and `JSON.parse` has nothing to say until the last brace lands. For
 * `edit_draft` that would mean the author watches a spinner and then the whole
 * paragraph appears at once, which is exactly what streaming was meant to
 * avoid (docs/features/34).
 *
 * So this scans the top level of an object and reports every string value it
 * has seen so far, with whether its closing quote has arrived. Deliberately
 * narrow: top-level string values only, which is all `edit_draft` has. A
 * non-string value is skipped, not interpreted. Escapes are decoded as far as
 * they are complete — a value cut off mid-`\u00` holds the text before it.
 */
export interface PartialValue {
  value: string;
  /** The closing quote arrived: this value will not change again. */
  complete: boolean;
}

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** Reads one JSON string starting just after its opening quote. */
function readString(raw: string, from: number): { value: string; end: number; complete: boolean } {
  let value = '';
  let i = from;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '"') return { value, end: i + 1, complete: true };
    if (ch !== '\\') {
      value += ch;
      i += 1;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next === 'u') {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      i += 6;
      continue;
    }
    value += ESCAPES[next] ?? next;
    i += 2;
  }
  return { value, end: raw.length, complete: false };
}

export function scanPartialObject(raw: string): Record<string, PartialValue> {
  const out: Record<string, PartialValue> = {};
  let i = raw.indexOf('{');
  if (i < 0) return out;
  i += 1;
  while (i < raw.length) {
    // Key.
    while (i < raw.length && raw[i] !== '"' && raw[i] !== '}') i += 1;
    if (i >= raw.length || raw[i] === '}') return out;
    const key = readString(raw, i + 1);
    if (!key.complete) return out;
    i = key.end;
    while (i < raw.length && raw[i] !== ':') i += 1;
    i += 1;
    while (i < raw.length && /\s/.test(raw[i]!)) i += 1;
    if (i >= raw.length) return out;
    if (raw[i] === '"') {
      const val = readString(raw, i + 1);
      out[key.value] = { value: val.value, complete: val.complete };
      if (!val.complete) return out;
      i = val.end;
    } else {
      // Not a string: skip to the next top-level separator. Nested values are
      // not part of any schema this reads, so depth is tracked only to find it.
      let depth = 0;
      let inString = false;
      for (; i < raw.length; i += 1) {
        const ch = raw[i];
        if (inString) {
          if (ch === '\\') i += 1;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{' || ch === '[') depth += 1;
        else if (ch === '}' || ch === ']') {
          if (depth === 0) return out;
          depth -= 1;
        } else if (ch === ',' && depth === 0) break;
      }
    }
  }
  return out;
}
