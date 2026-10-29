import { reactive, watch } from 'vue'

/** One operation's console values — what the code samples print and the console sends. */
export interface TryDraft {
  path: Record<string, string>
  query: Record<string, string>
  headers: Record<string, string>
  body: string | null
  contentType: string | null
}

/** How a request leaves: from this browser, or through the workspace's proxy. */
export type TryVia = 'browser' | 'proxy'

/**
 * The try-it values one spec shares across its operations (#78): the server,
 * the route, and the credentials. Typed once, used by every card — a token
 * belongs to the API, not to one endpoint.
 *
 * Kept in `sessionStorage` and nowhere else: never sent to our API except
 * inside a proxied request, never in a sample, gone when the tab closes.
 */
export interface TryEnv {
  serverUrl: string | null
  via: TryVia
  token: string
  apiKey: string
  basicUser: string
  basicPassword: string
}

const KEY = (documentId: string) => `kn_try:${documentId}`
const envs = new Map<string, TryEnv>()

function blank(): TryEnv {
  return { serverUrl: null, via: 'browser', token: '', apiKey: '', basicUser: '', basicPassword: '' }
}

function load(documentId: string): TryEnv {
  try {
    const raw = sessionStorage.getItem(KEY(documentId))
    return raw ? { ...blank(), ...(JSON.parse(raw) as Partial<TryEnv>) } : blank()
  } catch {
    return blank()
  }
}

export function useTryEnv(documentId: string): TryEnv {
  // A module-level map on the server would be shared by every SSR request,
  // so the server gets a throwaway: the console only ever runs client-side.
  if (import.meta.env.SSR) return reactive(blank())
  let env = envs.get(documentId)
  if (!env) {
    env = reactive(load(documentId))
    envs.set(documentId, env)
    watch(
      env,
      (value) => {
        try {
          sessionStorage.setItem(KEY(documentId), JSON.stringify(value))
        } catch {
          // Storage refused (private mode, quota): the values live for this page only.
        }
      },
      { deep: true },
    )
  }
  return env
}

/** Every credential the env holds forgotten, here and in storage. */
export function forgetCredentials(env: TryEnv): void {
  env.token = ''
  env.apiKey = ''
  env.basicUser = ''
  env.basicPassword = ''
}

/** The placeholder slots `@knowledge/contracts` samples name, filled from the env. */
export function credentialSlots(env: TryEnv): Record<string, string> {
  const basic = env.basicUser || env.basicPassword ? base64(`${env.basicUser}:${env.basicPassword}`) : ''
  return { TOKEN: env.token, API_KEY: env.apiKey, BASIC_CREDENTIALS: basic }
}

function base64(s: string): string {
  let bin = ''
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte)
  return btoa(bin)
}
