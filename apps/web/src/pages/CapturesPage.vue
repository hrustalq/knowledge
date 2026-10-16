<script setup lang="ts">
// The captures inbox (/captures, issue #73): what coding agents proposed from
// their sessions, by where it stands.
//
// The tabs are stored statuses, not the derived state. A capture whose merge
// request merged still lives under Proposed, badged "merged" — it was proposed,
// and the merge request is where it was decided. Staged is the tab that asks
// for something: a glossary term waiting on approval, or a capture that has not
// reached a merge request yet.
//
// Workspace-wide, like the merge-request list, with the project as a filter
// rather than a scope: a reviewer clearing what agents proposed should not have
// to switch projects to find the rest of it. Every narrowing goes to the
// server, because the list is cursor-paginated.
//
// Live: a `capture.*` frame, and any `merge-request.*` frame (a capture's
// merged/closed is its merge request's), invalidate `/v1/captures` through the
// live-cache rules — so there is no store to rescope and nothing to poll.
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { BookmarkPlus, SearchX } from 'lucide-vue-next'
import { CAPTURE_KINDS, type CaptureInfo, type CaptureKind, type ListCapturesResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageLayout, PageState, PageTabs, panelId, tabId, usePageTabs, type PageTab } from '@/components/layout/page'
import CaptureRow from '@/components/captures/CaptureRow.vue'
import { CAPTURE_TABS, type CaptureTab } from '@/components/captures/capture-ui'

const { t } = useI18n()
const auth = useAuthStore()
const projects = useProjectsStore()

const ALL = 'all'

const tabs = computed<PageTab<CaptureTab>[]>(() =>
  CAPTURE_TABS.map((key) => ({ key, label: t(`captures.tab.${key}`) })),
)
// `?tab=` opens a tab; bare `/captures` lands on Staged, the only tab that
// asks for anything.
const tab = usePageTabs(tabs, 'staged')

const kind = ref<CaptureKind | typeof ALL>(ALL)
const projectId = ref<string>(ALL)
const mine = ref(false)
const cursor = ref<string | undefined>(undefined)
const older = ref<CaptureInfo[]>([])

const queryParams = computed(() => ({
  workspaceId: getWorkspaceId(),
  status: tab.value,
  ...(kind.value !== ALL ? { kind: kind.value } : {}),
  ...(projectId.value !== ALL ? { projectId: projectId.value } : {}),
  ...(mine.value ? { mine: 'true' } : {}),
  ...(cursor.value ? { cursor: cursor.value } : {}),
}))

watch([tab, kind, projectId, mine], () => {
  cursor.value = undefined
  older.value = []
})

const listQuery = useQuery(computed(() => apiQueryOptions('/v1/captures', { query: queryParams.value })))
const page = computed(() => listQuery.data.value as ListCapturesResponse | undefined)
const rows = computed(() => [...older.value, ...(page.value?.captures ?? [])])

function loadMore() {
  if (!page.value?.nextCursor) return
  older.value = rows.value
  cursor.value = page.value.nextCursor
}

const narrowed = computed(() => kind.value !== ALL || projectId.value !== ALL || mine.value)
function clearNarrowing() {
  kind.value = ALL
  projectId.value = ALL
  mine.value = false
}

const projectNames = computed(() => new Map(projects.items.map((p) => [p.projectId, p.name])))
</script>

<template>
  <PageLayout variant="list" :title="t('nav.captures')" :subtitle="t('captures.subtitle')">
    <template #tabs>
      <PageTabs v-model="tab" :tabs="tabs" :label="t('filters.status')" />
    </template>

    <!-- Three narrowings, each one a query param the API serves. -->
    <div class="flex flex-wrap items-center gap-2">
      <Select v-model="kind">
        <SelectTrigger class="h-8 w-auto min-w-36 text-sm" :aria-label="t('captures.filter.kind')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL">{{ t('captures.filter.allKinds') }}</SelectItem>
          <SelectItem v-for="k in CAPTURE_KINDS" :key="k" :value="k">{{ t(`captures.kind.${k}`) }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="projectId">
        <SelectTrigger class="h-8 w-auto min-w-36 text-sm" :aria-label="t('captures.filter.project')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL">{{ t('captures.filter.allProjects') }}</SelectItem>
          <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</SelectItem>
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="sm"
        :aria-pressed="mine"
        :class="mine && 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'"
        @click="mine = !mine"
      >
        {{ t('captures.filter.mine') }}
      </Button>
      <Button v-if="narrowed" variant="ghost" size="sm" @click="clearNarrowing">{{ t('captures.filter.clear') }}</Button>
    </div>

    <div :id="panelId(tab)" role="tabpanel" :aria-labelledby="tabId(tab)" class="flex min-w-0 flex-col gap-2">
      <PageState v-if="listQuery.isPending.value && rows.length === 0" state="loading" :rows="3" row-class="h-20" />
      <PageState v-else-if="listQuery.isError.value" state="error" :error="listQuery.error.value" />
      <PageState
        v-else-if="rows.length === 0 && narrowed"
        state="empty"
        :icon="SearchX"
        :title="t('captures.empty.narrowedTitle')"
        :description="t('captures.empty.narrowedHint')"
      />
      <PageState
        v-else-if="rows.length === 0"
        state="empty"
        :icon="BookmarkPlus"
        :title="t(`captures.empty.${tab}.title`)"
        :description="t(`captures.empty.${tab}.hint`)"
      />

      <template v-else>
        <CaptureRow
          v-for="c in rows"
          :key="c.captureId"
          :capture="c"
          :project-name="projectNames.get(c.projectId)"
          :can-decide="auth.canEdit"
        />
        <div v-if="page?.nextCursor" class="flex justify-center pt-2">
          <Button variant="outline" size="sm" :disabled="listQuery.isFetching.value" @click="loadMore">
            {{ listQuery.isFetching.value ? t('common.loading') : t('common.loadMore') }}
          </Button>
        </div>
      </template>
    </div>
  </PageLayout>
</template>
