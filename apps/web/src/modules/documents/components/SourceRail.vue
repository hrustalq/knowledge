<script setup lang="ts">
/**
 * A source-backed page's source (#674), in the rail: where the page reads
 * from, whether it is following, paused or failing, and the controls that
 * change that. The page itself cannot be edited — this widget is how a person
 * acts on it. Restoring an earlier revision lives on each History row.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Copy, ExternalLink, ListTree, Pause, Play, RefreshCw, Sparkles, Webhook } from 'lucide-vue-next'
import type { DocumentSourceInfo, DocumentSourceWebhookResponse } from '@knowledge/contracts'
import { relativeTime } from '@/shared/api/api'
import { api, apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { confirm } from '@/shared/ui/confirm'
import { formatDateTime } from '@/shared/utils/format'
import { Button } from '@/shared/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { SOURCE_INTERVAL_OPTIONS, intervalValue, toInterval } from '../model/source-intervals'
import { recipeAttention } from '../model/source-recipe'

const props = defineProps<{ documentId: string; canEdit: boolean }>()
const emit = defineEmits<{ synced: [] }>()
const { t } = useI18n()
const queryClient = useQueryClient()

const options = computed(() => apiQueryOptions('/v1/documents/{id}/source', { path: { id: props.documentId } }))
const query = useQuery(options)
const source = computed(() => query.data.value as DocumentSourceInfo | undefined)

/** One state, read in this order: a pause is a person's choice and outranks a failure. */
const state = computed<'paused' | 'failing' | 'retrying' | 'following'>(() => {
  const s = source.value
  if (!s) return 'following'
  if (s.pausedAt) return 'paused'
  if (s.failures > 0) return 'failing'
  if (s.retryAt) return 'retrying'
  return 'following'
})
const DOT: Record<typeof state.value, string> = {
  following: 'bg-panel-tip',
  paused: 'bg-panel-warning',
  failing: 'bg-panel-caution',
  retrying: 'bg-panel-warning',
}

/** The recipe line (phase 2): what the review page would lead with. */
const attention = computed(() => recipeAttention(source.value?.recipe))
const router = useRouter()
const recipePath = computed(() => `/documents/${props.documentId}/source/recipe`)

/** A crawled tree (phase 3): the root counts its pages and holds a large change for confirmation; a page under it points up. */
const tree = computed(() => source.value?.tree ?? null)
const isRoot = computed(() => tree.value?.rootDocumentId === props.documentId)
const linkClass = 'rounded-sm underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

const busy = ref<string | null>(null)
async function act(name: string, run: () => Promise<DocumentSourceInfo | void>, done?: string) {
  if (busy.value) return
  busy.value = name
  try {
    const next = await run()
    if (next) queryClient.setQueryData(options.value.queryKey, next)
    if (done) toast.success(t(done))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = null
  }
}

const path = () => ({ path: { id: props.documentId } })
const pause = () => act('pause', () => api.post('/v1/documents/{id}/source/pause', path()), 'sources.paused')
const resume = () =>
  act('resume', async () => {
    const next = await api.post('/v1/documents/{id}/source/resume', path())
    emit('synced')
    return next
  }, 'sources.resumed')
const syncNow = () =>
  act('sync', async () => {
    await api.post('/v1/connectors/{id}/sync', { path: { id: source.value!.connectorId }, body: {} })
    emit('synced')
  }, 'sources.syncStarted')
const setInterval = (value: unknown) =>
  act('interval', () => api.patch('/v1/documents/{id}/source', { ...path(), body: { intervalMinutes: toInterval(String(value)) } }))

const draftRecipe = () =>
  act('draft', async () => {
    const next = await api.post('/v1/documents/{id}/source/recipe/draft', path())
    await router.push(recipePath.value)
    return next
  })

const webhook = ref<DocumentSourceWebhookResponse | null>(null)
/** Replacing a live secret breaks whatever signs with it, so that one asks first. */
async function rotateWebhook() {
  if (source.value?.webhookConfigured) {
    const ok = await confirm({
      title: t('sources.webhook.rotateConfirm.title'),
      description: t('sources.webhook.rotateConfirm.body'),
      action: t('sources.webhook.rotateConfirm.action'),
    })
    if (!ok) return
  }
  await act('webhook', async () => {
    webhook.value = await api.post('/v1/documents/{id}/source/webhook', path())
    void query.refetch()
  })
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('common.copied'))
  } catch {
    toast.error(t('sources.webhook.copyFailed'))
  }
}
</script>

