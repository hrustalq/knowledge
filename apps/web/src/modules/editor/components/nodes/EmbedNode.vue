<script setup lang="ts">
// An embed group (#470, docs/features/64): a tile per item, in a strip or a
// grid. On a page, each pinned item shows its snapshot (served by the API
// only while a revision of the page references it and the allowlist passes);
// anywhere else, and for an item the reader may not see, it is a captioned
// link. The markup and classes match the read view's (MarkdownView).
import { computed, ref } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { ExternalLink, Pencil, Play, RefreshCw, Trash2, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { embedSnapshotPath, embedStatusKey, type EmbedItem } from '@knowledge/contracts'
import { getWorkspaceId, resolveAssetUrl } from '@/shared/api/api'
import { api } from '@/shared/api/client'
import { toast } from 'vue-sonner'
import { errorMessage } from '@/shared/api/errors'
import { embedTile, figmaLiveUrl } from '@/modules/editor/model/embeds'
import { useEmbedStatus } from '../../model/use-embed-status'

const { t } = useI18n()
const props = defineProps(nodeViewProps)
const { documentId, byKey } = useEmbedStatus()

/** Which tile shows Figma's live frame. Mounted on demand only: an iframe per tile would load Figma for every reader. */
const live = ref<number | null>(null)

const tiles = computed(() =>
  ((props.node.attrs.items as EmbedItem[]) ?? []).map((item) => {
    const tile = embedTile(item, t('editor.embed.wholeFile'))
    const status = tile.ref && item.version ? byKey.value.get(embedStatusKey(tile.ref.fileKey, tile.ref.nodeId, item.version)) : undefined
    const src =
      status?.state === 'ready' && documentId.value && tile.ref
        ? resolveAssetUrl(embedSnapshotPath(documentId.value, tile.ref.fileKey, tile.ref.nodeId, item.version!))
        : null
    return {
      ...tile,
      state: status?.state ?? null,
      title: tile.caption || status?.name || t('editor.embed.untitled'),
      src,
      ratio: status?.width && status.height ? `${status.width} / ${status.height}` : undefined,
      liveUrl: tile.ref && documentId.value ? figmaLiveUrl(item.url) : null,
      changed: !!status?.changed,
    }
  }),
)

/**
 * Re-pin one item to its file's current version (#470): an ordinary edit, so
 * the revision diff shows only the version changing. Also how an unpinned
 * item gets its first version.
 */
const updating = ref<number | null>(null)
async function update(index: number) {
  const items = (props.node.attrs.items as EmbedItem[]) ?? []
  const item = items[index]
  if (!item || updating.value !== null) return
  updating.value = index
  try {
    const res = await api.post('/v1/embeds/figma/resolve', { body: { workspaceId: getWorkspaceId(), url: item.url } })
    if (!res.allowed || !res.version) {
      toast(t('editor.embed.pastedNotAllowed'))
      return
    }
    props.updateAttributes({ items: items.map((it, i) => (i === index ? { ...it, version: res.version, caption: it.caption || res.name || '' } : it)) })
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    updating.value = null
  }
}

/** Editors learn why a tile is only a link; readers just see the link. */
function note(tile: (typeof tiles.value)[number]): string | null {
  if (!props.editor.isEditable) return tile.state === 'rendering' ? t('editor.embed.rendering') : null
  if (tile.unpinned) return t('editor.embed.notPinned')
  if (tile.ref && !tile.state && documentId.value) return t('editor.embed.afterPublish')
  if (tile.state === 'rendering') return t('editor.embed.rendering')
  if (tile.state === 'unavailable') return t('editor.embed.unavailable')
  if (tile.state === 'failed') return t('editor.embed.failed')
  return null
}
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
      <div v-for="(tile, i) in tiles" :key="i" class="kn-embed-tile">
        <div v-if="live === i && tile.liveUrl" class="kn-embed-frame kn-embed-live" :style="{ aspectRatio: tile.ratio ?? '4 / 3' }">
          <iframe :src="tile.liveUrl" :title="tile.title" allowfullscreen loading="lazy" />
          <button type="button" class="kn-embed-close" :aria-label="t('editor.embed.closeLive')" @click="live = null">
            <X class="size-3.5" />
          </button>
        </div>
        <a
          v-else-if="tile.src"
          class="kn-embed-frame"
          :href="tile.href ?? undefined"
          target="_blank"
          rel="noopener noreferrer nofollow"
          :style="{ aspectRatio: tile.ratio }"
          tabindex="-1"
        >
          <img :src="tile.src" :alt="tile.title" loading="lazy" decoding="async" />
        </a>
        <div v-else-if="tile.state === 'rendering'" class="kn-embed-frame kn-embed-pending" :style="{ aspectRatio: tile.ratio ?? '4 / 3' }" aria-hidden="true" />
        <div class="kn-embed-bar">
        <component
          :is="tile.href ? 'a' : 'span'"
          class="kn-embed-item"
          :href="tile.href ?? undefined"
          :target="tile.href ? '_blank' : undefined"
          :rel="tile.href ? 'noopener noreferrer nofollow' : undefined"
        >
          <span class="kn-embed-caption">{{ tile.title }}</span>
          <span class="kn-embed-meta">
            {{ tile.meta }}<template v-if="note(tile)"> · {{ note(tile) }}</template>
            <ExternalLink v-if="tile.href" class="kn-embed-out" aria-hidden="true" />
          </span>
          <span v-if="tile.changed" class="kn-embed-changed">{{ t('editor.embed.changed') }}</span>
        </component>
        <button
          v-if="editor.isEditable && (tile.changed || tile.unpinned)"
          type="button"
          class="kn-embed-live-toggle"
          :disabled="updating !== null"
          :aria-label="t('editor.embed.updateNamed', { name: tile.title })"
          @click="update(i)"
        >
          <RefreshCw class="size-3" :class="{ 'animate-spin': updating === i }" aria-hidden="true" /> {{ t('editor.embed.update') }}
        </button>
        <button
          v-if="tile.liveUrl && live !== i"
          type="button"
          class="kn-embed-live-toggle"
          :aria-label="t('editor.embed.openLiveNamed', { name: tile.title })"
          @click="live = i"
        >
          <Play class="size-3" aria-hidden="true" /> {{ t('editor.embed.openLive') }}
        </button>
        </div>
      </div>
      <span v-if="editor.isEditable" class="kn-embed-actions">
        <button
          v-if="extension.options.onEdit"
          type="button"
          :aria-label="t('editor.embed.edit')"
          @click="extension.options.onEdit(getPos(), node.attrs)"
        >
          <Pencil class="size-3.5" />
        </button>
        <button type="button" class="kn-embed-remove" :aria-label="t('editor.embed.remove')" @click="deleteNode()">
          <Trash2 class="size-3.5" />
        </button>
      </span>
    </div>
    <figcaption v-if="node.attrs.caption" class="kn-embed-figcaption">{{ node.attrs.caption }}</figcaption>
  </NodeViewWrapper>
</template>
