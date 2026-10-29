<script setup lang="ts">
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { Columns2, Columns3 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps(nodeViewProps)

/**
 * Changing column count has to change the *content*, not just an attribute:
 * the schema pins the child count, so dropping from three columns to two must
 * merge the orphaned column's blocks into the last remaining one rather than
 * discarding what the author wrote there.
 */
function setColumns(next: 2 | 3) {
  const current = props.node.childCount
  if (next === current) return
  const columns = props.node.content.content.map((child) => child.toJSON())
  if (next > current) {
    columns.push({ type: 'knLayoutColumn', content: [{ type: 'paragraph' }] })
  } else {
    const [dropped] = columns.splice(next)
    const last = columns[columns.length - 1] as { content?: unknown[] }
    if (dropped && Array.isArray((dropped as { content?: unknown[] }).content)) {
      last.content = [...(last.content ?? []), ...((dropped as { content: unknown[] }).content ?? [])]
    }
  }
  const pos = props.getPos()
  if (typeof pos !== 'number') return
  props.editor
    .chain()
    .focus()
    .insertContentAt(
      { from: pos, to: pos + props.node.nodeSize },
      { type: 'knLayout', attrs: { columns: next }, content: columns },
    )
    .run()
}
</script>

<template>
  <NodeViewWrapper class="kn-layout group/layout" :data-columns="node.attrs.columns">
    <NodeViewContent class="kn-layout-grid" />
    <div
      v-if="editor.isEditable"
      contenteditable="false"
      class="kn-layout-switch opacity-0 transition-opacity group-hover/layout:opacity-100 focus-within:opacity-100"
    >
      <button type="button" :aria-label="t('toolbar.twoColumns')" :aria-pressed="node.attrs.columns === 2" @click="setColumns(2)">
        <Columns2 class="size-3.5" />
      </button>
      <button type="button" :aria-label="t('toolbar.threeColumns')" :aria-pressed="node.attrs.columns === 3" @click="setColumns(3)">
        <Columns3 class="size-3.5" />
      </button>
    </div>
  </NodeViewWrapper>
</template>
