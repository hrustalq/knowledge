import { createLowlight, type LanguageFn } from 'lowlight'
import type { Editor } from '@tiptap/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/**
 * The editor's syntax highlighter. It used to register lowlight's whole
 * `common` set (37 grammars) in every chunk that shows a page, read-only or
 * not. Most pages use a handful, so those load with the editor and the rest of
 * `common` arrives in one chunk the first time a code block names a language
 * outside them. A language outside `common` is what it always was: plain text
 * or auto-detected, never an error.
 */
type Lowlight = ReturnType<typeof createLowlight>

const EAGER: Record<string, LanguageFn> = {
  bash,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  plaintext,
  python,
  shell,
  sql,
  typescript,
  xml,
  yaml,
}

export function createEditorLowlight(): Lowlight {
  return createLowlight(EAGER)
}

function codeLanguages(editor: Editor): Set<string> {
  const names = new Set<string>()
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'codeBlock') return true
    const language = node.attrs.language as string | null
    if (language) names.add(language)
    return false
  })
  return names
}

/**
 * Register the rest of `common` when a code block names a language the eager
 * set lacks, then re-decorate. Call it after content lands and on doc changes;
 * it costs a doc walk and does nothing once everything named is registered.
 */
export function highlightMissingLanguages(editor: Editor, lowlight: Lowlight): void {
  if (editor.isDestroyed) return
  const missing = [...codeLanguages(editor)].filter((name) => !lowlight.registered(name))
  if (missing.length === 0) return
  import('./lowlight-common')
    .then(({ rest: grammars }) => {
      if (editor.isDestroyed) return
      for (const [name, grammar] of Object.entries(grammars)) {
        if (!lowlight.registered(name)) lowlight.register(name, grammar)
      }
      if (missing.some((name) => lowlight.registered(name))) redecorate(editor)
    })
    .catch(() => {
      /* offline or a stale deploy: the blocks stay plain text, as before */
    })
}

/**
 * The lowlight plugin recomputes only on a doc change that covers a code block.
 * A same-attrs `setNodeMarkup` on each block is such a change and alters
 * nothing: kept out of history and out of the `update` event, so neither undo
 * nor the markdown binding sees it.
 */
function redecorate(editor: Editor) {
  const { state, view } = editor
  const tr = state.tr
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return true
    tr.setNodeMarkup(pos, undefined, node.attrs)
    return false
  })
  if (!tr.docChanged) return
  tr.setMeta('addToHistory', false).setMeta('preventUpdate', true)
  view.dispatch(tr)
}
