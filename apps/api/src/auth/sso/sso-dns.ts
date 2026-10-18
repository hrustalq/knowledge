import { Resolver } from 'node:dns/promises';

/** Where a domain's proof lives: a TXT record under this label. */
export const CHALLENGE_LABEL = '_knowledge-challenge';

/** DI token for the TXT lookup, so a spec can answer for DNS. */
export const DNS_TXT_LOOKUP = Symbol('DNS_TXT_LOOKUP');

/** Resolves a name's TXT records, each one's chunks joined. Throws with the resolver's `code` on failure. */
export type TxtLookup = (name: string) => Promise<string[]>;

export type DnsProof = 'ok' | 'no-record' | 'mismatch' | 'lookup-failed';

/** The resolver the API uses: the host's, bounded so a dead nameserver cannot hold a request or a sweep. */
export function systemTxtLookup(): TxtLookup {
  const resolver = new Resolver({ timeout: 3_000, tries: 2 });
  return async (name) => (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
}

/**
 * Whether `_knowledge-challenge.<domain>` carries `token` (#75 phase 4).
 * "No such record" and "a record, but not ours" are told apart for the admin
 * reading the result; a resolver failure is neither, and is retried later.
 */
export async function proveDomain(lookup: TxtLookup, domain: string, token: string): Promise<DnsProof> {
  let records: string[];
  try {
    records = await lookup(`${CHALLENGE_LABEL}.${domain}`);
  } catch (e) {
    const code = (e as { code?: string }).code;
    return code === 'ENOTFOUND' || code === 'ENODATA' ? 'no-record' : 'lookup-failed';
  }
  if (!records.length) return 'no-record';
  return records.some((r) => r.trim() === token) ? 'ok' : 'mismatch';
}
