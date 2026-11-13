<script setup lang="ts">
/**
 * A bank's memory files (#1010): what Claude's memory tool wrote through
 * `…/memory-tool` or `/mcp/<bank>/files` (#1009), by path. A file's text is
 * fetched when it is opened and shown as plain text, never as markdown: an
 * agent wrote it, from sources nobody reviewed. Read-only but for delete,
 * which the API allows editors only.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/vue-query'
import { refDebounced } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { ChevronRight, FileText, Search, Trash2 } from 'lucide-vue-next'
import type { MemoryFileContent, MemoryFileListResponse, MemoryFileSummary } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { formatBytes, formatDateTime, formatRelative } from '@/shared/utils/format'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@knowledge/ui/button'
import { Collapse } from '@knowledge/ui/collapse'
import { confirm } from '@knowledge/ui/confirm'
import { Input } from '@knowledge/ui/input'
import { PageState } from '@knowledge/ui/layout'

/** A file to open on arrival, filtered to its path so it is on the first page (the Memories tab's "open the file"). */
const props = defineProps<{ bankId: string; open?: { id: string; path: string } | null }>()

const PAGE = 50
const MAX = 200

const { t } = useI18n()
const auth = useAuthStore()
const queryClient = useQueryClient()

const search = ref(props.open?.path ?? '')
const q = refDebounced(search, 300)
const limit = ref(PAGE)
watch(q, () => (limit.value = PAGE))

const options = computed(() =>
  apiQueryOptions('/v1/memory/banks/{id}/files', {
    path: { id: props.bankId },
    query: { ...(q.value.trim() ? { q: q.value.trim() } : {}), limit: limit.value },
  }),
)
const listQuery = useQuery(computed(() => ({ ...options.value, placeholderData: keepPreviousData })))
const data = computed(() => listQuery.data.value as MemoryFileListResponse | undefined)

/* -------------------------------------------------------------- open file */

const openId = ref<string | null>(props.open?.id ?? null)
const fileQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/memory/banks/{id}/files/{fileId}', { path: { id: props.bankId, fileId: openId.value ?? '' } }),
    enabled: !!openId.value,
  })),
)
const opened = computed(() => fileQuery.data.value as MemoryFileContent | undefined)
const toggle = (file: MemoryFileSummary) => (openId.value = openId.value === file.id ? null : file.id)

/* ----------------------------------------------------------------- delete */

const busy = ref<string | null>(null)
async function remove(file: MemoryFileSummary) {
  const ok = await confirm({
    title: t('memory.files.confirmTitle', { path: file.path }),
    description: t('memory.files.confirmBody'),
    action: t('memory.files.confirm'),
    destructive: true,
  })
  if (!ok) return
  busy.value = file.id
  try {
    await api.delete('/v1/memory/banks/{id}/files/{fileId}', { path: { id: props.bankId, fileId: file.id } })
    toast.success(t('memory.files.deleted'))
    if (openId.value === file.id) openId.value = null
    // A file's recall chunks are facts too: the memories query carries the counts.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['/v1/memory/banks/{id}/files'] }),
      queryClient.invalidateQueries({ queryKey: ['/v1/memory/banks/{id}/memories'] }),
    ])
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="space-y-3">
    <label class="relative block w-full sm:w-64">
      <span class="sr-only">{{ t('memory.files.search') }}</span>
      <Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input v-model="search" type="search" class="pl-8" :placeholder="t('memory.files.search')" />
    </label>

    <PageState v-if="listQuery.isPending.value" state="loading" :rows="3" row-class="h-11" />
    <PageState v-else-if="listQuery.isError.value && !data" state="error" :error="listQuery.error.value" />
    <PageState
      v-else-if="!data?.files.length"
      state="empty"
      :icon="FileText"
      :title="q ? t('memory.files.noMatchTitle') : t('memory.files.emptyTitle')"
      :description="q ? t('memory.files.noMatch') : t('memory.files.empty')"
    />

    <ul v-else class="divide-y rounded-md border" :aria-busy="listQuery.isFetching.value">
      <li v-for="file in data.files" :key="file.id">
        <div class="flex items-start gap-2 px-3 py-2">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-start gap-2 text-left"
            :aria-expanded="openId === file.id"
            :aria-controls="`memory-file-${file.id}`"
            @click="toggle(file)"
          >
            <ChevronRight class="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform" :class="openId === file.id ? 'rotate-90' : ''" aria-hidden="true" />
            <span class="min-w-0 flex-1">
              <span class="block font-mono text-ui break-all">{{ file.path }}</span>
              <span class="block text-xs text-muted-foreground">
                {{ formatBytes(file.size) }} ·
                <time :datetime="file.updatedAt" :title="formatDateTime(file.updatedAt)">{{ t('memory.files.updated', { when: formatRelative(file.updatedAt) }) }}</time>
              </span>
            </span>
          </button>
          <Button
            v-if="auth.canEdit"
            size="icon"
            variant="ghost"
            class="-my-1 size-8 shrink-0 text-muted-foreground hover:text-destructive"
            :disabled="busy === file.id"
            :aria-label="t('memory.files.deleteFile', { path: file.path })"
            :title="t('memory.files.deleteFile', { path: file.path })"
            @click="remove(file)"
          >
            <Trash2 class="size-4" />
          </Button>
        </div>
        <Collapse :open="openId === file.id">
          <div :id="`memory-file-${file.id}`" class="border-t bg-muted/30 px-3 py-2">
            <PageState v-if="fileQuery.isPending.value" state="loading" :rows="2" row-class="h-4" />
            <PageState v-else-if="fileQuery.isError.value" state="error" :error="fileQuery.error.value" />
            <p v-else-if="opened && !opened.content" class="text-xs text-muted-foreground">{{ t('memory.files.emptyFile') }}</p>
            <!-- Focusable because it may scroll: a long file must be readable from the keyboard too. -->
            <pre
              v-else-if="opened"
              tabindex="0"
              role="group"
              :aria-label="opened.path"
              class="max-h-96 overflow-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap outline-none focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset"
            >{{ opened.content }}</pre>
          </div>
        </Collapse>
      </li>
    </ul>

    <div v-if="data && data.files.length < data.total" class="flex items-center gap-3">
      <Button v-if="limit < MAX" variant="outline" size="sm" :disabled="listQuery.isFetching.value" @click="limit = Math.min(limit + PAGE, MAX)">{{ t('memory.bank.more') }}</Button>
      <span class="text-xs text-muted-foreground tabular-nums">{{ t(limit < MAX ? 'memory.bank.shown' : 'memory.bank.shownSearch', { shown: data.files.length, total: data.total }) }}</span>
    </div>
  </div>
</template>
