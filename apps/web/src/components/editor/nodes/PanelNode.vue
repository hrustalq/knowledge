<script setup lang="ts">
// Confluence-style callout. The body is real editable content (NodeViewContent),
// not a text attribute, so links, lists and nested blocks all work inside it —
// and so the prose still reaches the chunker when this serializes to a
// GitHub alert blockquote.
import { computed } from 'vue'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { AlertTriangle, Bookmark, CheckCircle2, Info, XCircle } from 'lucide-vue-next'
import { PANEL_META, PANEL_TYPES, type PanelType } from '@/lib/markdown/nodes'

const props = defineProps(nodeViewProps)

const ICONS = {
  note: Info,
  tip: CheckCircle2,
  important: Bookmark,
  warning: AlertTriangle,
  caution: XCircle,
} as const

const type = computed<PanelType>(() => (props.node.attrs.type as PanelType) ?? 'note')
</script>

<template>
  <NodeViewWrapper :data-kn-panel="type" class="kn-panel group/panel">
    <div class="kn-panel-icon" contenteditable="false">
      <component :is="ICONS[type]" class="size-4" aria-hidden="true" />
    </div>
    <NodeViewContent class="kn-panel-body" />

    <!-- Type switcher: visible on hover, so the panel reads as content at rest. -->
    <div
      v-if="editor.isEditable"
      contenteditable="false"
      class="kn-panel-switch opacity-0 transition-opacity group-hover/panel:opacity-100 focus-within:opacity-100"
    >
      <button
        v-for="t in PANEL_TYPES"
        :key="t"
        type="button"
        class="kn-panel-swatch"
        :data-kn-panel-swatch="t"
        :aria-label="`Change to ${PANEL_META[t].label}`"
        :aria-pressed="t === type"
        @click="updateAttributes({ type: t })"
      />
    </div>
  </NodeViewWrapper>
</template>
