<script setup lang="ts">
// Collapsible section. The summary is a contenteditable span rather than an
// input: an input inside ProseMirror steals selection and breaks undo, and the
// label needs to look exactly like the heading it replaces.
import { ref } from 'vue'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { ChevronRight } from 'lucide-vue-next'

const props = defineProps(nodeViewProps)
const open = ref<boolean>(props.node.attrs.open !== false)

function commitSummary(event: Event) {
  const text = (event.target as HTMLElement).textContent?.trim() || 'Details'
  props.updateAttributes({ summary: text })
}

function toggle() {
  open.value = !open.value
  props.updateAttributes({ open: open.value })
}
</script>

<template>
  <NodeViewWrapper class="kn-expand" :data-open="open">
    <div class="kn-expand-head" contenteditable="false">
      <button
        type="button"
        class="kn-expand-toggle"
        :aria-expanded="open"
        :aria-label="open ? 'Collapse section' : 'Expand section'"
        @click="toggle"
      >
        <ChevronRight class="size-4 transition-transform duration-200" :class="open ? 'rotate-90' : ''" />
      </button>
      <span
        class="kn-expand-summary"
        :contenteditable="editor.isEditable"
        spellcheck="false"
        @blur="commitSummary"
        @keydown.enter.prevent="($event.target as HTMLElement).blur()"
        >{{ node.attrs.summary }}</span
      >
    </div>
    <!-- Kept mounted while collapsed: unmounting would drop ProseMirror's
         content DOM and desync the document. -->
    <NodeViewContent class="kn-expand-body" :class="open ? '' : 'hidden'" />
  </NodeViewWrapper>
</template>
