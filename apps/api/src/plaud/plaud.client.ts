import { safeFetch } from '../common/safe-fetch.js';

/**
 * Plaud's hosted MCP server (#864): the only documented way to a person's own
 * recordings. Fixed in code, so it is the operator's URL and never a user's.
 * It is stateless — a tool call needs no `initialize` — and answers one
 * JSON-RPC message as a server-sent event.
 */
export const PLAUD_ORIGIN = 'https://mcp.plaud.ai';
export const PLAUD_MCP_URL = `${PLAUD_ORIGIN}/mcp`;

const TIMEOUT_MS = 60_000;

export class PlaudError extends Error {
  constructor(
    message: string,
    /** Plaud refused the token: the caller refreshes once, then treats the sign-in as lapsed. */
    readonly unauthorized = false,
  ) {
    super(message);
  }
}

/**
 * A tool's text answer is JSON. Recording data comes inside
 * `<untrusted-user-data-<random> …>` … `</untrusted-user-data-<random>>`, after
 * a sentence telling a model to treat it as data; the account answer comes
 * bare. Only the tag the answer itself opened closes the block, so text inside
 * a recording cannot end it early. Anything that is not JSON, in or out of an
 * envelope, throws: a changed shape must fail an import, never half-parse.
 */
export function parsePlaudAnswer(text: string): unknown {
  // The sentence in front names the tag too, so the block is the tag that opens a line.
  const name = /<(untrusted-user-data-[0-9a-f]+)/.exec(text)?.[1];
  const open = name ? new RegExp(`^<${name}[^>]*>\\n?`, 'm').exec(text) : null;
  const end = open ? text.lastIndexOf(`</${name}>`) : -1;
  if (name && (!open || end < open.index)) throw new PlaudError('Plaud answered in a shape this version does not read');
  try {
    return JSON.parse(open ? text.slice(open.index + open[0].length, end) : text);
  } catch {
    throw new PlaudError('Plaud answered in a shape this version does not read');
  }
}

/** Calls one read-only Plaud tool as the person whose `accessToken` this is. */
export async function plaudTool<T>(accessToken: string, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await safeFetch(PLAUD_MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      // Plaud answers 406 unless both are accepted.
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new PlaudError('Plaud refused the sign-in', true);
  if (!res.ok) throw new PlaudError(`Plaud answered ${res.status}`);

  const raw = await res.text();
  // One `data:` line per message in an event stream; a plain JSON body otherwise.
  const line = raw
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('data:'));
  let message: { result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> }; error?: { message?: string } };
  try {
    message = JSON.parse(line ? line.slice(5) : raw);
  } catch {
    throw new PlaudError('Plaud answered in a shape this version does not read');
  }
  const text = message.result?.content?.find((c) => c.type === 'text')?.text;
  if (message.error || message.result?.isError || typeof text !== 'string') {
    // The tool's own error text is Plaud's, and may quote a recording: never surfaced.
    throw new PlaudError(`Plaud tool ${name} failed`);
  }
  return parsePlaudAnswer(text) as T;
}
