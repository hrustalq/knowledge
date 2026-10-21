<script setup lang="ts">
/**
 * The tracker side of one knowledge object (#424): the tickets it was handed
 * off as, and — for an editor — "Send to tracker".
 *
 * A chip is the ticket's key and its status in our vocabulary
 * (`BILL-123 · In progress`), linking out to the tracker, which is the task
 * list; there is no board here. Status is said in words, the dot only echoes
 * it. A transition the sweeper gave up on turns the chip into the tracker's
 * error with a Retry, because a silent failure here is a report that never
 * closes.
 *
 * Renders nothing for a reader with no tickets to show: an object that was
 * never handed off is the normal state, not an empty one.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { AlertTriangle, ExternalLink, RotateCw, Send } from 'lucide-vue-next'
import type {
  ConnectorWorkItemInfo,
  ListAnchorWorkItemsResponse,
  ListConnectorsResponse,
  WorkItemSourceKind,
} from '@knowledge/contracts'
import { connectorKindInfo } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ResponsivePopover } from '@/components/ui/popover'

const props = defineProps<{
  sourceKind: WorkItemSourceKind
  sourceId: string
  /** Editor on the object's page: may hand it off and retry a failed sync. */
  canHandoff: boolean
}>()

const { t } = useI18n()
const workspaceId = getWorkspaceId()

const query = useQuery(
  computed(() =>
    apiQueryOptions('/v1/work-items', {
      query: { workspaceId, sourceKind: props.sourceKind, sourceId: props.sourceId },
    }),
  ),
)
const items = computed(() => (query.data.value as ListAnchorWorkItemsResponse | undefined)?.workItems ?? [])

const open = ref(false)
// The connector list is only needed once someone opens the panel.
const connectorsQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/connectors', { query: { workspaceId } }),
    enabled: open.value,
  })),
)
const trackers = computed(() =>
  ((connectorsQuery.data.value as ListConnectorsResponse | undefined)?.connectors ?? []).filter(
    (c) => c.enabled && connectorKindInfo(c.kind)?.capabilities.tasks && !items.value.some((i) => i.connectorId === c.id),
  ),
)

const connectorId = ref('')
const attach = ref('')
const error = ref<string | null>(null)
watch(trackers, (list) => {
  if (!list.some((c) => c.id === connectorId.value)) connectorId.value = list[0]?.id ?? ''
})
watch(open, (now) => {
  if (now) error.value = null
})

const invalidates = () => [['/v1/work-items']]
const handoff = useApiMutation('post', '/v1/work-items/handoff', { invalidates })
const retry = useApiMutation('post', '/v1/connectors/{id}/work-items/{workItemId}/retry', { invalidates })

async function send() {
  if (!connectorId.value || handoff.isPending.value) return
  error.value = null
  try {
    await handoff.mutateAsync({
      body: {
        workspaceId,
        sourceKind: props.sourceKind,
        sourceId: props.sourceId,
        connectorId: connectorId.value,
        ...(attach.value.trim() ? { attach: attach.value.trim() } : {}),
      },
    })
    toast.success(t(attach.value.trim() ? 'workItems.attached' : 'workItems.created'))
    attach.value = ''
    open.value = false
  } catch (e) {
    // Said in the panel, next to the field it is usually about.
    error.value = errorMessage(e, t)
  }
}

async function retryItem(item: ConnectorWorkItemInfo) {
  try {
    await retry.mutateAsync({ path: { id: item.connectorId, workItemId: item.id } })
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

const broken = (item: ConnectorWorkItemInfo) => item.syncState === 'failed' || item.syncState === 'orphaned'

/** The dot echoes the status word; it never carries it alone. */
const dot: Record<ConnectorWorkItemInfo['status'], string> = {
  open: 'bg-muted-foreground/60',
  in_progress: 'bg-panel-note',
  done: 'bg-panel-tip',
  wont_do: 'bg-muted-foreground/30',
}
</script>

<template>
  <div v-if="items.length || canHandoff" class="flex flex-wrap items-center gap-1.5 text-xs">
    <template v-for="item in items" :key="item.id">
      <span
        v-if="broken(item)"
        class="inline-flex max-w-full items-center gap-1 rounded-full border border-destructive/40 px-2 py-0.5 text-destructive"
        :title="item.syncError ?? undefined"
      >
        <AlertTriangle class="size-3 shrink-0" aria-hidden="true" />
        <a :href="item.url" target="_blank" rel="noopener noreferrer" class="font-medium tabular-nums hover:underline">{{ item.key }}</a>
        <span class="truncate">· {{ t(`workItems.sync.${item.syncState}`) }}</span>
        <button
          v-if="canHandoff"
          type="button"
          class="-mr-1 inline-flex size-5 items-center justify-center rounded-full hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
          :disabled="retry.isPending.value"
          :aria-label="t('workItems.retry', { key: item.key })"
          @click="retryItem(item)"
        >
          <RotateCw class="size-3" aria-hidden="true" />
        </button>
      </span>
      <a
        v-else
        :href="item.url"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        :title="item.externalStatus ? t('workItems.trackerSays', { status: item.externalStatus }) : undefined"
      >
        <span class="size-1.5 shrink-0 rounded-full" :class="dot[item.status]" aria-hidden="true" />
        <span class="font-medium tabular-nums">{{ item.key }}</span>
        <span class="truncate text-muted-foreground">
          · {{ t(`workItems.status.${item.status}`) }}<template v-if="item.syncState === 'pending'"> · {{ t('workItems.sync.pending') }}</template>
        </span>
        <ExternalLink class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </a>
    </template>

    <ResponsivePopover
      v-if="canHandoff"
      v-model:open="open"
      :title="t('workItems.sendTitle')"
      :description="t('workItems.sendHint')"
      side="bottom"
      panel-class="w-80"
    >
      <template #trigger>
        <Button variant="ghost" size="sm" class="h-6 gap-1 px-1.5 text-xs text-muted-foreground">
          <Send class="size-3" aria-hidden="true" />
          {{ t('workItems.send') }}
        </Button>
      </template>
      <form class="space-y-3 text-sm" @submit.prevent="send">
        <p v-if="connectorsQuery.isPending.value" class="text-xs text-muted-foreground">{{ t('common.loading') }}</p>
        <p v-else-if="!trackers.length" class="text-xs text-muted-foreground">
          {{ items.length ? t('workItems.everyTracker') : t('workItems.noTrackers') }}
        </p>
        <template v-else>
          <div class="space-y-1">
            <Label :for="`wi-connector-${sourceId}`" class="text-xs">{{ t('workItems.tracker') }}</Label>
            <select
              :id="`wi-connector-${sourceId}`"
              v-model="connectorId"
              class="h-8 w-full rounded-md border bg-transparent px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
            >
              <option v-for="c in trackers" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </div>
          <div class="space-y-1">
            <Label :for="`wi-attach-${sourceId}`" class="text-xs">{{ t('workItems.attachLabel') }}</Label>
            <Input
              :id="`wi-attach-${sourceId}`"
              v-model="attach"
              class="h-8"
              :placeholder="t('workItems.attachPlaceholder')"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <p v-if="error" class="text-xs text-destructive" role="alert">{{ error }}</p>
          <Button type="submit" size="sm" class="w-full" :disabled="!connectorId || handoff.isPending.value">
            {{ handoff.isPending.value ? t('workItems.sending') : attach.trim() ? t('workItems.attach') : t('workItems.create') }}
          </Button>
        </template>
      </form>
    </ResponsivePopover>
  </div>
</template>
