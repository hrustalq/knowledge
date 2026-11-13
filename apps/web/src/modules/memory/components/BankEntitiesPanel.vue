<script setup lang="ts">
/**
 * A bank's knowledge graph (#1010): the entities an MCP client wrote through
 * `/mcp/<bank>/graph` (#1008), in the order they were created, each with its
 * observations and the relations touching it. Read-only but for delete, which
 * the API allows editors only.
 *
 * An observation is a fact row, so its delete is the memories route's. All of
 * it is agent-written: plain text, never markdown.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/vue-query'
import { refDebounced } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { Network, Search, Trash2, X } from 'lucide-vue-next'
import type { MemoryEntityListResponse, MemoryEntitySummary, MemoryRelationSummary } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@knowledge/ui/button'
import { confirm } from '@knowledge/ui/confirm'
import { Input } from '@knowledge/ui/input'
import { PageState } from '@knowledge/ui/layout'

const props = defineProps<{ bankId: string }>()

const PAGE = 50
const MAX = 200

const { t } = useI18n()
const auth = useAuthStore()
const queryClient = useQueryClient()

const search = ref('')
const q = refDebounced(search, 300)
const limit = ref(PAGE)
watch(q, () => (limit.value = PAGE))

const options = computed(() =>
  apiQueryOptions('/v1/memory/banks/{id}/entities', {
    path: { id: props.bankId },
    query: { ...(q.value.trim() ? { q: q.value.trim() } : {}), limit: limit.value },
  }),
)
const listQuery = useQuery(computed(() => ({ ...options.value, placeholderData: keepPreviousData })))
const data = computed(() => listQuery.data.value as MemoryEntityListResponse | undefined)

/** Each relation under both of its ends, when both are listed. */
const relationsOf = computed(() => {
  const by = new Map<string, MemoryRelationSummary[]>()
  for (const r of data.value?.relations ?? []) {
    for (const end of new Set([r.fromId, r.toId])) by.set(end, [...(by.get(end) ?? []), r])
  }
  return by
})

// The bank's counts sit on the memories query too: an entity's observations are facts.
const refresh = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ['/v1/memory/banks/{id}/entities'] }),
    queryClient.invalidateQueries({ queryKey: ['/v1/memory/banks/{id}/memories'] }),
  ])

const busy = ref<string | null>(null)
async function run(key: string, call: () => Promise<unknown>, done: string) {
  busy.value = key
  try {
    await call()
    toast.success(done)
    await refresh()
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = null
  }
}

async function removeEntity(entity: MemoryEntitySummary) {
  const ok = await confirm({
    title: t('memory.entities.confirmTitle', { name: entity.name }),
    description: t('memory.entities.confirmBody'),
    action: t('memory.entities.confirm'),
    destructive: true,
  })
  if (!ok) return
  await run(entity.id, () => api.delete('/v1/memory/banks/{id}/entities/{entityId}', { path: { id: props.bankId, entityId: entity.id } }), t('memory.entities.deleted'))
}
const removeObservation = (id: string) =>
  run(id, () => api.delete('/v1/memory/banks/{id}/memories/{memoryId}', { path: { id: props.bankId, memoryId: id } }), t('memory.entities.observationDeleted'))
const removeRelation = (id: string) =>
  run(id, () => api.delete('/v1/memory/banks/{id}/relations/{relationId}', { path: { id: props.bankId, relationId: id } }), t('memory.entities.relationDeleted'))
</script>

