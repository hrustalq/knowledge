<script setup lang="ts">
// One section of a contract. It carries no chrome of its own — the marker
// attribute exists so the OpenAPI exporter can find the section without
// matching its (translated) heading text.
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

defineProps(nodeViewProps)
</script>

<template>
  <NodeViewWrapper class="kn-api-section" :data-kn-api-section="node.attrs.kind">
    <NodeViewContent />
  </NodeViewWrapper>
</template>
