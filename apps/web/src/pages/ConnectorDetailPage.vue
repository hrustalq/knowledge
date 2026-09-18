<script setup lang="ts">
/**
 * One connector, as something you read and operate (docs/features/32).
 *
 * The counterpart to the card on `/settings/connectors`, which is the form you
 * configure it in — the split feature 24 already made between `/projects/:id`
 * and `/settings/projects/:id`. Configuration stays in the setup dialog, and
 * this page is where you watch what the connection is actually doing.
 *
 * Main column is the tabs, rail is the facts about the connection — the split
 * `PageLayout variant="detail"` exists to make, and the one the document page
 * uses. The work-items tab is the widest thing here, which is why the page is
 * top-level rather than a settings child: a settings nav beside a table of
 * issues is a column of links nobody follows from here.
 */
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useQuery } from '@tanstack/vue-query'
import { CircleAlert, GitPullRequest, Link2, RefreshCw, ScrollText } from 'lucide-vue-next'
import { connectorKindInfo } from '@knowledge/contracts'
import type {
  ConnectorResponse,
  ListConnectorLinksResponse,
  ListConnectorRunsResponse,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { PageLayout, PageState, PageTabs, panelId, tabId, usePageTabs } from '@/components/layout/page'
import type { PageTab } from '@/components/layout/page'
import ConnectorWorkItems from '@/components/connectors/ConnectorWorkItems.vue'
import { RUN_STATUS_CLASS, RUN_STATUS_LABEL } from '@/components/connectors/connector-ui'
import { useAuthStore } from '@/stores/auth'
import { relativeTime } from '@/lib/api'
import { formatDateTime } from '@/lib/format'

type TabKey = 'work-items' | 'links' | 'runs'

const route = useRoute()
const { t } = useI18n()
const auth = useAuthStore()

const connectorId = computed(() => route.params.id as string)
const canManage = computed(() => auth.canAdminWorkspace)

const detail = useQuery(
  computed(() => apiQueryOptions('/v1/connectors/{id}', { path: { id: connectorId.value } })),
)
const connector = computed(() => (detail.data.value as ConnectorResponse | undefined)?.connector)

/**
 * Work items are only a thing on a connector whose kind has them, so the tab
 * is absent rather than empty — the rule `visibleWidgets` follows on the
 * document page. `usePageTabs` falls back when `?tab=` names a tab that is not
 * in the list, so an old link to a hidden tab lands somewhere real.
 */
const tabs = computed<PageTab<TabKey>[]>(() => {
  const list: PageTab<TabKey>[] = []
  if (connector.value?.capabilities.tasks) {
    list.push({ key: 'work-items', label: t('connectors.tabWorkItems'), icon: GitPullRequest })
  }
  list.push({ key: 'links', label: t('connectors.tabLinks'), icon: Link2, count: connector.value?.linkCount ?? null })
  list.push({ key: 'runs', label: t('connectors.tabRuns'), icon: ScrollText })
  return list
})
const tab = usePageTabs<TabKey>(tabs, 'links')

// Links and runs load only when their tab is open: this page's reason to exist
// is the work-items table, and two list requests nobody asked for would delay it.
const links = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/connectors/{id}/links', { path: { id: connectorId.value } }),
    enabled: tab.value === 'links',
  })),
)
const linkRows = computed(() => (links.data.value as ListConnectorLinksResponse | undefined)?.links ?? [])

const runs = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/connectors/{id}/runs', { path: { id: connectorId.value } }),
    enabled: tab.value === 'runs',
    // A run in flight advances; this is a live view of it, like the Runs tab.
    refetchInterval: 4000,
  })),
)
const runRows = computed(() => (runs.data.value as ListConnectorRunsResponse | undefined)?.runs ?? [])

const sync = useApiMutation('post', '/v1/connectors/{id}/sync', {
  invalidates: () => [['/v1/connectors'], ['/v1/connectors/{id}/runs']],
})

