import { PROVIDER_DEFAULTS } from '@knowledge/contracts';
import { safeFetch } from '../common/safe-fetch.js';
import { assertSafeExternalUrl, type SafeUrlMessageKeys } from '../common/safe-url.js';

/**
 * A model credential belongs to the endpoint it was given for
 * (GHSA-7hf4-5chc-29gr). The rules live here so the resolver, both save paths
 * and the dialers read one spelling of them.
 */

/** The URL a provider config dials: its own base URL, else the provider's default. No trailing slash. */
export function endpointOf(provider: string | null | undefined, baseUrl: string | null | undefined): string {
  return (baseUrl || (provider ? PROVIDER_DEFAULTS[provider]?.baseUrl : '') || '').replace(/\/$/, '');
}

/**
 * Whether a save points a stored row somewhere new, so the key stored for the
 * old place must go unless the same request sends one. Compared column by
 * column: a provider change moves the default endpoint, a base URL change
 * moves it outright.
 */
export function movesEndpoint(
  current: { provider: string | null; baseUrl: string | null } | null,
  input: { provider?: string | null; baseUrl?: string | null },
): boolean {
  if (!current) return false;
  const baseMoves = input.baseUrl !== undefined && (input.baseUrl || null) !== (current.baseUrl || null);
  const providerMoves = input.provider !== undefined && (input.provider ?? null) !== (current.provider ?? null);
  return baseMoves || providerMoves;
}

const BASE_URL_KEYS: SafeUrlMessageKeys = {
  invalid: 'error.ai.baseUrlInvalid',
  notHttps: 'error.ai.baseUrlNotHttps',
  unresolved: 'error.ai.baseUrlUnresolved',
  private: 'error.ai.baseUrlPrivate',
};

/** The settings-form check on a workspace base URL. Empty means the provider's default and passes. */
export async function assertSafeBaseUrl(baseUrl: string | null | undefined, allowPrivate: boolean): Promise<void> {
  if (!baseUrl) return;
  await assertSafeExternalUrl(baseUrl, allowPrivate, BASE_URL_KEYS);
}

/**
 * The `fetch` every model dialer hands its client: `safeFetch`, so a workspace
 * base URL cannot reach a private address at request time either, whatever
 * DNS answered when it was saved. `privateOk` is `ResolvedAiConfig.privateOk`.
 */
export function providerFetch(privateOk: boolean): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return (input, init) => safeFetch(input instanceof Request ? input.url : input, init ?? {}, privateOk);
}
