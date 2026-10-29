<script setup lang="ts">
// Connectors (docs/features/19): external systems as workspace-configured
// sources and destinations.
//
// Same shell as AiSettingsPage — the shared PageTabs strip, active tab in the
// query string so a link can point at one, and `canManage` threaded down as a
// prop rather than a route guard (the API enforces the real thing).
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { Badge } from '@/shared/ui/badge'
import { PageTabs, panelId, tabId, usePageTabs, type PageTab } from '@/widgets/page'
import { useAuthStore } from '@/stores/auth'
import ConnectorList from '@/modules/connectors/components/ConnectorList.vue'
import ConnectionList from '@/modules/connectors/components/ConnectionList.vue'
import ConnectorRuns from '@/modules/connectors/components/ConnectorRuns.vue'
import ConnectorLinks from '@/modules/connectors/components/ConnectorLinks.vue'

const { t } = useI18n()

// `connections` are the accounts connectors dial through (#564); the first
// tab, which lists the connectors themselves, carries their name.
type TabKey = 'connectors' | 'connections' | 'runs' | 'links'
const tabs = computed<PageTab<TabKey>[]>(() => [
  { key: 'connectors', label: t('connectors.tabConnectors') },
  { key: 'connections', label: t('connectors.tabConnections') },
  { key: 'runs', label: t('connectors.tabRuns') },
  { key: 'links', label: t('connectors.tabLinks') },
])
const tab = usePageTabs(tabs, 'connectors')

const auth = useAuthStore()

// Every write endpoint behind this page is @Access('admin', …) except starting
// a sync, so a non-admin is told plainly rather than shown a wall of 403s.
const canManage = computed(() => auth.canAdminWorkspace)
</script>

<template>
  <!-- Fills the column, as /settings/ai does: the connection rows, the run
       table and the link list are all row-shaped, and a row spends width on
       the things it lists rather than on a gutter beside them. -->
  <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('nav.connectors') }}</h1>
        <p class="text-muted-foreground mt-0.5 text-sm">{{ t('connectors.pageSubtitle') }}</p>
      </div>
      <Badge v-if="!canManage" variant="outline">{{ t('connectors.readOnlyBadge') }}</Badge>
    </div>

    <PageTabs v-model="tab" :tabs="tabs" :label="t('connectors.tabsLabel')" />

    <div :id="panelId(tab)" role="tabpanel" :aria-labelledby="tabId(tab)" class="min-h-0 flex-1">
      <ConnectorList v-if="tab === 'connectors'" :can-manage="canManage" />
      <ConnectionList v-else-if="tab === 'connections'" :can-manage="canManage" />
      <ConnectorRuns v-else-if="tab === 'runs'" :can-manage="canManage" />
      <ConnectorLinks v-else :can-manage="canManage" />
    </div>
  </div>
</template>
