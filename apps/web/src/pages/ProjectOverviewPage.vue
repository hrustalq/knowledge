<script setup lang="ts">
/**
 * A project, as something you read (docs/features/24).
 *
 * There was nowhere to see what a project *was*. `/settings/projects/:id` is a
 * form — two inputs and a delete button — and the sidebar knows only a name and
 * a page count. A project holds the pages, the glossary, the connectors and
 * most of the work, and none of that had a home.
 *
 * Shaped like the document page (feature 15) on purpose: the main column is the
 * thing itself — what this project is for, and what has been written in it —
 * and every fact *about* it lives in a rail of collapsible widgets, each folded
 * to the one number that decides whether to open it. Two pages that answer "what
 * is this" should not need to be learned twice.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import {
  Activity as ActivityIcon,
  BookMarked,
  FileText,
  GitMerge,
  Info,
  Plug,
  Users,
  Workflow as WorkflowIcon,
} from 'lucide-vue-next'
import type { ListActivityResponse, ProjectOverviewResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId, relativeTime } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import RailSection from '@/components/knowledge/RailSection.vue'
import ActivityFeed from '@/components/knowledge/ActivityFeed.vue'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import UserChip from '@/components/people/UserChip.vue'
import ProjectAvatar from '@/components/projects/ProjectAvatar.vue'
import { useProjectsStore } from '@/stores/projects'

const { t } = useI18n()
const route = useRoute()
const projects = useProjectsStore()

const RAIL_WIDGETS = [
  { id: 'overview', label: t('rail.overview'), icon: Info, expandable: false },
  { id: 'people', label: t('rail.people'), icon: Users, expandable: false },
  { id: 'activity', label: t('rail.activity'), icon: ActivityIcon, expandable: true },
  { id: 'merge-requests', label: t('rail.changes'), icon: GitMerge, expandable: false },
  { id: 'glossary', label: t('rail.glossary'), icon: BookMarked, expandable: false },
  { id: 'connectors', label: t('rail.connectors'), icon: Plug, expandable: false },
  { id: 'workflows', label: t('rail.workflows'), icon: WorkflowIcon, expandable: false },
] as const
type RailWidget = (typeof RAIL_WIDGETS)[number]['id']

const projectId = computed(() => route.params.id as string)

const overviewQuery = useQuery(
  computed(() =>
    apiQueryOptions('/v1/projects/{id}/overview', { path: { id: projectId.value } }),
  ),
)
const data = computed(() => overviewQuery.data.value as ProjectOverviewResponse | undefined)
const project = computed(() => data.value?.project)

/** One light query for the rail's activity row — a timestamp, not the feed. */
const activityPreview = useQuery(
  computed(() =>
    apiQueryOptions('/v1/activity', {
      query: { workspaceId: getWorkspaceId(), projectId: projectId.value, limit: '1' },
    }),
  ),
)

/**
 * `?tab=` opens a widget rather than selecting one: several can be open at
 * once, so there is no single value for the URL to hold. Same contract as the
 * document page, so a link into either behaves the same way.
 */
function initialOpen(): RailWidget[] {
  const q = route.query.tab as RailWidget
  return RAIL_WIDGETS.some((w) => w.id === q) ? ['overview', q] : ['overview']
}
const open = ref<RailWidget[]>(initialOpen())
const isOpen = (id: RailWidget) => open.value.includes(id)
function setOpen(id: RailWidget, next: boolean) {
  open.value = next ? [...open.value, id] : open.value.filter((x) => x !== id)
}

/**
 * A widget with nothing in it is noise, not information — the reader learns
 * "no connectors" from its absence just as well, and without a row to skip.
 * Overview and people always show: an empty project still has a name, and
 * "nobody has written anything here yet" is the useful thing to say on one.
 */
const visibleWidgets = computed(() => {
  const c = data.value?.counts
  return RAIL_WIDGETS.filter((w) => {
    if (!c) return w.id === 'overview'
    if (w.id === 'glossary') return c.glossaryTerms > 0
    if (w.id === 'connectors') return c.connectors > 0
    if (w.id === 'workflows') return c.workflows > 0
    if (w.id === 'merge-requests') return c.openMergeRequests > 0
    return true
  })
})

const previewFor = computed<Record<RailWidget, string | null>>(() => {
  const c = data.value?.counts
  const latest = (activityPreview.data.value as ListActivityResponse | undefined)?.entries?.[0]
  const people = data.value?.contributors.length ?? 0
  return {
    overview: c ? t('count.pages', { n: c.documents }, c.documents) : null,
    people: people ? t('count.people', { n: people }, people) : null,
    activity: latest ? relativeTime(latest.createdAt) : null,
    'merge-requests': c?.openMergeRequests
      ? t('count.open', { n: c.openMergeRequests }, c.openMergeRequests)
      : null,
    glossary: c?.glossaryTerms ? t('count.terms', { n: c.glossaryTerms }, c.glossaryTerms) : null,
    connectors: c?.connectors ? t('count.connected', { n: c.connectors }, c.connectors) : null,
    workflows: c?.workflows ? t('count.workflows', { n: c.workflows }, c.workflows) : null,
  }
})

const isActive = computed(() => projectId.value === projects.activeId)
</script>

