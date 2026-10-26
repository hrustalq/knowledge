/**
 * One shared draft, as the editor holds it (#80, docs/features/56): a Y.Doc,
 * the Hocuspocus provider that syncs it over `/v1/collab`, and an IndexedDB
 * copy so edits made offline survive a reload.
 *
 * Client only, and loaded on demand: `EditorPage` imports this module once
 * the deployment says it co-edits, so the server render and a deployment with
 * COLLAB_ENABLED off never load Yjs at all.
 *
 * Every per-document outcome arrives as a reason (`COLLAB_DENY_REASONS`),
 * never a close code, and the provider never rejoins after one by itself:
 * `outcomeOf` decides whether this tab rejoins with a fresh ticket or stops.
 */
import { nextTick, shallowReactive, watch, type Ref } from 'vue'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { IndexeddbPersistence } from 'y-indexeddb'
import type { AnyExtension } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import {
  COLLAB_DENY_REASONS,
  COLLAB_DISABLED_CLOSE_CODE,
  collabToken,
  type CollabDenyReason,
  type CollabJoined,
  type CollabUser,
} from '@knowledge/contracts'
import { BODY_FIELD } from '@knowledge/editor-schema'
import { META_FIELD, seedPageMeta } from '@knowledge/editor-schema/page-fields'
import { getToken } from '@/lib/api'
import { api } from '@/api/queries'
import { avatarColor, avatarColorDeep } from '@/lib/avatar'
import { wsBase } from '@/api/live'
import { SUGGESTIONS_FIELD } from '@knowledge/editor-schema/suggestions'
import {
  readSuggestionEntries,
  removeSuggestionEntries,
  writeSuggestionEntry,
} from '@knowledge/editor-schema/suggestion-entries'
import type { SuggestionStore } from './extensions/ai-suggestions'

/** Beside this device's copy, outside the Y.Doc: which seeding of the draft it came from (`collabToken`). */
const GENERATION_KEY = 'generation'


/** Where this tab stands with the draft. */
export type CollabState =
  /** Joining; nothing from the server yet. */
  | 'connecting'
  /** In sync with everyone else. */
  | 'live'
  /** The socket is down. Edits keep landing in this device's copy and sync on reconnect. */
  | 'offline'
  /** Refused or closed for good; `reason` says why. The draft is read-only from here. */
  | 'stopped'

/** Why a draft stopped: a server reason, or the deployment switching co-editing off. */
export type CollabStopReason = Exclude<CollabDenyReason, 'access-changed'> | 'disabled'

/** Someone else in the draft. The identity is the server's word (`CollabUser`), never the peer's. */
export interface CollabPeer extends CollabUser {
  clientId: number
}

export interface CollabStatus {
  state: CollabState
  reason: CollabStopReason | null
  /** Joined, the server granted write, and the schemas match. */
  writable: boolean
  /** This build's editor schema is not the server's: joined read-only, reload to write. */
  schemaMismatch: boolean
  /** One entry per person, however many tabs they have open. */
  peers: CollabPeer[]
}

export interface CollabHandle {
  doc: Y.Doc
  provider: HocuspocusProvider
  /** Reactive; read it in templates. */
  status: CollabStatus
  /** The first time the server's copy arrived. Never settles if it never does. */
  synced: Promise<void>
  /**
   * The draft is here to show: from the server, or from this device's copy
   * when offline. `false` when the draft stopped before either arrived.
   */
  ready: Promise<boolean>
  /** The editor's half: the body binding and the carets. Built once, at mount. */
  extensions(): AnyExtension[]
  /** The assistant's suggestions, shared with every peer (`AiSuggestions`' `shared`). */
  suggestions: SuggestionStore
  /**
   * The moment a publish reads the draft: clears the revision message for
   * everyone (it belongs to the revision, not the page) and returns the
   * base64 Y snapshot the content is read at. Synchronous, so nothing lands
   * between the snapshot and the serialization that follows it.
   */
  seal(): string
  destroy(): void
  /** Destroy, and drop this device's copy too: after a reset it would merge the old draft back in. */
  forget(): Promise<void>
}

/** What a reason asks of this tab: rejoin with a fresh ticket to learn the new scope, or stop. */
export function outcomeOf(reason: string): { rejoin: true } | { rejoin: false; reason: CollabStopReason } {
  // `reset` stops this handle too: rejoining needs a new Y.Doc, which only the page can build.
  if (reason === 'access-changed') return { rejoin: true }
  // Anything else — including a ticket that could not be minted — means this
  // tab cannot vouch for itself any more.
  const known = (COLLAB_DENY_REASONS as readonly string[]).includes(reason)
  return { rejoin: false, reason: known ? (reason as CollabStopReason) : 'unauthorized' }
}

