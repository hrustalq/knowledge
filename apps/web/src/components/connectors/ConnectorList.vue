<script setup lang="ts">
// The Connections tab (docs/features/19): one card per configured connection.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { CircleCheck, CircleDashed, CircleX, Plug, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-vue-next'
import { connectorKindInfo } from '@knowledge/contracts'
import type { ConnectorSummary, ListConnectorsResponse } from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import AiEmptyState from '@/components/ai/AiEmptyState.vue'
import { getWorkspaceId } from '@/lib/api'
import { relativeTime } from '@/lib/api'
import ConnectorSetupDialog from './ConnectorSetupDialog.vue'

defineProps<{ canManage: boolean }>()

const { t } = useI18n()
const workspaceId = getWorkspaceId()
const queryClient = useQueryClient()

const query = useQuery(apiQueryOptions('/v1/connectors', { query: { workspaceId } }))
const connectors = computed(() => (query.data.value as ListConnectorsResponse | undefined)?.connectors ?? [])

const invalidates = () => [['/v1/connectors']]
const remove = useApiMutation('delete', '/v1/connectors/{id}', { invalidates })
const sync = useApiMutation('post', '/v1/connectors/{id}/sync', { invalidates })

const open = ref(false)
const editing = ref<ConnectorSummary | null>(null)
const testing = ref<string | null>(null)

function openNew() {
  editing.value = null
  open.value = true
}
function openEdit(connector: ConnectorSummary) {
  editing.value = connector
  open.value = true
}

async function runTest(connector: ConnectorSummary) {
  testing.value = connector.id
  try {
    const res = (await api.post('/v1/connectors/{id}/test', { path: { id: connector.id } })) as {
      ok: boolean
      detail: string | null
    }
    if (res.ok) toast.success(res.detail ?? t('connectors.testOk'))
    else toast.error(res.detail ?? t('connectors.testFailed'))
    await queryClient.invalidateQueries({ queryKey: ['/v1/connectors'] })
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    testing.value = null
  }
}

async function startSync(connector: ConnectorSummary, direction: 'pull' | 'push') {
  try {
    await sync.mutateAsync({ path: { id: connector.id }, body: { direction } })
    toast.success(t('connectors.syncStarted'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function confirmRemove(connector: ConnectorSummary) {
  try {
    await remove.mutateAsync({ path: { id: connector.id } })
    toast.success(t('connectors.deleted'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/** Tri-state, driven off the last run — the AiProvidersSection status dot. */
function statusIcon(connector: ConnectorSummary) {
  const status = connector.lastRun?.status
  if (status === 'succeeded') return { icon: CircleCheck, class: 'text-emerald-500' }
  if (status === 'failed' || status === 'partial') return { icon: CircleX, class: 'text-destructive' }
  return { icon: CircleDashed, class: 'text-muted-foreground' }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <p class="text-muted-foreground text-sm">
        {{ t('connectors.count', { count: connectors.length }, connectors.length) }}
      </p>
      <Button v-if="canManage && connectors.length" size="sm" @click="openNew">
        <Plus class="size-3.5" /> {{ t('connectors.add') }}
      </Button>
    </div>

    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton v-for="i in 2" :key="i" class="h-24 w-full" />
    </div>

    <AiEmptyState
      v-else-if="!connectors.length"
      :icon="Plug"
      :title="t('connectors.emptyTitle')"
      :body="t('connectors.emptyBody')"
      :example="{
        label: t('connectors.emptyExampleLabel'),
        lines: ['Confluence — https://team.atlassian.net/wiki + space key', 'Notion — an internal integration secret', 'Obsidian vault — its git repository URL'],
      }"
    >
      <template #action>
        <Button v-if="canManage" size="sm" @click="openNew">
          <Plus class="size-3.5" /> {{ t('connectors.add') }}
        </Button>
        <p v-else class="text-muted-foreground text-xs">{{ t('connectors.emptyNotAdmin') }}</p>
      </template>
    </AiEmptyState>

    <ul v-else class="space-y-3">
      <li v-for="connector in connectors" :key="connector.id" class="rounded-lg border p-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <component :is="statusIcon(connector).icon" class="size-4 shrink-0" :class="statusIcon(connector).class" />
              <!-- The name opens the connector rather than its settings form
                   (docs/features/32): reading what a connection is doing is the
                   common errand, configuring it the rare one, and the detail
                   page carries Configure as an action of its own. -->
              <RouterLink
                :to="`/settings/connectors/${connector.id}`"
                class="truncate text-sm font-medium hover:underline"
              >
                {{ connector.name }}
              </RouterLink>
              <Badge variant="outline">{{ connectorKindInfo(connector.kind)?.label ?? connector.kind }}</Badge>
              <Badge v-if="!connector.enabled" variant="outline">{{ t('connectors.disabled') }}</Badge>
            </div>
            <p class="text-muted-foreground mt-1 text-xs">
              {{ t(`connectors.direction${connector.direction === 'both' ? 'Both' : connector.direction === 'push' ? 'Push' : 'Pull'}`) }}
              ·
              {{ t('connectors.linkCount', { count: connector.linkCount }, connector.linkCount) }}
              <template v-if="connector.lastSyncedAt"> · {{ relativeTime(connector.lastSyncedAt) }}</template>
              <template v-if="connector.syncIntervalMinutes">
                · {{ t('connectors.everyMinutes', { count: connector.syncIntervalMinutes }, connector.syncIntervalMinutes) }}
              </template>
            </p>
          </div>

          <div class="flex shrink-0 items-center gap-1.5">
            <Button
              v-if="connector.capabilities.pull && connector.direction !== 'push'"
              size="sm"
              variant="outline"
              :disabled="sync.isPending.value"
              @click="startSync(connector, 'pull')"
            >
              <RefreshCw class="size-3.5" /> {{ t('connectors.syncNow') }}
            </Button>
            <Button
              v-if="connector.capabilities.push && connector.direction !== 'pull'"
              size="sm"
              variant="outline"
              :disabled="sync.isPending.value"
              @click="startSync(connector, 'push')"
            >
              {{ t('connectors.pushNow') }}
            </Button>
            <Button
              v-if="canManage"
              size="sm"
              variant="ghost"
              :disabled="testing === connector.id"
              @click="runTest(connector)"
            >
              {{ t('connectors.test') }}
            </Button>
            <!-- The name now opens the connector, so configuring it needs a
                 control of its own rather than being the card's default click. -->
            <Button
              v-if="canManage"
              size="sm"
              variant="ghost"
              :aria-label="t('connectors.configure')"
              @click="openEdit(connector)"
            >
              <Settings2 class="size-3.5" />
            </Button>
            <Button v-if="canManage" size="sm" variant="ghost" @click="confirmRemove(connector)">
              <Trash2 class="text-destructive size-3.5" />
            </Button>
          </div>
        </div>

        <p v-if="connector.lastRun?.error" class="text-destructive mt-2 text-xs">
          {{ connector.lastRun.error.message }}
        </p>
      </li>
    </ul>

    <ConnectorSetupDialog v-model:open="open" :editing="editing" />
  </div>
</template>
