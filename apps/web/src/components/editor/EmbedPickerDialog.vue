<script setup lang="ts">
/**
 * The Figma picker (#470, docs/features/64): which frames go in an embed
 * group, in what order, with what captions, in a strip or a grid.
 *
 * Loaded by dynamic `import()` from RichEditor on first open, so a reader of a
 * page never downloads it. Every Figma call goes through the API, which holds
 * the connector's token; the browser only ever sees file names, frame names
 * and Figma's render URLs for the thumbnails.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { ArrowDown, ArrowUp, GripVertical, Link2, Loader2, X } from 'lucide-vue-next'
import {
  DEFAULT_EMBED_MAX_ITEMS,
  canonicalEmbedUrl,
  parseEmbedUrl,
  type EmbedItem,
  type EmbedLayout,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'

export interface EmbedGroupDraft {
  layout: EmbedLayout
  caption: string
  items: EmbedItem[]
}

const props = defineProps<{ open: boolean; initial: EmbedGroupDraft | null }>()
const emit = defineEmits<{ 'update:open': [boolean]; save: [EmbedGroupDraft] }>()
const { t } = useI18n()
const workspaceId = getWorkspaceId()

/** One selected item, with what the picker knows to draw it. */
interface Picked extends EmbedItem {
  key: string
  thumbnailUrl: string | null
  name: string | null
}

const items = ref<Picked[]>([])
const caption = ref('')
const layout = ref<EmbedLayout>('strip')
const fileKey = ref<string | null>(null)
const link = ref('')
const linkError = ref<string | null>(null)
const resolving = ref(false)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const draft = props.initial
    items.value = (draft?.items ?? []).map((i) => ({ ...i, key: itemKey(i.url), thumbnailUrl: null, name: null }))
    caption.value = draft?.caption ?? ''
    layout.value = draft?.layout ?? 'strip'
    link.value = ''
    linkError.value = null
    fileKey.value = draft?.items.map((i) => parseEmbedUrl(i.url)?.fileKey).find(Boolean) ?? null
  },
  { immediate: true },
)

const filesQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/embeds/figma/files', { query: { workspaceId } }),
    enabled: props.open,
    staleTime: 60_000,
  })),
)
const files = computed(() => filesQuery.data.value?.files ?? [])
watch(files, (list) => {
  if (!fileKey.value && list.length) fileKey.value = list[0]!.fileKey
})

const fileQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/embeds/figma/files/{fileKey}', { path: { fileKey: fileKey.value ?? '' }, query: { workspaceId } }),
    enabled: props.open && !!fileKey.value,
    staleTime: 60_000,
  })),
)
const file = computed(() => fileQuery.data.value ?? null)

/** Thumbnails of the open file's frames, so items already in the group show theirs too. */
const thumbs = computed(
  () => new Map<string, string | null>((file.value?.pages ?? []).flatMap((p) => p.frames.map((f) => [`${file.value!.fileKey}/${f.id}`, f.thumbnailUrl]))),
)

const max = DEFAULT_EMBED_MAX_ITEMS
const full = computed(() => items.value.length >= max)

function itemKey(url: string): string {
  const ref = parseEmbedUrl(url)
  return ref ? `${ref.fileKey}/${ref.nodeId ?? ''}` : url
}

function frameUrl(nodeId: string): string {
  return canonicalEmbedUrl({ provider: 'figma', fileKey: file.value!.fileKey, nodeId, board: file.value!.board })
}

function isPicked(nodeId: string): boolean {
  return items.value.some((i) => i.key === `${file.value?.fileKey}/${nodeId}`)
}

function toggle(frame: { id: string; name: string; thumbnailUrl: string | null }, on: boolean) {
  const key = `${file.value!.fileKey}/${frame.id}`
  if (!on) {
    items.value = items.value.filter((i) => i.key !== key)
    return
  }
  if (full.value || isPicked(frame.id)) return
  items.value.push({ url: frameUrl(frame.id), version: file.value!.version, caption: frame.name, key, thumbnailUrl: frame.thumbnailUrl, name: frame.name })
}