async function startSync(direction: 'pull' | 'push') {
  try {
    await sync.mutateAsync({ path: { id: connectorId.value }, body: { direction } })
    toast.success(t('connectors.syncStarted'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

// The route component is reused across ids, so a navigation between two
// connectors has to reset the tab-scoped queries rather than show the last one's.
watch(connectorId, () => {
  void links.refetch()
  void runs.refetch()
})
</script>

<template>
  <PageState v-if="detail.isError.value" state="error" :error="detail.error.value" />
  <div v-else-if="!connector" class="space-y-4">
    <Skeleton class="h-9 w-64" />
    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <Skeleton class="h-64 w-full" />
      <Skeleton class="h-40 w-full" />
    </div>
  </div>

  <PageLayout v-else variant="detail" :title="connector.name">
    <template #status>
      <Badge variant="outline">{{ connectorKindInfo(connector.kind)?.label ?? connector.kind }}</Badge>
      <Badge v-if="!connector.enabled" variant="outline">{{ t('connectors.disabled') }}</Badge>
    </template>

    <template #actions>
      <Button
        v-if="connector.capabilities.pull && connector.direction !== 'push'"
        size="sm"
        variant="outline"
        :disabled="sync.isPending.value"
        @click="startSync('pull')"
      >
        <RefreshCw class="size-3.5" /> {{ t('connectors.syncNow') }}
      </Button>
      <Button
        v-if="connector.capabilities.push && connector.direction !== 'pull'"
        size="sm"
        variant="outline"
        :disabled="sync.isPending.value"
        @click="startSync('push')"
      >
        {{ t('connectors.pushNow') }}
      </Button>
    </template>

    <template #tabs>
      <PageTabs v-model="tab" :tabs="tabs" :label="t('connectors.tabsLabel')" />
    </template>

    <template #rail>
      <aside class="space-y-3">
        <div class="rounded-lg border p-4">
          <h2 class="mb-3 text-sm font-medium">{{ t('connectors.overview') }}</h2>
          <dl class="space-y-2 text-sm">
            <div class="flex justify-between gap-3">
              <dt class="text-muted-foreground">{{ t('connectors.fieldDirection') }}</dt>
              <dd>
                {{
                  t(
                    `connectors.direction${
                      connector.direction === 'both' ? 'Both' : connector.direction === 'push' ? 'Push' : 'Pull'
                    }`,
                  )
                }}
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-muted-foreground">{{ t('connectors.fieldSchedule') }}</dt>
              <dd>
                {{
                  connector.syncIntervalMinutes
                    ? t(
                        'connectors.everyMinutes',
                        { count: connector.syncIntervalMinutes },
                        connector.syncIntervalMinutes,
                      )
                    : t('connectors.manualOnly')
                }}
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-muted-foreground">{{ t('connectors.fieldLastSync') }}</dt>
              <dd>
                <template v-if="connector.lastSyncedAt">
                  <span :title="formatDateTime(connector.lastSyncedAt)">
                    {{ relativeTime(connector.lastSyncedAt) }}
                  </span>
                </template>
                <span v-else class="text-muted-foreground">{{ t('connectors.never') }}</span>
              </dd>
            </div>
            <div v-if="connector.lastRun" class="flex justify-between gap-3">
              <dt class="text-muted-foreground">{{ t('connectors.fieldLastRun') }}</dt>
              <dd :class="RUN_STATUS_CLASS[connector.lastRun.status]">
                {{ t(RUN_STATUS_LABEL[connector.lastRun.status]) }}
              </dd>
            </div>
          </dl>

          <p v-if="connector.lastRun?.error" class="text-destructive mt-3 flex gap-1.5 text-xs">
            <CircleAlert class="mt-0.5 size-3.5 shrink-0" />
            {{ connector.lastRun.error.message }}
          </p>
        </div>

        <!-- Said once, on the connector, rather than as an empty state inside a
             tab that is not offered: the reason there is no Work items tab is a
             property of the connection, not of this moment. -->
        <p v-if="!connector.capabilities.tasks" class="text-muted-foreground px-1 text-xs">
          {{ t('connectors.workItemsUnsupported') }}
        </p>
      </aside>
    </template>

    <div :id="panelId(tab)" role="tabpanel" :aria-labelledby="tabId(tab)" class="min-w-0">
      <ConnectorWorkItems v-if="tab === 'work-items'" :connector-id="connectorId" :can-manage="canManage" />

      <div v-else-if="tab === 'links'">
        <PageState v-if="links.isPending.value" state="loading" />
        <PageState v-else-if="!linkRows.length" state="empty" :title="t('connectors.linksEmpty')" />
        <ul v-else class="divide-y rounded-lg border">
          <li v-for="link in linkRows" :key="link.id" class="flex items-center justify-between gap-3 p-3 text-sm">
            <RouterLink :to="`/documents/${link.documentId}`" class="min-w-0 truncate hover:underline">
              {{ link.documentTitle ?? link.externalTitle ?? link.externalId }}
            </RouterLink>
            <a
              v-if="link.externalUrl"
              :href="link.externalUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="text-muted-foreground shrink-0 text-xs hover:underline"
            >
              {{ t('connectors.openExternal') }}
            </a>
          </li>
        </ul>
      </div>

      <div v-else>
        <PageState v-if="runs.isPending.value" state="loading" />
        <PageState v-else-if="!runRows.length" state="empty" :title="t('connectors.runsEmpty')" />
        <ul v-else class="divide-y rounded-lg border">
          <li v-for="run in runRows" :key="run.id" class="flex items-center justify-between gap-3 p-3 text-sm">
            <RouterLink :to="`/settings/connectors/runs/${run.id}`" class="min-w-0 hover:underline">
              <span :class="RUN_STATUS_CLASS[run.status]">{{ t(RUN_STATUS_LABEL[run.status]) }}</span>
              <span class="text-muted-foreground ml-2 text-xs">
                {{ t('connectors.runCounts', { created: run.created, updated: run.updated, skipped: run.skipped }) }}
              </span>
            </RouterLink>
            <span class="text-muted-foreground shrink-0 text-xs" :title="formatDateTime(run.createdAt)">
              {{ relativeTime(run.createdAt) }}
            </span>
          </li>
        </ul>
      </div>
    </div>
  </PageLayout>
</template>
