import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { createMarkdownSync, fromEditorEvent, shallowEqual } from './editor-streams'

/** Just enough of a Tiptap editor for the streams: an emitter and a flag. */
function fakeEditor() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const editor = {
    isDestroyed: false,
    doc: '',
    on(event: string, fn: (payload: unknown) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(fn)
    },
    off(event: string, fn: (payload: unknown) => void) {
      listeners.get(event)?.delete(fn)
    },
    emit(event: string, payload: unknown = {}) {
      for (const fn of listeners.get(event) ?? []) fn(payload)
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0
    },
  }
  return editor
}

type Fake = ReturnType<typeof fakeEditor>
const asEditor = (fake: Fake) => fake as unknown as Editor

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function syncFor(fake: Fake) {
  const serialize = vi.fn(() => fake.doc)
  const sync = createMarkdownSync(asEditor(fake), { dueTime: 200, serialize })
  const emitted: string[] = []
  sync.markdown$.subscribe((markdown) => emitted.push(markdown))
  return { sync, serialize, emitted }
}

function type(fake: Fake, text: string) {
  fake.doc = text
  fake.emit('update')
}

describe('createMarkdownSync', () => {
  it('serializes once per pause in typing, not once per edit', () => {
    const fake = fakeEditor()
    const { serialize, emitted } = syncFor(fake)
    type(fake, 'a')
    vi.advanceTimersByTime(100)
    type(fake, 'ab')
    vi.advanceTimersByTime(100)
    type(fake, 'abc')
    expect(serialize).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(serialize).toHaveBeenCalledTimes(1)
    expect(emitted).toEqual(['abc'])
  })

  it('cancel() reaches an emission already scheduled, so a flush is not followed by a stale one', () => {
    const fake = fakeEditor()
    const { sync, serialize, emitted } = syncFor(fake)
    type(fake, 'draft')
    vi.advanceTimersByTime(50)
    sync.cancel()
    vi.advanceTimersByTime(500)
    expect(serialize).not.toHaveBeenCalled()
    expect(emitted).toEqual([])
    // The next edit starts a fresh pause.
    type(fake, 'draft 2')
    vi.advanceTimersByTime(200)
    expect(emitted).toEqual(['draft 2'])
  })

  it('never serializes a destroyed editor', () => {
    const fake = fakeEditor()
    const { serialize } = syncFor(fake)
    type(fake, 'x')
    fake.isDestroyed = true
    vi.advanceTimersByTime(200)
    expect(serialize).not.toHaveBeenCalled()
  })

  it('removes its listener on dispose', () => {
    const fake = fakeEditor()
    const { sync } = syncFor(fake)
    expect(fake.listenerCount('update')).toBe(1)
    sync.dispose()
    expect(fake.listenerCount('update')).toBe(0)
  })
})

describe('fromEditorEvent', () => {
  it('attaches on subscribe and detaches on unsubscribe', () => {
    const fake = fakeEditor()
    const seen: unknown[] = []
    const subscription = fromEditorEvent(asEditor(fake), 'focus').subscribe((e) => seen.push(e))
    fake.emit('focus', { n: 1 })
    subscription.unsubscribe()
    fake.emit('focus', { n: 2 })
    expect(seen).toEqual([{ n: 1 }])
    expect(fake.listenerCount('focus')).toBe(0)
  })
})

describe('shallowEqual', () => {
  it('compares flat snapshots by value', () => {
    expect(shallowEqual({ a: 1, b: true }, { a: 1, b: true })).toBe(true)
    expect(shallowEqual({ a: 1, b: true }, { a: 1, b: false })).toBe(false)
    expect(shallowEqual(null, { a: 1 })).toBe(false)
    expect(shallowEqual(null, null)).toBe(true)
  })
})