/** A deeper node joins by its "Copy link to selection" URL, pinned by the API at the file's current version. */
async function addLink() {
  linkError.value = null
  const url = link.value.trim()
  if (!url) return
  if (!parseEmbedUrl(url)) {
    linkError.value = t('editor.embedPicker.notFigma')
    return
  }
  if (full.value) return
  resolving.value = true
  try {
    const res = await api.post('/v1/embeds/figma/resolve', { body: { workspaceId, url } })
    if (!res.allowed) {
      linkError.value = t('editor.embedPicker.notAllowlisted')
      return
    }
    const key = itemKey(res.url)
    if (!items.value.some((i) => i.key === key)) {
      items.value.push({ url: res.url, version: res.version, caption: res.name ?? '', key, thumbnailUrl: null, name: res.name })
    }
    link.value = ''
  } catch (e) {
    linkError.value = errorMessage(e, t)
  } finally {
    resolving.value = false
  }
}

function move(index: number, by: -1 | 1) {
  const to = index + by
  if (to < 0 || to >= items.value.length) return
  const next = [...items.value]
  const [moved] = next.splice(index, 1)
  next.splice(to, 0, moved!)
  items.value = next
}

/** Drag to reorder — a convenience over the move buttons, which stay the keyboard path. */
const dragFrom = ref<number | null>(null)
function drop(index: number) {
  const from = dragFrom.value
  dragFrom.value = null
  if (from === null || from === index) return
  const next = [...items.value]
  const [moved] = next.splice(from, 1)
  next.splice(index, 0, moved!)
  items.value = next
}

