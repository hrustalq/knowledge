/**
 * A read-only page body as plain HTML, for the moment before the editor
 * exists (#643). The editor is built in `onMounted`, so without this the
 * server sent an empty read view and the body appeared only after the JS had
 * loaded and hydrated: the page's LCP.
 *
 * The HTML goes through the editor's own schema — parsed and serialized by
 * ProseMirror, as the editor itself would — so what is drawn is what the
 * editor then draws: only the nodes, marks and attributes the schema knows
 * (no script, no handler, no unknown tag), in the same shape. Node views
 * (diagrams, image handles, embeds) upgrade when the editor takes over.
 */
import { DOMParser, DOMSerializer } from '@tiptap/pm/model'
import { editorSchema } from '@knowledge/editor-schema'

/** The browser-facing API base: `<img src>` here is read by the reader's browser, never by the SSR process. */
const ASSET_BASE = import.meta.env.VITE_API_URL ?? '/api'

/** `html` (the markdown renderer's output) → schema-shaped HTML, parsed inside `document` (an inert one). */
export function staticBodyHtml(html: string, document: Document): string {
  const body = document.createElement('body')
  body.innerHTML = html
  const doc = DOMParser.fromSchema(editorSchema).parse(body)
  const out = document.createElement('div')
  out.appendChild(DOMSerializer.fromSchema(editorSchema).serializeFragment(doc.content, { document }))
  // Attachments are API routes (resolveAssetUrl does this in the node views).
  for (const el of out.querySelectorAll('[src^="/v1/"], [href^="/v1/"]')) {
    for (const attr of ['src', 'href']) {
      const v = el.getAttribute(attr)
      if (v?.startsWith('/v1/')) el.setAttribute(attr, ASSET_BASE + v)
    }
  }
  return out.innerHTML
}
