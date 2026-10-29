/**
 * The API contract block: one HTTP endpoint, documented.
 *
 * The spec (attributes, parse and render rules) lives in
 * `@knowledge/editor-schema`; this file adds the node views and the insert
 * command with its translated template.
 *
 * The encoding follows the rule in `core/markdown/nodes.ts` — markdown stays
 * canonical and text stays visible. Method and path ride as attributes for the
 * machine, but the endpoint is *also* emitted as a real `###` heading and every
 * parameter as a real GFM table, because the ingestion worker chunks the stored
 * markdown and prepends the heading path before embedding. A contract written
 * as a JSON fence would be invisible to search, to the graph and to the
 * assistant; written this way it is a readable API reference even on GitHub.
 */
import type { JSONContent } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { ApiContract as ApiContractSpec, ApiSection as ApiSectionSpec } from '@knowledge/editor-schema'
import type { ApiSectionKind, HttpMethod } from '@/core/markdown/nodes'
import ApiContractNode from '../nodes/ApiContractNode.vue'
import ApiSectionNode from '../nodes/ApiSectionNode.vue'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    knApi: {
      setApiContract: (method?: HttpMethod) => ReturnType
    }
  }
}

/** Translator for the section labels, handed in by the editor shell. */
export interface ApiOptions {
  t: (key: string) => string
}

export const ApiContract = ApiContractSpec.extend<ApiOptions>({
  addOptions() {
    // Identity fallback so the node is usable without configuration; the editor
    // passes the real translator, as it does for CommentAnchors.
    return { t: (key: string) => key }
  },

  addNodeView() {
    return VueNodeViewRenderer(ApiContractNode)
  },

  addCommands() {
    return {
      setApiContract:
        (method = 'GET') =>
        ({ commands }) =>
          commands.insertContent(apiTemplate(method, this.options.t)),
    }
  },
})

export const ApiSection = ApiSectionSpec.extend({
  addNodeView() {
    return VueNodeViewRenderer(ApiSectionNode)
  },
})

// --- the inserted template ---------------------------------------------------

/**
 * Every cell here is plain text, and must stay that way: the `knTable` rule in
 * serialize.ts builds cells from `textContent`, so a backtick, an asterisk or
 * an <angle-bracketed> placeholder is silently destroyed on the first autosave
 * and the author watches their formatting vanish. Write `Bearer token`, never
 * `` `Bearer <token>` ``.
 */
const cell = (text: string, header = false): JSONContent => ({
  type: header ? 'tableHeader' : 'tableCell',
  content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
})

const table = (head: string[], rows: string[][]): JSONContent => ({
  type: 'table',
  content: [
    { type: 'tableRow', content: head.map((h) => cell(h, true)) },
    ...rows.map((r) => ({ type: 'tableRow', content: r.map((c) => cell(c)) })),
  ],
})

/** Level 4, one below the block's own `###`, so the page rail lists endpoints and not their sections. */
const label = (text: string): JSONContent => ({
  type: 'heading',
  attrs: { level: 4 },
  content: [{ type: 'text', text }],
})

const section = (kind: ApiSectionKind, content: JSONContent[]): JSONContent => ({
  type: 'knApiSection',
  attrs: { kind },
  content,
})

function apiTemplate(method: HttpMethod, t: (key: string) => string): JSONContent {
  return {
    type: 'knApi',
    attrs: { method, path: '/v1/resource/{id}' },
    content: [
      section('summary', [{ type: 'paragraph' }]),
      section('params', [
        label(t('api.section.params')),
        table(
          [t('api.col.name'), t('api.col.in'), t('api.col.type'), t('api.col.required'), t('api.col.description')],
          [['id', 'path', 'uuid', t('api.yes'), '']],
        ),
      ]),
      section('body', [
        label(t('api.section.body')),
        table([t('api.col.field'), t('api.col.type'), t('api.col.required'), t('api.col.description')], [['', '', '', '']]),
      ]),
      section('responses', [
        label(t('api.section.responses')),
        table([t('api.col.code'), t('api.col.body'), t('api.col.description')], [
          ['200', '', 'OK'],
          ['4xx', '', ''],
        ]),
      ]),
      section('auth', [
        label(t('api.section.auth')),
        table([t('api.col.header'), t('api.col.required'), t('api.col.description')], [
          ['Authorization', t('api.yes'), 'Bearer token'],
        ]),
      ]),
    ],
  }
}