function save() {
  emit('save', {
    layout: layout.value,
    caption: caption.value.trim(),
    items: items.value.map(({ url, version, caption: c }) => ({ url, version, caption: c.trim() })),
  })
  emit('update:open', false)
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="kn-embed-picker max-w-4xl gap-4">
      <DialogHeader>
        <DialogTitle>{{ initial?.items.length ? t('editor.embedPicker.editTitle') : t('editor.embedPicker.title') }}</DialogTitle>
        <DialogDescription>{{ t('editor.embedPicker.description', { max }) }}</DialogDescription>
      </DialogHeader>

      <!-- No connector: say so instead of an empty list. -->
      <div v-if="filesQuery.data.value && !filesQuery.data.value.connected" class="kn-embed-picker-empty">
        <p>{{ t('editor.embedPicker.noConnector') }}</p>
        <RouterLink to="/settings/connectors" class="text-primary text-sm underline underline-offset-2">
          {{ t('editor.embedPicker.openConnectors') }}
        </RouterLink>
      </div>

      <div v-else class="kn-embed-picker-body">
        <section class="kn-embed-picker-source" :aria-label="t('editor.embedPicker.sourceLabel')">
          <div class="flex flex-wrap items-center gap-2">
            <Select :model-value="fileKey ?? undefined" @update:model-value="fileKey = String($event)">
              <SelectTrigger class="min-w-0 flex-1" :aria-label="t('editor.embedPicker.file')">
                <SelectValue :placeholder="filesQuery.isPending.value ? t('editor.embedPicker.loadingFiles') : t('editor.embedPicker.pickFile')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="f in files" :key="f.fileKey" :value="f.fileKey">{{ f.name }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p v-if="filesQuery.data.value?.connected && !files.length" class="text-muted-foreground text-sm">{{ t('editor.embedPicker.noFiles') }}</p>

          <div class="kn-embed-picker-frames" role="group" :aria-label="t('editor.embedPicker.framesLabel')">
            <template v-if="fileQuery.isFetching.value && !file">
              <Skeleton v-for="n in 6" :key="n" class="h-14 w-full" />
            </template>
            <p v-else-if="fileQuery.isError.value" class="text-destructive text-sm">{{ errorMessage(fileQuery.error.value, t) }}</p>
            <template v-else-if="file">
              <div v-for="page in file.pages" :key="page.id" class="kn-embed-picker-page">
                <h3>{{ page.name }}</h3>
                <p v-if="!page.frames.length" class="text-muted-foreground text-xs">{{ t('editor.embedPicker.noFrames') }}</p>
                <label v-for="frame in page.frames" :key="frame.id" class="kn-embed-picker-frame" :data-picked="isPicked(frame.id)">
                  <Checkbox
                    :model-value="isPicked(frame.id)"
                    :disabled="full && !isPicked(frame.id)"
                    @update:model-value="toggle(frame, !!$event)"
                  />
                  <span class="kn-embed-picker-thumb" aria-hidden="true">
                    <img v-if="frame.thumbnailUrl" :src="frame.thumbnailUrl" alt="" loading="lazy" />
                  </span>
                  <span class="min-w-0">
                    <span class="block truncate text-sm font-medium">{{ frame.name }}</span>
                    <span class="text-muted-foreground block text-xs">{{ frame.type.toLowerCase().replace('_', ' ') }}</span>
                  </span>
                </label>
              </div>
            </template>
          </div>

          <form class="flex items-start gap-2" @submit.prevent="addLink">
            <div class="min-w-0 flex-1 space-y-1">
              <Input v-model="link" :placeholder="t('editor.embedPicker.linkPlaceholder')" :aria-label="t('editor.embedPicker.linkLabel')" :aria-invalid="!!linkError" />
              <p v-if="linkError" class="text-destructive text-xs" role="alert">{{ linkError }}</p>
            </div>
            <Button type="submit" variant="outline" :disabled="resolving || full || !link.trim()">
              <Loader2 v-if="resolving" class="size-3.5 animate-spin" /><Link2 v-else class="size-3.5" />
              {{ t('editor.embedPicker.addLink') }}
            </Button>
          </form>
        </section>

        <section class="kn-embed-picker-selected" :aria-label="t('editor.embedPicker.selectedLabel')">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-sm font-medium">{{ t('editor.embedPicker.selected', { count: items.length, max }) }}</h3>
            <div class="kn-embed-picker-layout" role="radiogroup" :aria-label="t('editor.embedPicker.layout')">
              <button v-for="l in (['strip', 'grid'] as const)" :key="l" type="button" role="radio" :aria-checked="layout === l" @click="layout = l">
                {{ t(`editor.embedPicker.layout_${l}`) }}
              </button>
            </div>
          </div>
          <p v-if="!items.length" class="text-muted-foreground text-sm">{{ t('editor.embedPicker.nothingSelected') }}</p>
          <ol class="kn-embed-picker-list">
            <li
              v-for="(item, i) in items"
              :key="item.key"
              draggable="true"
              :data-dragging="dragFrom === i"
              @dragstart="dragFrom = i"
              @dragend="dragFrom = null"
              @dragover.prevent
              @drop.prevent="drop(i)"
            >
              <GripVertical class="text-muted-foreground size-3.5 shrink-0 cursor-grab" aria-hidden="true" />
              <span class="kn-embed-picker-thumb" aria-hidden="true"><img v-if="item.thumbnailUrl ?? thumbs.get(item.key)" :src="(item.thumbnailUrl ?? thumbs.get(item.key))!" alt="" /></span>
              <Input v-model="item.caption" class="h-8 min-w-0 flex-1" :aria-label="t('editor.embedPicker.captionFor', { n: i + 1 })" :placeholder="item.name ?? t('editor.embed.untitled')" />
              <span class="flex shrink-0">
                <Button size="icon-sm" variant="ghost" :disabled="i === 0" :aria-label="t('editor.embedPicker.moveUp')" @click="move(i, -1)"><ArrowUp class="size-3.5" /></Button>
                <Button size="icon-sm" variant="ghost" :disabled="i === items.length - 1" :aria-label="t('editor.embedPicker.moveDown')" @click="move(i, 1)"><ArrowDown class="size-3.5" /></Button>
                <Button size="icon-sm" variant="ghost" :aria-label="t('editor.embedPicker.removeItem')" @click="items.splice(i, 1)"><X class="size-3.5" /></Button>
              </span>
            </li>
          </ol>
          <Input v-model="caption" :placeholder="t('editor.embedPicker.groupCaption')" :aria-label="t('editor.embedPicker.groupCaption')" />
        </section>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="emit('update:open', false)">{{ t('common.cancel') }}</Button>
        <Button :disabled="!items.length" @click="save">
          {{ initial?.items.length ? t('editor.embedPicker.save') : t('editor.embedPicker.insert') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
