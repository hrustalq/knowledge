/**
 * One suggestion factory, two triggers: `/` opens the block palette and `@`
 * opens the page picker. The extension stays presentation-free — it reports
 * state to the shell, which owns the popup — so both menus share one keyboard
 * contract and one set of edge cases.
 */
import { Extension, type Editor, type Range } from '@tiptap/core'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'

export interface SuggestionRect {
  top: number
  bottom: number
  left: number
}

export interface SuggestionSession {
  query: string
  rect: SuggestionRect | null
  command: (payload: unknown) => void
}

export interface SuggestionHandlers {
  onStart: (session: SuggestionSession) => void
  onUpdate: (session: SuggestionSession) => void
  onExit: () => void
  /** Return true when the menu consumed the key. */
  onKeyDown: (event: KeyboardEvent) => boolean
}

function toRect(clientRect: (() => DOMRect | null) | null | undefined): SuggestionRect | null {
  const rect = clientRect?.()
  if (!rect) return null
  return { top: rect.top, bottom: rect.bottom, left: rect.left }
}

interface CreateOptions {
  name: string
  char: string
  /** Applied when the user picks an item: the extension only supplies the range. */
  apply: (ctx: { editor: Editor; range: Range; payload: unknown }) => void
  /** `/` only makes sense at the start of an empty-ish block; `@` can fire anywhere. */
  startOfLine?: boolean
}

export function createSuggestionExtension(options: CreateOptions, handlers: SuggestionHandlers) {
  const pluginKey = new PluginKey(options.name)

  return Extension.create({
    name: options.name,

    addProseMirrorPlugins() {
      const suggestion: SuggestionOptions = {
        editor: this.editor,
        char: options.char,
        pluginKey,
        startOfLine: options.startOfLine ?? false,
        allowSpaces: false,
        // Items live in the shell (they depend on API data); the plugin only
        // needs *something* non-empty so it keeps the session open while typing.
        items: () => [null],
        command: ({ editor, range, props }) => {
          options.apply({ editor, range, payload: props })
        },
        render: () => ({
          onStart: (props) => {
            handlers.onStart({
              query: props.query,
              rect: toRect(props.clientRect),
              command: (payload) => props.command(payload as never),
            })
          },
          onUpdate: (props) => {
            handlers.onUpdate({
              query: props.query,
              rect: toRect(props.clientRect),
              command: (payload) => props.command(payload as never),
            })
          },
          onKeyDown: (props) => handlers.onKeyDown(props.event),
          onExit: () => handlers.onExit(),
        }),
      }

      return [Suggestion(suggestion)]
    },
  })
}
