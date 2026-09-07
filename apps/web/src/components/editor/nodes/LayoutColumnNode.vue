<script setup lang="ts">
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

defineProps(nodeViewProps)
</script>

<template>
  <NodeViewWrapper class="kn-layout-col" data-kn-col>
    <NodeViewContent />
  </NodeViewWrapper>
</template>
