<script setup lang="ts">
/**
 * Table row/column controls. Appear only while the caret is inside a table and
 * anchor to that table, so a page full of tables never shows more than one set.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Editor } from '@tiptap/core'
import {
  ArrowDownToLine,
  ArrowRightToLine,
  Rows3,
  Columns3,
  Trash2,
} from 'lucide-vue-next'

const props = defineProps<{ editor: Editor }>()
const rect = ref<{ top: number; left: number } | null>(null)

const BAR_HEIGHT = 34
const GAP = 8

function update() {
  if (!props.editor.isActive('table')) {
    rect.value = null
    return
  }
  const { view, state } = props.editor
  const dom = view.domAtPos(state.selection.from).node as HTMLElement
  const table = (dom.nodeType === 1 ? dom : dom.parentElement)?.closest('table')
  if (!table) {
    rect.value = null
    return
  }
  const box = table.getBoundingClientRect()
  // Above the table by default, but below it when that would put the bar over
  // the sticky toolbar or off-screen — a table near the top of a page is the
  // common case, not the edge case.
  const surface = (view.dom as HTMLElement).closest('.kn-editor-surface')
  const ceiling = (surface?.getBoundingClientRect().top ?? 0) + GAP
  const above = box.top - BAR_HEIGHT - GAP
  rect.value = { top: above < ceiling ? box.bottom + GAP : above, left: box.left }
}

onMounted(() => {
  props.editor.on('selectionUpdate', update)
  props.editor.on('transaction', update)
})
onBeforeUnmount(() => {
  props.editor.off('selectionUpdate', update)
  props.editor.off('transaction', update)
})

const style = computed(() =>
  rect.value ? { top: `${rect.value.top}px`, left: `${rect.value.left}px` } : { display: 'none' },
)
</script>

<template>
  <div class="kn-table-bar" :style="style" role="toolbar" aria-label="Table">
    <button type="button" title="Add row below" @mousedown.prevent="editor.chain().focus().addRowAfter().run()">
      <ArrowDownToLine class="size-3.5" /> Row
    </button>
    <button type="button" title="Add column right" @mousedown.prevent="editor.chain().focus().addColumnAfter().run()">
      <ArrowRightToLine class="size-3.5" /> Column
    </button>
    <span class="kn-bubble-sep" />
    <button type="button" title="Delete row" @mousedown.prevent="editor.chain().focus().deleteRow().run()">
      <Rows3 class="size-3.5" />
    </button>
    <button type="button" title="Delete column" @mousedown.prevent="editor.chain().focus().deleteColumn().run()">
      <Columns3 class="size-3.5" />
    </button>
    <button type="button" title="Toggle header row" @mousedown.prevent="editor.chain().focus().toggleHeaderRow().run()">
      H
    </button>
    <span class="kn-bubble-sep" />
    <button type="button" class="kn-danger" title="Delete table" @mousedown.prevent="editor.chain().focus().deleteTable().run()">
      <Trash2 class="size-3.5" />
    </button>
  </div>
</template>
