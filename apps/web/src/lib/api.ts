/** Demo workspace until auth lands (Phase 5). */
export const DEMO_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'

const base = import.meta.env.SSR
  ? (process.env.API_URL_INTERNAL ?? 'http://localhost:3000')
  : (import.meta.env.VITE_API_URL ?? '/api')

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  })
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}

export function statusVariant(status: string | null): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'indexed': return 'default'
    case 'failed': return 'destructive'
    case 'indexing': case 'finalized': return 'secondary'
    default: return 'outline'
  }
}
