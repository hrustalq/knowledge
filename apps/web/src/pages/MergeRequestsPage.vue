<script setup lang="ts">
// The workspace-wide merge-request list (/merge-requests), GitLab-style: status
// tabs with count badges, a filtered search bar, and cards below.
//
// Every narrowing goes to the server. The list is cursor-paginated, so
// filtering the loaded page in the browser would disagree with both the tab
// counts and "Load more" — see mr-filters.ts.
//
// The filter rail on the left is the narrowing's memory: it shows the complete
// narrowing (status and title text included, which the chip bar cannot) and
// stores it under a name. A saved view is addressed by number, and `?view=7`
// restores it — which is why that id is an integer and not a uuid.
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-vue-next'
import type {
  ListWorkspaceMergeRequestsResponse,
  MergeRequestInfo,
  SavedFilter,
} from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { api } from '@/api/client'
import { getFilterRailOpen, getWorkspaceId, setFilterRailOpen } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  PageLayout,
  PageSubRail,
  PageTabs,
  panelId,
  tabId,
  type PageTab,
} from '@/components/layout/page'
import type { ActiveFilter } from '@/components/ui/filter-bar'
import MergeRequestList from '@/components/merge-requests/MergeRequestList.vue'
import MergeRequestSearchBar from '@/components/merge-requests/MergeRequestSearchBar.vue'
import SavedFilterRail from '@/components/merge-requests/SavedFilterRail.vue'
import {
  MR_STATES,
  fromSavedQuery,
  mergeRequestFilterParams,
  type MrState,
} from '@/components/merge-requests/mr-filters'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const state = ref<MrState>('open')
const filters = ref<ActiveFilter[]>([])
const search = ref('')
const cursor = ref<string | undefined>(undefined)

/** The saved view the current narrowing came from, if any. */
const activeViewId = ref<number | null>(null)

/** Accumulated previous pages (reset when the filters change). */
const older = ref<MergeRequestInfo[]>([])

const queryParams = computed(() => ({
  workspaceId: getWorkspaceId(),
  ...(state.value !== 'all' ? { status: state.value } : {}),
  ...mergeRequestFilterParams(filters.value),
  ...(search.value ? { search: search.value } : {}),
  ...(cursor.value ? { cursor: cursor.value } : {}),
}))

/**
 * Narrowing invalidates the pages already stacked up behind it.
 *
 * The status joins the other two here rather than keeping a setter of its own.
 * It narrows exactly as they do, and a separate path was one more place that
 * had to remember `resetPaging()` — which is also what lets the tab strip be an
 * ordinary `v-model` instead of a handler.
 */
watch([filters, search, state], () => resetPaging())

const listQuery = useQuery(
  computed(() => apiQueryOptions('/v1/merge-requests', { query: queryParams.value })),
)

const page = computed(() => listQuery.data.value as ListWorkspaceMergeRequestsResponse | undefined)
const rows = computed(() => [...older.value, ...(page.value?.mergeRequests ?? [])])
const counts = computed(() => page.value?.counts)

function countFor(s: MrState): number {
  const c = counts.value
  if (!c) return 0
  return s === 'all' ? c.open + c.merged + c.closed : c[s]
}

/**
 * The counts are `null` until the first page lands, not 0 — a strip claiming
 * every status holds nothing is a statement, and the only true one while the
 * request is still out is that we do not know yet.
 */
const stateTabs = computed<PageTab<MrState>[]>(() =>
  MR_STATES.map((s) => ({
    key: s,
    label: t(`mr.state${s.charAt(0).toUpperCase()}${s.slice(1)}`),
    count: counts.value ? countFor(s) : null,
  })),
)

const narrowed = computed(
  () => search.value !== '' || state.value !== 'open' || filters.value.some((f) => f.values[0]),
)

/**
 * What the toggle's badge counts: narrowing a closed rail would otherwise hide.
 * The status is deliberately not counted — the tabs above spell it out and
 * carry its own count, so badging it would mark the default view as filtered on
 * arrival. It is still a row in the rail's manifest, because it is part of what
 * a saved filter stores.
 */
const narrowCount = computed(
  () => (search.value ? 1 : 0) + filters.value.filter((f) => f.values[0]).length,
)

function resetPaging() {
  cursor.value = undefined
  older.value = []
}

function loadMore() {
  if (!page.value?.nextCursor) return
  older.value = rows.value
  cursor.value = page.value.nextCursor
}

/**
 * Clear means no narrowing at all, status included — otherwise the button
 * leaves a filter behind and the manifest keeps claiming one is applied.
 */
