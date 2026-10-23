<script setup lang="ts">
// An embed group (#470, docs/features/64): captioned link tiles in a strip or
// a grid. The markup and classes match the read view's (MarkdownView), so a
// group looks the same read and edited.
import { computed } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { ExternalLink, Trash2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { EmbedItem } from '@knowledge/contracts/embeds'
import { embedTile } from '@/lib/embeds'

const { t } = useI18n()
const props = defineProps(nodeViewProps)

const tiles = computed(() =>
  ((props.node.attrs.items as EmbedItem[]) ?? []).map((item) => embedTile(item, t('editor.embed.wholeFile'))),
)
</script>

<template>
  <NodeViewWrapper
    as="figure"
    class="kn-embed"
    :data-kn-embed="node.attrs.layout"
    :data-selected="selected"
    :aria-label="node.attrs.caption || t('editor.embed.label')"
  >
    <div class="kn-embed-items" contenteditable="false">
      <component
        :is="tile.href ? 'a' : 'span'"
        v-for="(tile, i) in tiles"
        :key="i"
        class="kn-embed-item"
        :href="tile.href ?? undefined"
        :target="tile.href ? '_blank' : undefined"
        :rel="tile.href ? 'noopener noreferrer nofollow' : undefined"
      >
        <span class="kn-embed-caption">{{ tile.caption || t('editor.embed.untitled') }}</span>
        <span class="kn-embed-meta">
          {{ tile.meta }}
          <template v-if="editor.isEditable && tile.unpinned"> · {{ t('editor.embed.notPinned') }}</template>
          <ExternalLink v-if="tile.href" class="kn-embed-out" aria-hidden="true" />
        </span>
      </component>
      <button
        v-if="editor.isEditable"
        type="button"
        class="kn-embed-remove"
        :aria-label="t('editor.embed.remove')"
        @click="deleteNode()"
      >
        <Trash2 class="size-3.5" />
      </button>
    </div>
    <figcaption v-if="node.attrs.caption" class="kn-embed-figcaption">{{ node.attrs.caption }}</figcaption>
  </NodeViewWrapper>
</template>