<template>
  <div v-if="source" class="space-y-3 text-sm">
    <a
      :href="source.url"
      target="_blank"
      rel="noopener noreferrer"
      class="flex min-w-0 items-center gap-1.5 rounded-sm text-ui outline-none hover:underline hover:underline-offset-2 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      :title="source.url"
    >
      <span class="truncate">{{ t('sources.syncedFrom', { host: source.host }) }}</span>
      <ExternalLink class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </a>

    <p class="flex items-start gap-2 text-xs" role="status">
      <span class="mt-1.5 size-1.5 shrink-0 rounded-full" :class="DOT[state]" aria-hidden="true" />
      <span class="min-w-0">
        <template v-if="state === 'paused'">
          {{ t('sources.state.paused') }}<template v-if="source.aheadCount > 0">
            · {{ t('sources.state.ahead', { n: source.aheadCount }, source.aheadCount) }}</template>
        </template>
        <template v-else-if="state === 'failing'">
          {{ t('sources.state.failing', { n: source.failures }, source.failures) }}<template v-if="source.retryAt">
            · {{ t('sources.state.retryAt', { at: formatDateTime(source.retryAt) }) }}</template>
        </template>
        <template v-else-if="state === 'retrying'">
          {{ t('sources.state.retrying', { at: formatDateTime(source.retryAt!) }) }}
        </template>
        <template v-else>{{ t('sources.state.following') }}</template>
        <span class="block text-muted-foreground">
          {{ source.lastCheckedAt ? t('sources.lastChecked', { when: relativeTime(source.lastCheckedAt) }) : t('sources.neverChecked') }}
        </span>
      </span>
    </p>

    <p v-if="tree" class="flex items-start gap-2 text-xs">
      <ListTree class="mt-px size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span class="min-w-0">
        <template v-if="isRoot">
          {{ t('sources.tree.root', { n: tree.pages - 1 }, tree.pages - 1) }}
          <span v-if="tree.awaitingRunId" class="block">
            <span class="font-medium text-panel-warning-ink">{{ t('sources.tree.awaiting') }}</span>
            · <RouterLink :to="`/settings/connectors/runs/${tree.awaitingRunId}`" :class="linkClass">{{ t('sources.tree.review') }}</RouterLink>
          </span>
        </template>
        <template v-else>
          {{ t('sources.tree.member') }}
          · <RouterLink :to="`/documents/${tree.rootDocumentId}`" :class="linkClass">{{ t('sources.tree.openRoot') }}</RouterLink>
        </template>
      </span>
    </p>

    <p class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      <template v-if="attention === 'held'">
        <span class="font-medium text-panel-caution-ink">{{ t('sources.recipe.rail.held') }}</span>
        <RouterLink :to="recipePath" class="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">{{ t('sources.recipe.rail.review') }}</RouterLink>
      </template>
      <template v-else-if="attention === 'proposal'">
        <span class="font-medium">{{ t('sources.recipe.rail.proposal') }}</span>
        <RouterLink :to="recipePath" class="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">{{ t('sources.recipe.rail.review') }}</RouterLink>
      </template>
      <template v-else>
        <span v-if="attention === 'changed'" class="font-medium text-panel-warning-ink">{{ t('sources.recipe.rail.changed') }}</span>
        <span v-else class="text-muted-foreground">
          {{ source.recipe.active ? t('sources.recipe.rail.active', { n: source.recipe.active.version }) : t('sources.recipe.rail.implicit') }}
        </span>
        <span class="text-muted-foreground" aria-hidden="true">·</span>
        <RouterLink :to="recipePath" class="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">{{ t('sources.recipe.rail.open') }}</RouterLink>
        <Button v-if="attention === 'changed' && canEdit && source.recipe.hasBody" size="xs" variant="ghost" :disabled="busy !== null" @click="draftRecipe">
          <Sparkles class="size-3" :class="busy === 'draft' && 'motion-safe:animate-pulse'" /> {{ busy === 'draft' ? t('sources.recipe.drafting') : t('sources.recipe.draft') }}
        </Button>
      </template>
    </p>

    <template v-if="canEdit">
      <div class="space-y-1.5">
        <label :for="`source-interval-${documentId}`" class="text-xs text-muted-foreground">{{ t('sources.interval.label') }}</label>
        <Select :model-value="intervalValue(source.intervalMinutes)" :disabled="busy !== null" @update:model-value="setInterval">
          <SelectTrigger :id="`source-interval-${documentId}`" size="sm" class="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="o in SOURCE_INTERVAL_OPTIONS" :key="o.value" :value="o.value">{{ t(o.label) }}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <Button v-if="!source.pausedAt" size="sm" variant="outline" :disabled="busy !== null" @click="syncNow">
          <RefreshCw class="size-3.5" :class="busy === 'sync' && 'motion-safe:animate-spin'" /> {{ t('sources.syncNow') }}
        </Button>
        <Button v-if="source.pausedAt" size="sm" variant="outline" :disabled="busy !== null" @click="resume">
          <Play class="size-3.5" /> {{ t('sources.resume') }}
        </Button>
        <Button v-else size="sm" variant="ghost" :disabled="busy !== null" @click="pause">
          <Pause class="size-3.5" /> {{ t('sources.pause') }}
        </Button>
        <Button size="sm" variant="ghost" :disabled="busy !== null" @click="rotateWebhook">
          <Webhook class="size-3.5" /> {{ source.webhookConfigured ? t('sources.webhook.rotate') : t('sources.webhook.create') }}
        </Button>
      </div>

      <div v-if="webhook" class="space-y-2 rounded-md border bg-muted/40 p-2.5 text-xs">
        <p>{{ t('sources.webhook.once', { header: webhook.header }) }}</p>
        <div v-for="field in (['url', 'secret'] as const)" :key="field" class="flex min-w-0 items-center gap-1">
          <code class="min-w-0 flex-1 truncate font-mono" :title="webhook[field]">{{ webhook[field] }}</code>
          <Button size="icon-sm" variant="ghost" :aria-label="t(`sources.webhook.copy.${field}`)" @click="copy(webhook[field])">
            <Copy class="size-3.5" />
          </Button>
        </div>
      </div>
    </template>
  </div>
  <p v-else-if="query.isError.value" class="text-xs [overflow-wrap:anywhere] text-destructive">{{ errorMessage(query.error.value, t) }}</p>
</template>
