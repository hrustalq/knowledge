// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { nextTick, reactive, ref } from 'vue'
import * as Y from 'yjs'
import {
  META_FIELD,
  bindPageFields,
  followProvider,
  mapIndex,
  outcomeOf,
  setText,
  type CollabStatus,
  type ProviderLike,
} from './use-collab'

/** A provider that only records listeners, so a spec can play the server. */
function fakeProvider() {
  const handlers = new Map<string, ((payload: never) => void)[]>()
  const provider = {
    authorizedScope: undefined as ProviderLike['authorizedScope'],
    on(event: string, fn: (payload: never) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return provider
    },
    attach: vi.fn(),
    detach: vi.fn(),
  }
  const emit = (event: string, payload: unknown = {}) =>
    handlers.get(event)?.forEach((fn) => fn(payload as never))
  return { provider, emit }
}

function follow(schemaMismatch = false) {
  const { provider, emit } = fakeProvider()
  const status = reactive<CollabStatus>({ state: 'connecting', reason: null, writable: false, schemaMismatch, peers: [] })
  const hooks = { synced: vi.fn(), stopped: vi.fn() }
  followProvider(provider as unknown as ProviderLike, status, hooks)
  const join = (scope: 'read-write' | 'readonly') => {
    provider.authorizedScope = scope
    emit('authenticated', { scope })
    emit('synced', { state: true })
  }
  return { provider, emit, status, hooks, join }
}

const closeMessage = (reason: string) => ({ event: { code: 1000, reason } })

describe('outcomeOf', () => {
  it('rejoins on access-changed and stops on everything else', () => {
    expect(outcomeOf('access-changed')).toEqual({ rejoin: true })
    expect(outcomeOf('forbidden')).toEqual({ rejoin: false, reason: 'forbidden' })
    expect(outcomeOf('too-large')).toEqual({ rejoin: false, reason: 'too-large' })
    // The page rebuilds the draft from scratch: the handle itself must not rejoin with the old doc.
    expect(outcomeOf('reset')).toEqual({ rejoin: false, reason: 'reset' })
    // A ticket that could not be minted arrives as the provider's own prose.
    expect(outcomeOf('Failed to get token during sendToken(): 401')).toEqual({ rejoin: false, reason: 'unauthorized' })
  })
})

describe('followProvider', () => {
  it('goes live and writable once a writer has synced', () => {
    const { status, hooks, join } = follow()
    expect(status.state).toBe('connecting')
    join('read-write')
    expect(status).toMatchObject({ state: 'live', writable: true })
    expect(hooks.synced).toHaveBeenCalledOnce()
  })

  it('joins a viewer, or a build on another schema, read-only', () => {
    const viewer = follow()
    viewer.join('readonly')
    expect(viewer.status).toMatchObject({ state: 'live', writable: false })
    const stale = follow(true)
    stale.join('read-write')
    expect(stale.status).toMatchObject({ state: 'live', writable: false })
  })

  it('reads a dropped socket as offline, and live again after the resync', () => {
    const { emit, status, join } = follow()
    join('read-write')
    emit('status', { status: 'disconnected' })
    expect(status).toMatchObject({ state: 'offline', writable: true })
    emit('status', { status: 'connecting' })
    emit('close', { event: { code: 1006, reason: '' } })
    expect(status.state).toBe('offline')
    emit('synced', { state: true })
    expect(status.state).toBe('live')
  })

  it('rejoins with a fresh ticket on access-changed and learns the new scope', () => {
    const { provider, emit, status, join } = follow()
    join('read-write')
    emit('close', closeMessage('access-changed'))
    expect(provider.detach).toHaveBeenCalledOnce()
    expect(provider.attach).toHaveBeenCalledOnce()
    expect(status).toMatchObject({ state: 'connecting', writable: false })
    join('readonly')
    expect(status).toMatchObject({ state: 'live', writable: false, reason: null })
  })

  it('stops for good on a refusal, a close, or the flag going off', () => {
    for (const trigger of [
      (emit: ReturnType<typeof follow>['emit']) => emit('authenticationFailed', { reason: 'forbidden' }),
      (emit: ReturnType<typeof follow>['emit']) => emit('close', closeMessage('too-large')),
      (emit: ReturnType<typeof follow>['emit']) => emit('close', { event: { code: 4503, reason: 'collab disabled' } }),
    ]) {
      const { provider, emit, status, hooks, join } = follow()
      join('read-write')
      trigger(emit)
      expect(status.state).toBe('stopped')
      expect(status.writable).toBe(false)
      expect(provider.detach).toHaveBeenCalledOnce()
      expect(provider.attach).not.toHaveBeenCalled()
      expect(hooks.stopped).toHaveBeenCalledOnce()
      // Nothing after a stop brings it back: a later sync is ignored.
      emit('synced', { state: true })
      expect(status.state).toBe('stopped')
    }
    const off = follow()
    off.emit('close', { event: { code: 4503, reason: '' } })
    expect(off.status.reason).toBe('disabled')
  })
})

