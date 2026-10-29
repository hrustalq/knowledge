<script setup lang="ts">
// Table-of-contents macro. Derived live from the document's own headings, so
// it can never drift from the page — and it serializes to a marker, not a
// snapshot, so the published page recomputes it too.
import { computed } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { List } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps(nodeViewProps)

const headings = computed(() => {
  const out: { level: number; text: string }[] = []
  props.editor.state.doc.descendants((node) => {
    if (node.type.name === 'heading' && node.textContent.trim()) {
      out.push({ level: node.attrs.level as number, text: node.textContent })
    }
    return true
  })
  return out
})
</script>

<template>
  <NodeViewWrapper class="kn-block kn-toc" :data-selected="selected" contenteditable="false">
    <div class="kn-toc-head"><List class="size-3.5" /> {{ t('tree.onThisPage') }}</div>
    <ol v-if="headings.length" class="kn-toc-list">
      <li v-for="(h, i) in headings" :key="i" :data-level="h.level">{{ h.text }}</li>
    </ol>
    <p v-else class="kn-toc-empty">{{ t('editor.tocEmpty') }}</p>
  </NodeViewWrapper>
</template>