/** A single-use `kt_` ticket per (re)join; nothing longer-lived goes over the socket. */
async function ticket(): Promise<string> {
  // AUTH_MODE=none: the server admits anyone, and minting would be a wasted request.
  if (!getToken()) return ''
  return (await api.post('/v1/auth/url-ticket')).ticket
}

export function createCollab(options: {
  name: string
  schemaMatches: boolean
  /** Who this tab asks the assistant for — credited on its suggestions. */
  me?: { userId: string; name: string } | null
}): CollabHandle {
  const doc = new Y.Doc()
  const local = new IndexeddbPersistence(options.name, doc)
  const status = shallowReactive<CollabStatus>({
    state: 'connecting',
    reason: null,
    writable: false,
    schemaMismatch: !options.schemaMatches,
    peers: [],
  })

  let markSynced!: () => void
  const synced = new Promise<void>((resolve) => (markSynced = resolve))
  let settle!: (ok: boolean) => void
  const ready = new Promise<boolean>((resolve) => (settle = resolve))
  void synced.then(() => settle(true))
  // This device's copy is enough to show, but only if it holds a draft.
  void local.whenSynced.then(() => {
    if (doc.getXmlFragment(BODY_FIELD).length > 0) settle(true)
  })

  const provider = new HocuspocusProvider({
    url: `${wsBase()}/v1/collab`,
    name: options.name,
    document: doc,
    // The copy's generation goes with every (re)join: a copy from before a
    // reset is refused with `reset` before it can merge, even one this tab
    // held open offline through the reset.
    token: async () => {
      await local.whenSynced
      return collabToken(await ticket(), ((await local.get(GENERATION_KEY)) as string | undefined) ?? null)
    },
  })
  provider.on('stateless', ({ payload }: { payload: string }) => {
    const { generation } = JSON.parse(payload) as Partial<CollabJoined>
    if (generation) void local.set(GENERATION_KEY, generation)
  })

  followProvider(provider, status, { synced: markSynced, stopped: () => settle(false) })

  // The browser knows it is offline at once; the socket only after 30 s of
  // silence, saying "Live" all the while. Close it, and rejoin when back.
  const goOffline = () => provider.disconnect()
  const goOnline = () => {
    if (status.state !== 'stopped') void provider.connect()
  }
  window.addEventListener('offline', goOffline)
  window.addEventListener('online', goOnline)
  const unlisten = () => {
    window.removeEventListener('offline', goOffline)
    window.removeEventListener('online', goOnline)
  }

  const awareness = provider.awareness!
  awareness.on('change', () => {
    const people = new Map<string, CollabPeer>()
    for (const [clientId, state] of awareness.getStates()) {
      const user = (state as { user?: Partial<CollabUser> }).user
      if (clientId === doc.clientID || !user?.userId || people.has(user.userId)) continue
      people.set(user.userId, {
        clientId,
        userId: user.userId,
        name: user.name ?? '',
        avatarUrl: user.avatarUrl ?? null,
      })
    }
    status.peers = [...people.values()]
  })

  return {
    doc,
    provider,
    status,
    synced,
    ready,
    extensions: () => [
      Collaboration.configure({ document: doc, field: BODY_FIELD }),
      CollaborationCaret.configure({
        provider,
        // The server overwrites the identity fields; nothing else is needed.
        user: {},
        render: caret,
        selectionRender: (user: Partial<CollabUser>) => ({
          nodeName: 'span',
          class: 'kn-caret-selection',
          style: `--kn-caret: ${caretColor(user)}`,
        }),
      }),
    ],
    suggestions: suggestionStore(doc, awareness, options.me ?? null),
    seal() {
      const message = doc.getMap<unknown>(META_FIELD).get('message')
      if (message instanceof Y.Text) setText(message, '')
      return toBase64(Y.encodeSnapshot(Y.snapshot(doc)))
    },
    destroy() {
      unlisten()
      provider.destroy()
      void local.destroy()
      doc.destroy()
    },
    async forget() {
      unlisten()
      provider.destroy()
      await local.clearData()
      doc.destroy()
    },
  }
}

