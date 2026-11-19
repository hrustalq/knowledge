<script setup lang="ts">
// The editor's C4 studio (#1244), one per editor, opened by the URL:
// `?c4=<n>` is this page's n-th C4 block, `&view=` the view it opens on.
//
// It lives here and not in the block's node view on purpose: ProseMirror may
// rebuild a node view whenever it likes, and a full-screen dialog owned by one
// went down with it — and, the URL still saying open, came straight back up,
// over and over. Here the studio outlives any rebuild, and finds its block
// again by position each time it reads or writes.
import { computed, onBeforeUnmount, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Editor } from '@tiptap/vue-3'
import type { Node as PMNode } from '@tiptap/pm/model'
import { C4_LANG } from '@/core/markdown/structurizr'
import { LazyC4Studio } from '@/entities/document'

const props = defineProps<{ editor: Editor }>()
const route = useRoute()
const router = useRouter()

/** Bumped on every transaction: the editor's state is not reactive. */
const version = shallowRef(0)
const bump = () => version.value++
props.editor.on('transaction', bump)
onBeforeUnmount(() => props.editor.off('transaction', bump))

const index = computed(() => (typeof route.query.c4 === 'string' && /^\d+$/.test(route.query.c4) ? Number(route.query.c4) : -1))
const viewIndex = computed(() => (typeof route.query.view === 'string' ? Number(route.query.view) || 0 : 0))

/** The n-th C4 block and where it starts. */
function blockAt(n: number): { pos: number; node: PMNode } | null {
  let seen = 0
  let found: { pos: number; node: PMNode } | null = null
  props.editor.state.doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name === 'codeBlock' && node.attrs.language === C4_LANG && seen++ === n) found = { pos, node }
    return true
  })
  return found
}

const source = computed(() => {
  void version.value
  return index.value >= 0 ? (blockAt(index.value)?.node.textContent ?? null) : null
})
const editable = computed(() => {
  void version.value
  return props.editor.isEditable
})

/** The studio's text replaces the block's, in one transaction: undo, autosave and collaboration see an edit. */
function write(text: string) {
  const block = blockAt(index.value)
  if (!block) return
  const { state, view } = props.editor
  const from = block.pos + 1
  const to = block.pos + block.node.nodeSize - 1
  view.dispatch(text ? state.tr.replaceWith(from, to, state.schema.text(text)) : state.tr.delete(from, to))
}

function close() {
  const { c4: _c4, view: _view, ...rest } = route.query
  void router.replace({ query: rest })
}
</script>

<template>
  <LazyC4Studio
    v-if="source !== null"
    :source="source"
    :editable="editable"
    :view-index="viewIndex"
    @update:source="write"
    @undo="editor.commands.undo()"
    @redo="editor.commands.redo()"
    @close="close"
  />
</template>
