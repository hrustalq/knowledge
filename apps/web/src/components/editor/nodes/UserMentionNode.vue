<script setup lang="ts">
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { AtSign } from 'lucide-vue-next'

defineProps(nodeViewProps)
</script>

<template>
  <NodeViewWrapper
    as="span"
    class="kn-mention kn-mention-user"
    :data-selected="selected"
    :title="`Mentioned: ${node.attrs.label}`"
  >
    <AtSign class="size-3 shrink-0 opacity-70" aria-hidden="true" />
    <span>{{ node.attrs.label }}</span>
  </NodeViewWrapper>
</template>
