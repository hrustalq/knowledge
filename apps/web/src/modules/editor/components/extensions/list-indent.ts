/**
 * Indent and outdent for both list flavours, on the buttons and on Tab.
 *
 * Two things were wrong before: `sinkListItem('listItem')` is a no-op inside a
 * *task* list (whose item type is `taskItem`), so the toolbar button did
 * nothing there; and nothing bound Tab at all, so the keyboard could not do
 * what the mouse could.
 *
 * Tab only acts inside a list. Everywhere else it is left alone so it still
 * moves focus out of the editor — trapping Tab in a text box is an
 * accessibility failure, not a feature.
 */
import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'

export function canIndent(editor: Editor): boolean {
  return editor.can().sinkListItem('taskItem') || editor.can().sinkListItem('listItem')
}

export function canOutdent(editor: Editor): boolean {
  return editor.can().liftListItem('taskItem') || editor.can().liftListItem('listItem')
}

export function indent(editor: Editor): boolean {
  if (editor.isActive('taskItem')) return editor.chain().focus().sinkListItem('taskItem').run()
  return editor.chain().focus().sinkListItem('listItem').run()
}

export function outdent(editor: Editor): boolean {
  if (editor.isActive('taskItem')) return editor.chain().focus().liftListItem('taskItem').run()
  return editor.chain().focus().liftListItem('listItem').run()
}

export interface EditorShortcutOptions {
  /** Opens the link dialog. The toolbar tooltip promises ⌘K; this keeps it honest. */
  onLink: () => void
}

export const ListIndentKeymap = Extension.create<EditorShortcutOptions>({
  name: 'knListIndent',
  // Below TableKit (which owns Tab for cell navigation) so a table inside a
  // list still tabs between cells rather than indenting the list item.
  priority: 90,

  addOptions() {
    return { onLink: () => undefined }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-k': () => {
        this.options.onLink()
        return true
      },
      Tab: () => (this.editor.isActive('table') ? false : indent(this.editor)),
      'Shift-Tab': () => (this.editor.isActive('table') ? false : outdent(this.editor)),
      // Notion/Confluence muscle memory, and the only indent binding that
      // works while the caret sits mid-line.
      'Mod-]': () => indent(this.editor),
      'Mod-[': () => outdent(this.editor),
    }
  },
})
