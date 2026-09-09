<script setup lang="ts">
// Connectors (docs/features/19): external systems as workspace-configured
// sources and destinations.
//
// Same shell as AiSettingsPage — hand-rolled role="tablist" strip, active tab
// in the query string so a link can point at one, and `canManage` threaded down
// as a prop rather than a route guard (the API enforces the real thing).
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Badge } from '@/components/ui/badge'
import { useAuthStore } from '@/stores/auth'
import ConnectorList from '@/components/connectors/ConnectorList.vue'
import ConnectorRuns from '@/components/connectors/ConnectorRuns.vue'
import ConnectorLinks from '@/components/connectors/ConnectorLinks.vue'

const { t } = useI18n()

// `label` is a message key — resolved with t() where the tab renders.
const TABS = [
  { key: 'connections', label: 'connectors.tabConnections' },
  { key: 'runs', label: 'connectors.tabRuns' },
  { key: 'links', label: 'connectors.tabLinks' },
] as const
type TabKey = (typeof TABS)[number]['key']

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

// Every write endpoint behind this page is @Access('admin', …) except starting
// a sync, so a non-admin is told plainly rather than shown a wall of 403s.
const canManage = computed(() => auth.canAdminWorkspace)

const tab = computed<TabKey>(() => {
  const q = route.query.tab
  return TABS.some((entry) => entry.key === q) ? (q as TabKey) : 'connections'
})

function setTab(key: TabKey) {
  void router.replace({ query: { ...route.query, tab: key } })
}
</script>

<template>
  <!-- One measure for the whole page, as on /settings/ai: otherwise every tab
       switch moves the right-hand edge. -->
  <div class="flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('nav.connectors') }}</h1>
        <p class="text-muted-foreground mt-0.5 text-sm">{{ t('connectors.pageSubtitle') }}</p>
      </div>
      <Badge v-if="!canManage" variant="outline">{{ t('connectors.readOnlyBadge') }}</Badge>
    </div>

    <div class="flex gap-0.5 overflow-x-auto border-b" role="tablist">
      <button
        v-for="tabDef in TABS"
        :key="tabDef.key"
        role="tab"
        :aria-selected="tab === tabDef.key"
        class="focus-visible:ring-ring rounded-t-sm border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none"
        :class="
          tab === tabDef.key
            ? 'border-primary text-primary font-medium'
            : 'text-muted-foreground hover:text-foreground hover:border-border border-transparent'
        "
        @click="setTab(tabDef.key)"
      >
        {{ t(tabDef.label) }}
      </button>
    </div>

    <div class="min-h-0 flex-1">
      <ConnectorList v-if="tab === 'connections'" :can-manage="canManage" />
      <ConnectorRuns v-else-if="tab === 'runs'" :can-manage="canManage" />
      <ConnectorLinks v-else :can-manage="canManage" />
    </div>
  </div>
</template>
