<script setup lang="ts">
// Projects shell: the third-level rail (search → roster → create) with the
// selected project's settings rendered beside it. The roster is an infinite
// query over the cursor-paginated endpoint, virtualized so a workspace with
// hundreds of projects still renders a screenful of rows.
// Editing needs the `editor` role — the API enforces it, this only hides what
// would 403.
import { computed, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { useInfiniteQuery } from '@tanstack/vue-query'
import { useInfiniteScroll, useVirtualList } from '@vueuse/core'
import { Plus } from 'lucide-vue-next'
import type { ListProjectsResponse, ProjectSummary } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import type { ScopeCreated } from '@/lib/scopes'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { Autocomplete, type AutocompleteOption } from '@/components/ui/autocomplete'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import SwitcherCreateDialog from '@/components/layout/SwitcherCreateDialog.vue'

const auth = useAuthStore()
const store = useProjectsStore()
const route = useRoute()
const router = useRouter()

const PAGE_SIZE = 50
/** Row height must match the markup below — the virtualizer positions by it. */
const ROW_HEIGHT = 36

function listUrl(cursor?: string, search?: string): string {
  const params = new URLSearchParams({ workspaceId: getWorkspaceId(), limit: String(PAGE_SIZE) })
  if (cursor) params.set('cursor', cursor)
  if (search) params.set('search', search)
  return `/v1/projects?${params}`
}

const roster = useInfiniteQuery({
  queryKey: ['projects', 'rail'],
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) => apiFetch<ListProjectsResponse>(listUrl(pageParam)),
  getNextPageParam: (last: ListProjectsResponse) => last.nextCursor ?? undefined,
})

const projects = computed<ProjectSummary[]>(() =>
  (roster.data.value?.pages ?? []).flatMap((p) => p.projects),
)

const { list, containerProps, wrapperProps } = useVirtualList(projects, {
  itemHeight: ROW_HEIGHT,
  overscan: 8,
})

useInfiniteScroll(containerProps.ref, async () => { await roster.fetchNextPage() }, {
  distance: ROW_HEIGHT * 4,
  canLoadMore: () => roster.hasNextPage.value && !roster.isFetchingNextPage.value,
})

/** The store backs the sidebar switcher, breadcrumbs and the active marker. */
async function reload() {
  await Promise.all([roster.refetch(), store.fetchList().catch(() => undefined)])
}

// Server-side search — the picker jumps straight to a project.
async function searchProjects(query: string): Promise<AutocompleteOption[]> {
  const res = await apiFetch<ListProjectsResponse>(listUrl(undefined, query.trim() || undefined))
  return res.projects.map((p) => ({ value: p.projectId, label: p.name, meta: p.documentCount }))
}

const picked = ref<string[]>([])
watch(picked, (ids) => {
  const id = ids[0]
  if (!id) return
  picked.value = []
  void router.push(`/settings/projects/${id}`)
})

// Creating is the same flow as everywhere else — the shared dialog, with its
// loader, its inline errors and its skippable follow-up step. This rail only
// decides where to land afterwards: on the new project's own settings, since
// that is the page the user is already standing on.
const creating = ref<'workspace' | 'project' | null>(null)

async function onCreated(created: ScopeCreated) {
  await reload()
  void router.push(`/settings/projects/${created.id}`)
}
</script>

<template>
  <!-- Bleed out of the settings column's padding so this rail sits flush too -->
  <div class="-mx-4 -my-6 flex min-h-0 flex-1 flex-col lg:-mx-8 lg:flex-row">
    <div
      class="flex h-72 shrink-0 flex-col border-b bg-background lg:sticky lg:top-0 lg:h-[calc(100vh-5.75rem)] lg:w-64 lg:self-start lg:border-b-0 lg:border-r"
    >
      <div class="border-b p-2">
        <Autocomplete
          v-model="picked"
          label="Projects"
          placeholder="Search projects…"
          :multiple="false"
          :load="searchProjects"
          empty-hint="No projects in this workspace yet."
        />
      </div>

      <div v-if="roster.isPending.value" class="space-y-1.5 p-2">
        <Skeleton v-for="i in 5" :key="i" class="h-8 w-full" />
      </div>
      <p v-else-if="projects.length === 0" class="p-3 text-xs text-muted-foreground">
        No projects yet.
      </p>
      <!-- Virtualized roster: the only part of the rail that scrolls. -->
      <div v-else v-bind="containerProps" class="min-h-0 flex-1">
        <ul v-bind="wrapperProps">
          <li v-for="{ data: p } in list" :key="p.projectId">
            <RouterLink
              :to="`/settings/projects/${p.projectId}`"
              class="flex items-center gap-2 px-3 text-sm transition-colors"
              :style="{ height: `${ROW_HEIGHT}px` }"
              :class="route.params.id === p.projectId
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-foreground/80 hover:bg-accent hover:text-foreground'"
            >
              <span
                class="size-1.5 shrink-0 rounded-full"
                :class="p.projectId === store.activeId ? 'bg-primary' : 'bg-muted-foreground/30'"
                :title="p.projectId === store.activeId ? 'Active project' : undefined"
              />
              <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
              <span class="shrink-0 text-xs text-muted-foreground">{{ p.documentCount }}</span>
            </RouterLink>
          </li>
        </ul>
      </div>

      <!-- Create sits at the foot of the rail, below its own divider. -->
      <div v-if="auth.canEdit" class="mt-auto shrink-0 border-t p-2">
        <Button
          variant="outline"
          size="sm"
          class="w-full justify-start gap-2"
          @click="creating = 'project'"
        >
          <Plus class="size-4" />
          New project
        </Button>
      </div>
    </div>

    <div class="flex min-h-0 min-w-0 flex-1 flex-col px-4 py-6 lg:px-8">
      <RouterView @changed="reload" />
    </div>

    <SwitcherCreateDialog :kind="creating" @update:kind="creating = $event" @created="onCreated" />
  </div>
</template>