/**
 * The suggestion list over the Y.Doc. Each entry's range is a pair of relative
 * positions on the body's top-level blocks: the start sticks to the first
 * suggested block and the end to the last, so a block a peer adds just
 * outside the range stays outside it — a discard never takes their text.
 * The credit is the writer's word, like any content in the draft.
 */
export function suggestionStore(
  doc: Y.Doc,
  awareness: {
    getStates(): Map<number, unknown>
    on(event: 'change', run: (change: { added: number[]; removed: number[] }) => void): void
    off(event: 'change', run: (change: { added: number[]; removed: number[] }) => void): void
  },
  me: SuggestionStore['me'],
): SuggestionStore {
  const map = doc.getMap<Y.Map<unknown>>(SUGGESTIONS_FIELD)
  return {
    me,
    read() {
      const writers = awareness.getStates()
      return readSuggestionEntries(doc).map(({ clientId, ...entry }) => ({
        ...entry,
        mine: clientId === doc.clientID,
        live: writers.has(clientId),
      }))
    },
    write(item) {
      writeSuggestionEntry(doc, item, me)
    },
    remove(ids) {
      removeSuggestionEntries(doc, ids)
    },
    subscribe(run) {
      const onList = (_events: unknown, tr: Y.Transaction) => {
        if (!tr.local) run()
      }
      // Cursor moves update awareness all the time; only arrivals and departures change a writer's liveness.
      const onPeers = ({ added, removed }: { added: number[]; removed: number[] }) => {
        if (added.length > 0 || removed.length > 0) run()
      }
      map.observeDeep(onList)
      awareness.on('change', onPeers)
      return () => {
        map.unobserveDeep(onList)
        awareness.off('change', onPeers)
      }
    },
    isRemote: (tr) => (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin === true,
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  // Chunked: spreading a large array into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** The part of the provider `followProvider` drives — a fake one fits in a spec. */
export type ProviderLike = Pick<HocuspocusProvider, 'on' | 'attach' | 'detach' | 'authorizedScope'>

/**
 * Turn the provider's events into `status`, and act on every reason: rejoin
 * with a fresh ticket, or stop for good.
 */
export function followProvider(
  provider: ProviderLike,
  status: CollabStatus,
  hooks: { synced(): void; stopped(): void },
): void {
  // Not while (re)joining: an edit typed before the new scope is known could be one the server drops.
  const refreshWritable = () => {
    status.writable =
      (status.state === 'live' || status.state === 'offline') &&
      !status.schemaMismatch &&
      provider.authorizedScope === 'read-write'
  }

  function stop(reason: CollabStopReason) {
    status.state = 'stopped'
    status.reason = reason
    refreshWritable()
    // No messages either way from here, and no rejoin when the socket reconnects.
    provider.detach()
    hooks.stopped()
  }

  function deny(reason: string) {
    const outcome = outcomeOf(reason)
    if (!outcome.rejoin) return stop(outcome.reason)
    status.state = 'connecting'
    refreshWritable()
    // Re-sends a fresh ticket and the sync handshake on the open socket.
    provider.detach()
    provider.attach()
  }

  provider.on('authenticated', refreshWritable)
  provider.on('authenticationFailed', ({ reason }: { reason: string }) => deny(reason))
  provider.on('synced', () => {
    if (status.state === 'stopped') return
    status.state = 'live'
    refreshWritable()
    hooks.synced()
  })
  provider.on('status', ({ status: socket }: { status: string }) => {
    if (socket !== 'connected' && status.state === 'live') status.state = 'offline'
  })
  provider.on('close', ({ event }: { event: CloseEvent }) => {
    if (status.state === 'stopped') return
    if (event.code === COLLAB_DISABLED_CLOSE_CODE) return stop('disabled')
    // A per-document close carries only its reason; a dropped socket carries none of ours.
    if ((COLLAB_DENY_REASONS as readonly string[]).includes(event.reason)) deny(event.reason)
  })
}

/** The person's avatar hue, from the attested id — never a colour a peer claims. */
function caretColor(user: Partial<CollabUser>): string {
  return user.userId ? avatarColor(user.userId) : 'var(--muted-foreground)'
}

function caret(user: Partial<CollabUser>): HTMLElement {
  const el = document.createElement('span')
  el.className = 'kn-caret'
  el.style.setProperty('--kn-caret', caretColor(user))
  // White initials-size text needs the deep shade of the same hue to be legible (lib/avatar).
  if (user.userId) el.style.setProperty('--kn-caret-ink', avatarColorDeep(user.userId))
  const label = document.createElement('span')
  label.className = 'kn-caret-label'
  label.textContent = user.name ?? ''
  el.append(label)
  return el
}

/* ------------------------------------------------------------ page fields */

/**
 * Replace a Y.Text's content with `next` by its one changed span, so a peer's
 * concurrent edit elsewhere in the same field survives.
 */
export function setText(text: Y.Text, next: string): void {
  const prev = text.toString()
  if (prev === next) return
  let start = 0
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++
  let end = 0
  while (
    end < prev.length - start &&
    end < next.length - start &&
    prev[prev.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++
  }
  text.doc!.transact(() => {
    text.delete(start, prev.length - start - end)
    text.insert(start, next.slice(start, next.length - end))
  })
}

/** Where a caret at `index` lands after a peer's change; text inserted at the caret goes before it. */
export function mapIndex(delta: Y.YTextEvent['delta'], index: number): number {
  let pos = 0
  for (const op of delta) {
    if (pos > index) break
    if (op.retain) pos += op.retain
    else if (typeof op.insert === 'string') {
      index += op.insert.length
      pos += op.insert.length
    } else if (op.delete) index -= Math.min(op.delete, index - pos)
  }
  return index
}

export { META_FIELD }

/**
 * Bind the page fields to the draft's `meta` map: free text as Y.Text (title,
 * tags, message — two people can type in one), everything else as a
 * last-writer-wins value. A field the draft does not hold yet — a draft the
 * server seeded before it seeded fields — is filled from what the editor
 * loaded (`seedPageMeta`).
 * Returns the unbind.
 */
export function bindPageFields(
  doc: Y.Doc,
  fields: { texts: Record<string, Ref<string>>; values: Record<string, Ref<unknown>> },
): () => void {
  const meta = doc.getMap<unknown>(META_FIELD)
  const json = (value: unknown) => JSON.stringify(value ?? null)
  const valuesOf = (refs: Record<string, Ref<unknown>>) =>
    Object.fromEntries(Object.entries(refs).map(([key, field]) => [key, field.value]))
  seedPageMeta(doc, { texts: valuesOf(fields.texts) as Record<string, string>, values: valuesOf(fields.values) })

  const stops: (() => void)[] = []
  /**
   * Each text field follows whatever Y.Text its key holds *now*. Two tabs
   * seeding one key at once both write a Y.Text, and the map keeps one: the
   * loser's would otherwise take its author's typing to a text nobody reads.
   */
  const unobserveText = new Map<string, () => void>()
  function followText(key: string, field: Ref<string>) {
    unobserveText.get(key)?.()
    const text = meta.get(key) as Y.Text
    field.value = text.toString()
    const observe = (event: Y.YTextEvent, tr: Y.Transaction) => {
      if (tr.local) return
      // Keep the caret of whoever is typing in this field where their text is.
      const el = document.activeElement
      const focused =
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value === field.value ? el : null
      const selection = focused && [focused.selectionStart ?? 0, focused.selectionEnd ?? 0]
      field.value = text.toString()
      if (focused && selection) {
        void nextTick(() => focused.setSelectionRange(mapIndex(event.delta, selection[0]), mapIndex(event.delta, selection[1])))
      }
    }
    text.observe(observe)
    unobserveText.set(key, () => text.unobserve(observe))
  }
  for (const [key, field] of Object.entries(fields.texts)) {
    followText(key, field)
    stops.push(watch(field, (next) => setText(meta.get(key) as Y.Text, next)))
  }
  stops.push(() => unobserveText.forEach((unobserve) => unobserve()))

  for (const [key, field] of Object.entries(fields.values)) {
    field.value = JSON.parse(json(meta.get(key)))
    stops.push(
      watch(
        field,
        (next) => {
          if (json(next) !== json(meta.get(key))) meta.set(key, JSON.parse(json(next)))
        },
        { deep: true },
      ),
    )
  }
  const observeKeys = (event: Y.YMapEvent<unknown>, tr: Y.Transaction) => {
    if (tr.local) return
    for (const key of event.keysChanged) {
      const text = fields.texts[key]
      if (text && meta.get(key) instanceof Y.Text) followText(key, text)
      const value = fields.values[key]
      if (value) value.value = JSON.parse(json(meta.get(key)))
    }
  }
  meta.observe(observeKeys)
  stops.push(() => meta.unobserve(observeKeys))

  return () => stops.forEach((stop) => stop())
}
