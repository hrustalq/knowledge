<script setup lang="ts">
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { AtSign } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

defineProps(nodeViewProps)
const { t } = useI18n()
</script>

<template>
  <NodeViewWrapper
    as="span"
    class="kn-mention kn-mention-user"
    :data-selected="selected"
    :title="t('editor.mentioned', { name: node.attrs.label })"
  >
    <AtSign class="size-3 shrink-0 opacity-70" aria-hidden="true" />
    <span>{{ node.attrs.label }}</span>
  </NodeViewWrapper>
</template>
