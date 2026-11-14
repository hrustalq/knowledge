import { wrapUntrusted, type UntrustedOrigin } from './untrusted.js';

/**
 * Facts plain, page text wrapped (#1102, #1136): the one shape a tool result
 * takes when it carries text the reader must never obey.
 *
 * The first line is plain JSON a client can parse and a model can act on: ids,
 * cite labels, trust status, counts, dates. Everything the page's authors
 * wrote — titles, trails, headings, snippets, markdown, diffs, comments — goes
 * after it, inside one `wrapUntrusted` block, so a page that contains the
 * block's closing tag reads the same and ends nothing.
 *
 * One wrapper per result, never one per hit or field: the preamble is a fixed
 * cost of about 80 tokens, and the split replaces the pretty-printed JSON the
 * result used to be, which usually costs more than that in indentation.
 */
export function withPageText(facts: unknown, text: unknown, tool: string, origin: UntrustedOrigin = 'document'): string {
  return `${JSON.stringify(facts)}\n${wrapUntrusted(JSON.stringify(text), tool, origin)}`;
}

/**
 * A key whose short, token-shaped string value is a fact we wrote: an id, a
 * date, an enum, a label. Anything else a page could have said — titles,
 * names, paths, messages, URLs a page chose — is text. An allowlist, so a field
 * added later is wrapped until someone decides otherwise.
 */
const FACT_KEY = /^(?:id|cite|label|traceId|status|state|kind|layer|level|factClass|format|role|mode|strategy|direction|scope|asOf|resolvedAsOf|nextCursor|branchType|outcome|reason|severity|rule|source|type|operation|method|contentType)$|(?:Id|Ids|At|AsOf|Status|Kind)$/;
/** What such a value may look like: no spaces, so no sentence; no `<`, so no tag. */
const FACT_VALUE = /^[\w:.+\-/@#]{0,80}$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const EMPTY = Symbol('empty');

/**
 * `value` split into what is a fact and what is text, each a tree of the same
 * shape: an object keeps a key on the side that holds something under it, an
 * array keeps its positions (a hit's text sits at the hit's index, `null`
 * where it has none). Numbers, booleans and null are facts wherever they are;
 * a string is a fact only under a {@link FACT_KEY} and shaped like one. Walks
 * the value once, before it is serialised: nothing is parsed back.
 */
export function splitPageText(value: unknown): { facts: unknown; text: unknown } {
  type Part = { facts: Json | typeof EMPTY; text: Json | typeof EMPTY };
  const walk = (raw: unknown, key: string | null): Part => {
    // JSON's own view of a value: a Date (anything with toJSON) as what it serialises to; undefined, functions and symbols gone.
    const v = (raw !== null && typeof raw === 'object' && typeof (raw as { toJSON?: unknown }).toJSON === 'function' ? (raw as { toJSON(): unknown }).toJSON() : raw) as Json | undefined;
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return { facts: EMPTY, text: EMPTY };
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return { facts: Number.isFinite(v as number) || typeof v !== 'number' ? v : null, text: EMPTY };
    if (typeof v === 'string') {
      return key !== null && FACT_KEY.test(key) && FACT_VALUE.test(v) ? { facts: v, text: EMPTY } : { facts: EMPTY, text: v };
    }
    // An empty list or object says something too ("no peers"): a fact, so it reads back.
    if (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0) return { facts: v, text: EMPTY };
    if (Array.isArray(v)) {
      const parts = v.map((x): Part => {
        const p = walk(x, key);
        // An array slot JSON would write as null.
        return p.facts === EMPTY && p.text === EMPTY ? { facts: null, text: EMPTY } : p;
      });
      const side = (pick: (p: (typeof parts)[number]) => Json | typeof EMPTY): Json[] | typeof EMPTY =>
        parts.some((p) => pick(p) !== EMPTY) ? parts.map((p) => { const x = pick(p); return x === EMPTY ? null : x; }) : EMPTY;
      const facts = side((p) => p.facts);
      const text = side((p) => p.text);
      return { facts, text };
    }
    const facts: Record<string, Json> = {};
    const text: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) {
      const part = walk(x, k);
      if (part.facts !== EMPTY) facts[k] = part.facts;
      if (part.text !== EMPTY) text[k] = part.text;
    }
    return { facts: Object.keys(facts).length ? facts : EMPTY, text: Object.keys(text).length ? text : EMPTY };
  };
  const { facts, text } = walk(value ?? null, null);
  return { facts: facts === EMPTY ? {} : facts, text: text === EMPTY ? null : text };
}

/** A tool result's text: the facts line, then the page text wrapped — or the facts alone when the result carries no text. */
export function pageText(value: unknown, tool: string, origin: UntrustedOrigin = 'document'): string {
  const { facts, text } = splitPageText(value);
  return text === null ? JSON.stringify(facts) : withPageText(facts, text, tool, origin);
}

/**
 * The value back from {@link pageText}'s text, for a client that wants one
 * object (and for specs): the facts line merged with the wrapped text, the
 * defused closing tags restored. A result that is plain JSON parses as is.
 */
export function readPageText(text: string): unknown {
  const nl = text.indexOf('\n<');
  if (nl < 0) return JSON.parse(text);
  const facts = JSON.parse(text.slice(0, nl)) as Json;
  const lines = text.slice(nl + 1).split('\n');
  const payload = lines.slice(2, -1).join('\n').replace(/&lt;(\s*\/)/g, '<$1');
  return merge(facts, JSON.parse(payload) as Json);
}

function merge(a: Json, b: Json): Json {
  if (b === null) return a;
  if (a === null) return b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length >= b.length ? a.map((x, i) => merge(x, b[i] ?? null)) : b.map((x, i) => merge(a[i] ?? null, x));
  if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, Json> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k]!, v) : v;
    return out;
  }
  return b;
}