describe('setText', () => {
  it('writes only the changed span, so a peer’s edit elsewhere in the field survives', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    a.getText('t').insert(0, 'Billing overview')
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    setText(a.getText('t'), 'Billing service overview')
    setText(b.getText('t'), 'Billing overview (draft)')
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(a.getText('t').toString()).toBe('Billing service overview (draft)')
    expect(b.getText('t').toString()).toBe(a.getText('t').toString())
  })
})

describe('mapIndex', () => {
  it('moves a caret past text inserted before it and back over text deleted before it', () => {
    expect(mapIndex([{ retain: 2 }, { insert: 'abc' }], 5)).toBe(8)
    expect(mapIndex([{ retain: 7 }, { insert: 'abc' }], 5)).toBe(5)
    expect(mapIndex([{ delete: 3 }], 5)).toBe(2)
    expect(mapIndex([{ retain: 3 }, { delete: 5 }], 5)).toBe(3)
  })
})

describe('bindPageFields', () => {
  function tab(doc: Y.Doc, loaded: { title: string; category: string; relations: unknown[] }) {
    const title = ref(loaded.title)
    const category = ref(loaded.category)
    const relations = ref(loaded.relations)
    const unbind = bindPageFields(doc, { texts: { title }, values: { category, relations } })
    return { title, category, relations, unbind }
  }

  it('seeds what the draft lacks and adopts what it holds', () => {
    const doc = new Y.Doc()
    const first = tab(doc, { title: 'Head title', category: 'process', relations: [] })
    expect(doc.getMap(META_FIELD).toJSON()).toEqual({ title: 'Head title', category: 'process', relations: [] })
    first.unbind()
    // A later tab loaded an older head: the draft wins over what it loaded.
    const second = tab(doc, { title: 'Older title', category: 'other', relations: [] })
    expect(second.title.value).toBe('Head title')
    expect(second.category.value).toBe('process')
  })

  it('keeps typing shared after two tabs seed the same new draft at once', async () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    // Both join an empty draft before either seed has arrived at the other.
    const ta = tab(a, { title: 'Page', category: 'other', relations: [] })
    const tb = tab(b, { title: 'Page', category: 'other', relations: [] })
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u, 'remote'))
    b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u, 'remote'))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote')
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b), 'remote')

    // Whichever tab lost the seed, its typing must reach the other.
    for (const [writer, reader] of [[ta, tb], [tb, ta]] as const) {
      writer.title.value = `${writer.title.value}!`
      await nextTick()
      expect(reader.title.value).toBe(writer.title.value)
    }
    expect(a.getMap(META_FIELD).get('title')!.toString()).toBe('Page!!')
  })

  it('carries edits both ways between two peers', async () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u, 'remote'))
    b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u, 'remote'))
    const ta = tab(a, { title: 'Page', category: 'other', relations: [] })
    const tb = tab(b, { title: 'Page', category: 'other', relations: [] })

    ta.title.value = 'Page about billing'
    ta.relations.value = [{ type: 'DEPENDS_ON', key: 'service:billing', name: '' }]
    await nextTick()
    expect(tb.title.value).toBe('Page about billing')
    expect(tb.relations.value).toEqual([{ type: 'DEPENDS_ON', key: 'service:billing', name: '' }])

    tb.category.value = 'process'
    await nextTick()
    expect(ta.category.value).toBe('process')
  })
})
