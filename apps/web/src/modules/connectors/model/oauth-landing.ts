import { OAUTH_OUTCOMES, type OauthOutcome } from '@knowledge/contracts'

/** Providers whose callback lands on /oauth/:provider (#564), by display name. */
const PROVIDERS: Record<string, string> = { github: 'GitHub', figma: 'Figma' }

export interface OauthLanding {
  provider: 'github' | 'figma' | null
  /** The display name, for messages. */
  name: string
  outcome: OauthOutcome
  ok: boolean
  /** Where "Go back" leads: the signed return path, or the connectors list. */
  back: string
}

/**
 * Reads the landing's query. Anything unexpected reads as `error`, and a
 * return path is followed only when it is a same-origin path: the API signed
 * it, but the query is still text anyone can type.
 */
export function readOauthLanding(provider: unknown, outcome: unknown, returnTo: unknown): OauthLanding {
  const known = typeof provider === 'string' && provider in PROVIDERS ? (provider as 'github' | 'figma') : null
  const said = (OAUTH_OUTCOMES as readonly unknown[]).includes(outcome) ? (outcome as OauthOutcome) : 'error'
  const result = known ? said : 'error'
  const safe = typeof returnTo === 'string' && /^\/(?![/\\])/.test(returnTo)
  return {
    provider: known,
    name: known ? PROVIDERS[known] : '',
    outcome: result,
    ok: result === 'connected' || result === 'installed',
    back: safe ? returnTo : '/settings/connectors',
  }
}
