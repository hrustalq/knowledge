<script setup lang="ts">
/**
 * Table row/column controls. Appear only while the caret is inside a table and
 * anchor to that table, so a page full of tables never shows more than one set.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Editor } from '@tiptap/core'
import {
  ArrowDownToLine,
  ArrowRightToLine,
  Rows3,
  Columns3,
  Trash2,
} from 'lucide-vue-next'
import { useAnchoredFloating, type AnchorRect } from '@/lib/use-anchored'

const { t } = useI18n()
const props = defineProps<{ editor: Editor }>()

/**
 * The table's own box. Sitting above it is the default; dropping below when a
 * table near the top of the page leaves no room — and sliding sideways when one
 * near the right edge would push the bar off-screen — is Floating UI's `flip`
 * and `shift`, which is why the hand-rolled ceiling check is gone.
 */
const rect = ref<AnchorRect | null>(null)
const { setFloating, floatingStyles } = useAnchoredFloating(rect, { placement: 'top' })

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
  rect.value = { top: box.top, left: box.left, width: box.width, height: box.height }
}

onMounted(() => {
  props.editor.on('selectionUpdate', update)
  props.editor.on('transaction', update)
})
onBeforeUnmount(() => {
  props.editor.off('selectionUpdate', update)
  props.editor.off('transaction', update)
})
</script>

<template>
  <div v-if="rect" :ref="setFloating" class="kn-table-bar" :style="floatingStyles" role="toolbar" :aria-label="t('toolbar.table.label')">
    <button type="button" :title="t('toolbar.table.addRow')" @mousedown.prevent="editor.chain().focus().addRowAfter().run()">
      <ArrowDownToLine class="size-3.5" /> {{ t('toolbar.table.row') }}
    </button>
    <button type="button" :title="t('toolbar.table.addColumn')" @mousedown.prevent="editor.chain().focus().addColumnAfter().run()">
      <ArrowRightToLine class="size-3.5" /> {{ t('toolbar.table.column') }}
    </button>
    <span class="kn-bubble-sep" />
    <button type="button" :title="t('toolbar.table.deleteRow')" @mousedown.prevent="editor.chain().focus().deleteRow().run()">
      <Rows3 class="size-3.5" />
    </button>
    <button type="button" :title="t('toolbar.table.deleteColumn')" @mousedown.prevent="editor.chain().focus().deleteColumn().run()">
      <Columns3 class="size-3.5" />
    </button>
    <button type="button" :title="t('toolbar.table.toggleHeader')" @mousedown.prevent="editor.chain().focus().toggleHeaderRow().run()">
      H
    </button>
    <span class="kn-bubble-sep" />
    <button type="button" class="kn-danger" :title="t('toolbar.table.deleteTable')" @mousedown.prevent="editor.chain().focus().deleteTable().run()">
      <Trash2 class="size-3.5" />
    </button>
  </div>
</template>
