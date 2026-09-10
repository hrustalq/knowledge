<script setup lang="ts">
/**
 * A page reference, inline.
 *
 * The chip is a link when the page is being *read* and plain text when it is
 * being *edited*. Both halves matter: a reference nobody can follow is not a
 * reference, and inside an editor a click has to be able to put the caret next
 * to the chip or select it — navigating away mid-sentence would make the chip
 * something you have to type around.
 *
 * RouterLink rather than a bare `<a>`: this lives inside the read surface of a
 * document page, and a full reload there throws away the rail's loaded widgets
 * and the reader's scroll position for a move within the same app.
 */
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { FileText } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'

const props = defineProps(nodeViewProps)
</script>

<template>
  <NodeViewWrapper as="span" class="kn-mention" :data-selected="selected">
    <FileText class="size-3 shrink-0 opacity-70" aria-hidden="true" />
    <RouterLink
      v-if="!props.editor.isEditable && node.attrs.documentId"
      :to="`/documents/${node.attrs.documentId}`"
      >{{ node.attrs.label }}</RouterLink
    >
    <span v-else>{{ node.attrs.label }}</span>
  </NodeViewWrapper>
</template>