function clearNarrowing() {
  filters.value = []
  search.value = ''
  state.value = 'all'
  setActiveView(null)
}

// --- saved views ------------------------------------------------------------
/**
 * `?view=` is the saved view's address. It is written with `replace` rather
 * than `push`: applying a view is a change of what you are looking at, not a
 * place you navigated to, and pushing would make Back walk through every view
 * tried on the way to the one you wanted.
 */
function setActiveView(id: number | null) {
  activeViewId.value = id
  const query = { ...route.query }
  if (id === null) delete query.view
  else query.view = String(id)
  void router.replace({ query })
}

function applySaved(filter: SavedFilter) {
  const restored = fromSavedQuery(filter.query)
  state.value = restored.state
  search.value = restored.search
  filters.value = restored.filters
  resetPaging()
  setActiveView(filter.id)
}

/**
 * A `?view=` on arrival. Fetched rather than read from the rail's list so a
 * bookmarked link works on the first frame, before the roster has loaded. A
 * view that is gone (deleted, or someone else's — they are private) leaves the
 * list unfiltered rather than erroring: the link is stale, not the page.
 */
async function restoreFromUrl() {
  const raw = Number(route.query.view)
  if (!Number.isInteger(raw) || raw <= 0) return
  try {
    applySaved(
      (await api.get('/v1/merge-requests/filters/{filterId}', {
        path: { filterId: raw },
      })) as SavedFilter,
    )
  } catch {
    setActiveView(null)
  }
}
void restoreFromUrl()

// --- rail -------------------------------------------------------------------
// Server-rendered from a cookie, like the app rail, so a closed rail does not
// flash open on the first frame before the client can collapse it. It keeps its
// own cookie rather than the layout store's session memory for exactly that
// reason — this one is drawn before any JavaScript runs.
const railOpen = ref(getFilterRailOpen())
watch(railOpen, (open) => setFilterRailOpen(open))
</script>

<template>
  <PageLayout variant="list" :title="t('nav.mergeRequests')" :subtitle="t('mr.listSubtitle')">
    <template #sub-rail>
      <PageSubRail :label="t('filters.applied')" :open="railOpen">
        <SavedFilterRail
          v-model:state="state"
          v-model:search="search"
          v-model:filters="filters"
          :active-id="activeViewId"
          @apply="applySaved"
          @clear="clearNarrowing"
        />
      </PageSubRail>
    </template>

    <template #tabs>
      <PageTabs v-model="state" :tabs="stateTabs" :label="t('filters.status')" />
    </template>

    <div class="flex items-start gap-2">
      <!--
        The toggle sits beside the search bar rather than up by the title:
        the rail starts closed, so this is the only way in, and filtering is
        already what this row is for. It carries its own label for the same
        reason — an unlabelled icon is not somewhere you look for a feature
        you have not met yet.
      -->
      <Button
        variant="outline"
        class="shrink-0"
        :aria-expanded="railOpen"
        :title="railOpen ? t('filters.hideRail') : t('filters.showRail')"
        @click="railOpen = !railOpen"
      >
        <PanelLeftClose v-if="railOpen" />
        <PanelLeftOpen v-else />
        <span class="hidden sm:inline">{{ t('filters.railLabel') }}</span>
        <!-- A closed rail must not take what it was telling you with it. -->
        <span
          v-if="narrowCount"
          class="rounded-full bg-primary px-1.5 text-[0.625rem] leading-4 font-medium tabular-nums text-primary-foreground"
        >
          {{ narrowCount }}
        </span>
      </Button>

      <MergeRequestSearchBar
        v-model:filters="filters"
        v-model:search="search"
        class="min-w-0 flex-1"
      />
    </div>

    <!-- The panel the strip above points at. Naming it is what makes the tabs
         operable by anything other than a mouse: a screen reader follows
         `aria-controls` from the tab to here. -->
    <div
      :id="panelId(state)"
      role="tabpanel"
      :aria-labelledby="tabId(state)"
      class="flex min-w-0 flex-col gap-4"
    >
      <MergeRequestList
        :rows="rows"
        :loading="listQuery.isPending.value && rows.length === 0"
        :narrowed="narrowed"
        @clear="clearNarrowing"
      />

      <div v-if="page?.nextCursor" class="flex justify-center">
        <Button variant="outline" size="sm" :disabled="listQuery.isFetching.value" @click="loadMore">
          {{ listQuery.isFetching.value ? t('common.loading') : t('common.loadMore') }}
        </Button>
      </div>
    </div>
  </PageLayout>
</template>
