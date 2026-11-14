import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStorage } from '@/shared/utils/memory-storage.testing'
import { createSetupActor, loadSetup, saveSetup, type SetupServices } from './setup-machines'

// #1101: the wizard persists its snapshot so a reload resumes, but a pasted
// token and a webhook secret are credentials, and credentials live only in the
// API's secret box. The stored snapshot holds neither, and a resumed wizard
// lands back on the question that asks for the token.

const services: SetupServices = {
  test: async () => ({ ok: true, detail: null }),
  save: async () => 'c1',
}

const TOKEN = 'ATATT3xFfGF0-secret-token'
const HOOK = 'whsec-very-secret'

function confluenceAt(step: 'space' | 'options') {
  const actor = createSetupActor('confluence', { kind: 'confluence' }, services)
  actor.start()
  actor.send({ type: 'SET', patch: { name: 'Wiki', credential: TOKEN, webhookSecret: HOOK } })
  actor.send({ type: 'NEXT' }) // naming → configuring (site)
  actor.send({ type: 'SET_FIELD', key: 'baseUrl', value: 'https://acme.atlassian.net' })
  actor.send({ type: 'NEXT' }) // site → space
  if (step === 'options') {
    actor.send({ type: 'NEXT' }) // space → testing → passed → destination
    actor.send({ type: 'SET', patch: { projectId: 'p1' } })
  }
  return actor
}

/** The invoked per-kind machine; typed by the wrapper as one of its promise actors. */
type KindChildren = { kind: { getSnapshot(): { value: unknown } } }

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => vi.stubGlobal('localStorage', new MemoryStorage()))
afterEach(() => vi.unstubAllGlobals())

describe('the persisted connector setup', () => {
  it('holds neither the credential nor the webhook secret', async () => {
    const actor = confluenceAt('options')
    await settle()
    actor.send({ type: 'NEXT' }) // destination → options
    saveSetup(actor.getPersistedSnapshot())
    const raw = localStorage.getItem('kn_connector_setup')!
    expect(raw).toBeTruthy()
    expect(raw).not.toContain(TOKEN)
    expect(raw).not.toContain(HOOK)
  })

  it('keeps what is not secret: the name and the config', () => {
    saveSetup(confluenceAt('space').getPersistedSnapshot())
    const raw = localStorage.getItem('kn_connector_setup')!
    expect(raw).toContain('Wiki')
    expect(raw).toContain('https://acme.atlassian.net')
  })

  it('resumes on the question that asks for the token, past the test or not', async () => {
    for (const step of ['space', 'options'] as const) {
      const actor = confluenceAt(step)
      await settle()
      saveSetup(actor.getPersistedSnapshot())
      const resumed = createSetupActor('confluence', { kind: 'confluence' }, services, loadSetup('confluence'))
      resumed.start()
      const snap = resumed.getSnapshot()
      expect(snap.value).toBe('configuring')
      expect(snap.context.credential).toBe('')
      const child = (snap.children as unknown as KindChildren).kind
      expect(child.getSnapshot().value).toBe('site')
      resumed.stop()
    }
  })

  it('leaves a snapshot with no credential typed where it was', () => {
    const actor = createSetupActor('confluence', { kind: 'confluence' }, services)
    actor.start()
    actor.send({ type: 'SET', patch: { name: 'Wiki' } })
    actor.send({ type: 'NEXT' })
    actor.send({ type: 'NEXT' }) // site → space, nothing pasted
    saveSetup(actor.getPersistedSnapshot())
    const resumed = createSetupActor('confluence', { kind: 'confluence' }, services, loadSetup('confluence'))
    resumed.start()
    const child = (resumed.getSnapshot().children as unknown as KindChildren).kind
    expect(child.getSnapshot().value).toBe('space')
  })
})
