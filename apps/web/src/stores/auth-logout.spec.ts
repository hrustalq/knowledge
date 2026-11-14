import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, markRaw } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { QueryClient } from '@tanstack/vue-query'
import { MemoryStorage } from '@/shared/utils/memory-storage.testing'

// #1101: what one person left in this browser — a half-finished connector
// setup, unpublished page edits — is not the next person's to find.
const post = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('@/shared/api/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/queries')>()),
  api: { post },
}))
vi.mock('@/shared/utils/pwa', () => ({ clearPwaCaches: async () => undefined }))

const { useAuthStore } = await import('./auth')

let storage: MemoryStorage
let session: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  session = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('sessionStorage', session)
  const pinia = createPinia()
  pinia.use(() => ({ queryClient: markRaw(new QueryClient()) }))
  createApp({}).use(pinia)
  setActivePinia(pinia)
})
afterEach(() => vi.unstubAllGlobals())

describe('auth.logout', () => {
  it('forgets the connector setup and every working copy, and keeps preferences', async () => {
    storage.setItem('kn_connector_setup', '{"status":"active"}')
    storage.setItem('kn:unstaged:v1:ws1:doc1', '{}')
    storage.setItem('kn:unstaged:v1:ws1:new', '{}')
    storage.setItem('kn:unstaged:v1:ws2:doc2@feature', '{}')
    storage.setItem('kn_theme', 'dark')
    storage.setItem('kn_lang', 'ru')

    await useAuthStore().logout()

    expect(post).toHaveBeenCalledWith('/v1/auth/logout')
    expect(storage.getItem('kn_connector_setup')).toBeNull()
    for (let i = 0; i < storage.length; i++) expect(storage.key(i)).not.toMatch(/^kn:unstaged:/)
    expect(storage.getItem('kn_theme')).toBe('dark')
    expect(storage.getItem('kn_lang')).toBe('ru')
  })

  // #1142: try-it keeps a third-party API's token and password per spec page in
  // sessionStorage, and the project / workflow wizards keep drafts.
  it('forgets try-it credentials and the wizard drafts', async () => {
    session.setItem('kn_try:doc1', '{"token":"secret","basicPassword":"pw"}')
    session.setItem('kn_try:doc2', '{"apiKey":"k"}')
    session.setItem('kn_other', 'kept')
    storage.setItem('kn_project_wizard', '{"value":"draft"}')
    storage.setItem('kn_wf_wizard', '{"value":"draft"}')

    await useAuthStore().logout()

    expect(session.getItem('kn_try:doc1')).toBeNull()
    expect(session.getItem('kn_try:doc2')).toBeNull()
    expect(session.getItem('kn_other')).toBe('kept')
    expect(storage.getItem('kn_project_wizard')).toBeNull()
    expect(storage.getItem('kn_wf_wizard')).toBeNull()
  })

  it('still forgets them when the session was already dead', async () => {
    post.mockRejectedValueOnce(new Error('401'))
    storage.setItem('kn_connector_setup', '{}')
    await useAuthStore().logout()
    expect(storage.getItem('kn_connector_setup')).toBeNull()
  })
})
