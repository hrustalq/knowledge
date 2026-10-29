<script setup lang="ts">
/**
 * An agent, mentioned. Deliberately not the person chip.
 *
 * `UserAvatar` grew its `ai` prop for exactly this reason: the assistant posts
 * under the identity of whoever ran it, so nothing but a distinct mark tells a
 * reader that the thing being addressed is a machine. Reusing the `@` chip here
 * would put a colleague's affordance on a model.
 */
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { Bot } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

defineProps(nodeViewProps)
const { t } = useI18n()
</script>

<template>
  <NodeViewWrapper
    as="span"
    class="kn-mention kn-mention-agent"
    :data-selected="selected"
    :title="t('mention.tagged', { agent: node.attrs.label })"
  >
    <Bot class="size-3 shrink-0 opacity-70" aria-hidden="true" />
    <span>{{ node.attrs.label }}</span>
  </NodeViewWrapper>
</template>