<template>
  <div class="space-y-3">
    <label class="relative block w-full sm:w-64">
      <span class="sr-only">{{ t('memory.entities.search') }}</span>
      <Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input v-model="search" type="search" class="pl-8" :placeholder="t('memory.entities.search')" />
    </label>

    <PageState v-if="listQuery.isPending.value" state="loading" :rows="3" row-class="h-20" />
    <PageState v-else-if="listQuery.isError.value && !data" state="error" :error="listQuery.error.value" />
    <PageState
      v-else-if="!data?.entities.length"
      state="empty"
      :icon="Network"
      :title="q ? t('memory.entities.noMatchTitle') : t('memory.entities.emptyTitle')"
      :description="q ? t('memory.entities.noMatch') : t('memory.entities.empty')"
    />

    <ul v-else class="divide-y rounded-md border" :aria-busy="listQuery.isFetching.value">
      <li v-for="entity in data.entities" :key="entity.id" class="space-y-2 px-3 py-2.5">
        <div class="flex items-start gap-3">
          <p class="min-w-0 flex-1 text-sm">
            <span class="font-medium break-words">{{ entity.name }}</span>
            <span class="ml-2 font-mono text-xs break-all text-muted-foreground">{{ entity.entityType }}</span>
          </p>
          <Button
            v-if="auth.canEdit"
            size="icon"
            variant="ghost"
            class="-my-1 size-8 shrink-0 text-muted-foreground hover:text-destructive"
            :disabled="busy === entity.id"
            :aria-label="t('memory.entities.deleteEntity', { name: entity.name })"
            :title="t('memory.entities.deleteEntity', { name: entity.name })"
            @click="removeEntity(entity)"
          >
            <Trash2 class="size-4" />
          </Button>
        </div>

        <div class="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <section :aria-label="t('memory.entities.observations')" class="min-w-0 space-y-1">
            <h3 class="text-caption text-muted-foreground">{{ t('memory.entities.observations') }}</h3>
            <p v-if="!entity.observations.length" class="text-xs text-muted-foreground">{{ t('memory.entities.none') }}</p>
            <ul v-else class="space-y-0.5">
              <li v-for="o in entity.observations" :key="o.id" class="flex items-start gap-1">
                <p class="kn-measure min-w-0 flex-1 text-sm break-words whitespace-pre-wrap">{{ o.text }}</p>
                <Button
                  v-if="auth.canEdit"
                  size="icon"
                  variant="ghost"
                  class="-my-0.5 size-6 shrink-0 text-muted-foreground hover:text-destructive"
                  :disabled="busy === o.id"
                  :aria-label="t('memory.entities.deleteObservation')"
                  :title="t('memory.entities.deleteObservation')"
                  @click="removeObservation(o.id)"
                >
                  <X class="size-3.5" />
                </Button>
              </li>
            </ul>
          </section>

          <section :aria-label="t('memory.entities.relations')" class="min-w-0 space-y-1">
            <h3 class="text-caption text-muted-foreground">{{ t('memory.entities.relations') }}</h3>
            <p v-if="!relationsOf.get(entity.id)?.length" class="text-xs text-muted-foreground">{{ t('memory.entities.none') }}</p>
            <ul v-else class="space-y-0.5">
              <li v-for="r in relationsOf.get(entity.id)" :key="r.id" class="flex items-start gap-1">
                <p class="min-w-0 flex-1 text-sm break-words">
                  <span :class="r.fromId === entity.id ? 'text-muted-foreground' : ''">{{ r.from }}</span>
                  {{ ' ' }}<span class="font-mono text-xs text-muted-foreground">{{ r.relationType }}</span>
                  <span class="text-muted-foreground" aria-hidden="true"> → </span>
                  <span :class="r.toId === entity.id ? 'text-muted-foreground' : ''">{{ r.to }}</span>
                </p>
                <Button
                  v-if="auth.canEdit"
                  size="icon"
                  variant="ghost"
                  class="-my-0.5 size-6 shrink-0 text-muted-foreground hover:text-destructive"
                  :disabled="busy === r.id"
                  :aria-label="t('memory.entities.deleteRelation')"
                  :title="t('memory.entities.deleteRelation')"
                  @click="removeRelation(r.id)"
                >
                  <X class="size-3.5" />
                </Button>
              </li>
            </ul>
          </section>
        </div>
      </li>
    </ul>

    <div v-if="data && data.entities.length < data.total" class="flex items-center gap-3">
      <Button v-if="limit < MAX" variant="outline" size="sm" :disabled="listQuery.isFetching.value" @click="limit = Math.min(limit + PAGE, MAX)">{{ t('memory.bank.more') }}</Button>
      <span class="text-xs text-muted-foreground tabular-nums">{{ t(limit < MAX ? 'memory.bank.shown' : 'memory.bank.shownSearch', { shown: data.entities.length, total: data.total }) }}</span>
    </div>
  </div>
</template>
