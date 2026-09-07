<script setup lang="ts">
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { FileText } from 'lucide-vue-next'

defineProps(nodeViewProps)
</script>

<template>
  <NodeViewWrapper as="span" class="kn-mention" :data-selected="selected">
    <FileText class="size-3 shrink-0 opacity-70" aria-hidden="true" />
    <span>{{ node.attrs.label }}</span>
  </NodeViewWrapper>
</template>