<template>
  <div v-if="overviewQuery.isPending.value" class="space-y-4">
    <Skeleton class="h-10 w-64" />
    <Skeleton class="h-40 w-full" />
  </div>

  <p v-else-if="!project" class="text-sm text-muted-foreground">{{ t('project.notFound') }}</p>

  <div v-else class="space-y-6">
    <header class="flex flex-wrap items-start gap-3">
      <ProjectAvatar
        :project-id="project.projectId"
        :name="project.name"
        :avatar-url="project.avatarUrl"
        :avatar-emoji="project.avatarEmoji"
        :avatar-color="project.avatarColor"
        size="lg"
      />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="font-display truncate text-2xl font-bold tracking-tight">{{ project.name }}</h1>
          <Badge v-if="isActive" variant="secondary">{{ t('project.active') }}</Badge>
        </div>
        <p class="mt-1 text-xs text-muted-foreground">
          {{ t('project.createdAt', { when: relativeTime(project.createdAt) }) }}
        </p>
      </div>
      <div class="flex shrink-0 gap-2">
        <Button v-if="!isActive" variant="outline" size="sm" @click="projects.switchProject(project.projectId)">
          {{ t('project.setAsActive') }}
        </Button>
        <Button as-child variant="ghost" size="sm">
          <RouterLink :to="`/settings/projects/${project.projectId}`">{{ t('nav.settings') }}</RouterLink>
        </Button>
      </div>
    </header>

    <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(0,1fr)_28rem]">
      <div class="min-w-0 space-y-6">
        <!-- What this project is for. The column exists in the database and
             was displayed nowhere; markdown because the field has always
             accepted it and people write links in it. -->
        <section v-if="project.description" class="rounded-xl border bg-card p-5">
          <MarkdownView :markdown="project.description" />
        </section>
        <section v-else class="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
          {{ t('project.noDescription') }}
          <RouterLink :to="`/settings/projects/${project.projectId}`" class="text-primary hover:underline">
            {{ t('project.addOne') }}
          </RouterLink>
        </section>

        <section class="space-y-2">
          <h2 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {{ t('project.recentPages') }}
          </h2>
          <p v-if="data && data.recentPages.length === 0" class="text-sm text-muted-foreground">
            {{ t('project.noPages') }}
          </p>
          <ul v-else class="divide-y rounded-xl border bg-card">
            <li
              v-for="page in data?.recentPages ?? []"
              :key="page.documentId"
              class="flex items-center gap-2 px-4 py-2.5 text-sm"
            >
              <FileText class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <RouterLink
                :to="`/documents/${page.documentId}`"
                class="min-w-0 flex-1 truncate font-medium hover:underline"
              >
                {{ page.title }}
              </RouterLink>
              <span class="shrink-0 text-xs text-muted-foreground">
                {{ relativeTime(page.updatedAt) }}
              </span>
            </li>
          </ul>
        </section>
      </div>

      <aside class="space-y-3 lg:sticky lg:top-6">
        <RailSection
          v-for="w in visibleWidgets"
          :key="w.id"
          :icon="w.icon"
          :title="w.label"
          :preview="previewFor[w.id]"
          :open="isOpen(w.id)"
          @update:open="(next: boolean) => setOpen(w.id, next)"
        >
          <dl v-if="w.id === 'overview' && data" class="space-y-1.5 text-sm">
            <div class="flex justify-between gap-2">
              <dt class="text-muted-foreground">{{ t('rail.pages') }}</dt>
              <dd class="font-medium tabular-nums">{{ data.counts.documents }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-muted-foreground">{{ t('rail.changes') }}</dt>
              <dd class="font-medium tabular-nums">{{ data.counts.openMergeRequests }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-muted-foreground">{{ t('rail.glossary') }}</dt>
              <dd class="font-medium tabular-nums">{{ data.counts.glossaryTerms }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-muted-foreground">{{ t('rail.connectors') }}</dt>
              <dd class="font-medium tabular-nums">{{ data.counts.connectors }}</dd>
            </div>
          </dl>

          <!-- Derived, not assigned: projects hold no members (feature 11), so
               these are the people who have actually revised a page here. The
               caption says so, because a list of faces otherwise reads as an
               access list — and nothing here grants anything. -->
          <div v-else-if="w.id === 'people' && data" class="space-y-2">
            <p v-if="data.contributors.length === 0" class="text-sm text-muted-foreground">
              {{ t('project.noContributors') }}
            </p>
            <template v-else>
              <ul class="space-y-1.5">
                <li
                  v-for="c in data.contributors"
                  :key="c.userId"
                  class="flex items-center gap-2 text-sm"
                >
                  <UserChip :user-id="c.userId" size="sm" class="min-w-0 flex-1" />
                  <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {{ t('count.pages', { n: c.pageCount }, c.pageCount) }}
                  </span>
                </li>
              </ul>
              <p class="text-xs text-muted-foreground">{{ t('project.contributorsHint') }}</p>
            </template>
          </div>

          <ActivityFeed
            v-else-if="w.id === 'activity'"
            :project-id="projectId"
            :limit="12"
            height="20rem"
          />

          <p v-else class="text-sm text-muted-foreground">
            {{ t('project.railElsewhere') }}
          </p>
        </RailSection>
      </aside>
    </div>
  </div>
</template>
