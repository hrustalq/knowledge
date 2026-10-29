// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import type { AssistantDraftEdit } from '@knowledge/contracts'
import { suggestionStore } from '../../model/use-collab'
import { AiSuggestions, pendingSuggestions, withoutSuggestions } from './ai-suggestions'

// The assistant as a peer in a shared draft (#80, phase 5): a suggestion one
// tab streams is seen, credited and decidable in every other tab, and never
// lands in anyone's undo history but the keeper's.

type Change = { added: number[]; removed: number[]; updated: number[] }

/** Two peers on two Y.Docs, every update relayed to the other as the server would. */
function pair() {
  const docs: [Y.Doc, Y.Doc] = [new Y.Doc(), new Y.Doc()]
  docs.forEach((doc, i) =>
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'relay') Y.applyUpdate(docs[1 - i]!, update, 'relay')
    }),
  )
  // One shared awareness: both clients are present until a spec says one left.
  const present = new Map<number, unknown>(docs.map((d) => [d.clientID, {}]))
  const listeners = new Set<(change: Change) => void>()
  const awareness = {
    getStates: () => present,
    on: (_: 'change', run: (change: Change) => void) => void listeners.add(run),
    off: (_: 'change', run: (change: Change) => void) => void listeners.delete(run),
  }
  const leave = (doc: Y.Doc) => {
    present.delete(doc.clientID)
    listeners.forEach((run) => run({ added: [], removed: [doc.clientID], updated: [] }))
  }
  const names = ['Ada', 'Bo']
  const editors = docs.map(
    (doc, i) =>
      new Editor({
        element: document.createElement('div'),
        extensions: [
          StarterKit.configure({ undoRedo: false }),
          Collaboration.configure({ document: doc, field: 'body' }),
          AiSuggestions.configure({
            t: (key, values) => `${key}:${JSON.stringify(values ?? {})}`,
            shared: suggestionStore(doc, awareness, { userId: `u${i}`, name: names[i]! }),
          }),
        ],
      }),
  ) as [Editor, Editor]
  return { docs, editors, leave }
}

const undoDepth = (editor: Editor) => yUndoPluginKey.getState(editor.state)!.undoManager.undoStack.length
const text = (editor: Editor) => editor.state.doc.textContent

function edit(state: AssistantDraftEdit['state'], markdown = 'Added'): AssistantDraftEdit {
  return { id: 's1', op: 'insert_after', anchor: 'One', markdown, state, agent: { key: 'reviewer', name: 'Reviewer' } }
}

let editors: Editor[] = []
afterEach(() => editors.forEach((e) => e.destroy()))

describe('assistant suggestions in a shared draft', () => {
  function seeded() {
    const p = pair()
    editors = p.editors
    const [a] = p.editors
    a.commands.setContent('<p>One</p><p>Two</p>')
    // The seed is not anyone's edit to undo.
    yUndoPluginKey.getState(a.state)!.undoManager.clear()
    return p
  }

  it('shows the streaming suggestion to the peer, credited, and lets the peer discard it', () => {
    const { editors: [a, b] } = seeded()
    a.commands.applyAiEdit(edit('streaming', 'Add'))
    const seen = pendingSuggestions(b.state)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id: 's1', state: 'streaming', mine: false, agent: { name: 'Reviewer' } })
    expect(seen[0]!.requestedBy).toEqual({ userId: 'u0', name: 'Ada' })

    a.commands.applyAiEdit(edit('ready', 'Added here'))
    expect(text(b)).toBe('OneAdded hereTwo')
    expect(pendingSuggestions(b.state)[0]!.state).toBe('ready')
    // Whatever the peer would publish leaves it out.
    expect(withoutSuggestions(b.state).textContent).toBe('OneTwo')

    b.commands.discardAiSuggestions(['s1'])
    expect(text(a)).toBe('OneTwo')
    expect(pendingSuggestions(a.state)).toHaveLength(0)
    expect(undoDepth(a)).toBe(0)
  })

  it('counts every peer’s pending suggestion, so a publish is refused from either tab', () => {
    const { editors: [a, b] } = seeded()
    a.commands.applyAiEdit(edit('ready'))
    expect(pendingSuggestions(a.state)).toHaveLength(1)
    expect(pendingSuggestions(b.state)).toHaveLength(1)
  })

  it('finishes a suggestion whose writer left mid-stream, so it can still be decided', () => {
    const { docs, editors: [a, b], leave } = seeded()
    a.commands.applyAiEdit(edit('streaming'))
    expect(pendingSuggestions(b.state)[0]!.state).toBe('streaming')
    leave(docs[0])
    expect(pendingSuggestions(b.state)[0]!.state).toBe('ready')
  })

  it('keeps as the keeper’s own edit: their undo takes it back, the writer’s history is untouched', () => {
    const { editors: [a, b] } = seeded()
    a.commands.applyAiEdit(edit('ready'))
    a.commands.settleAiSuggestions()

    b.commands.acceptAiSuggestions(['s1'])
    expect(pendingSuggestions(a.state)).toHaveLength(0)
    expect(text(a)).toBe('OneAddedTwo')
    expect(undoDepth(a)).toBe(0)

    b.commands.undo()
    expect(text(a)).toBe('OneTwo')
  })
})
