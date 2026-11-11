<script setup lang="ts">
/**
 * Start → From a project (#716): every project the person can see, in every
 * workspace they belong to, each roster read under their access there
 * (`GET /v1/projects` is scope-filtered per workspace, so a restricted project
 * they cannot open is simply absent). Picking one derives a blueprint from it
 * — titles and headings only — into the preview pane; "Use this outline"
 * hands it to the wizard. Picking another replaces the preview.
 *
 * With no project anywhere, the built-ins' sample trees stand in, read-only:
 * the picker never ends at a blank panel.
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, ArrowRight, ListTree, Loader2, Search, Sparkles } from 'lucide-vue-next'
import {
  blueprintText,
  type Blueprint,
  type BlueprintEntry,
  type DeriveBlueprintResponse,
  type Locale,
  type ProjectSummary,
} from '@knowledge/contracts'
import { api } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { errorMessage } from '@/shared/api/errors'
import { useWorkspacesStore } from '@/stores/workspaces'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Skeleton } from '@knowledge/ui/skeleton'
import ProjectAvatar from '@/modules/projects/components/ProjectAvatar.vue'
import BlueprintTreePreview from '@/modules/projects/components/BlueprintTreePreview.vue'
import { countPages } from '@/modules/projects/model/blueprint-tree'
import type { ScaffoldOrigin } from '@/modules/projects/model/scaffold-machine'

const props = defineProps<{ builtIns: BlueprintEntry[]; locale: Locale; canEdit: boolean }>()
const emit = defineEmits<{
  back: []
  pick: [blueprint: Blueprint, origin: ScaffoldOrigin]
  pickEntry: [entry: BlueprintEntry]
}>()

const { t } = useI18n()
const workspaces = useWorkspacesStore()

interface Group {
  workspaceId: string
  name: string
  projects: ProjectSummary[]
}

const groups = ref<Group[] | null>(null)
const loadError = ref<string | null>(null)

async function load() {
  loadError.value = null
  groups.value = null
  try {
    await workspaces.fetchList().catch(() => undefined)
    const current = getWorkspaceId()
    // The active workspace first; a roster that failed to load still has it.
    const listed = workspaces.items.length ? workspaces.items : [{ workspaceId: current, name: '' }]
    const ordered = [...listed].sort((a, b) => Number(b.workspaceId === current) - Number(a.workspaceId === current))
    // ponytail: one roster request per workspace; a person in dozens of workspaces wants a cross-workspace route.
    const rosters = await Promise.allSettled(
      ordered.map((ws) => api.get('/v1/projects', { query: { workspaceId: ws.workspaceId } })),
    )
    // Only when nothing at all came back: a workspace the person cannot list is just left out.
    const [first] = rosters
    if (first?.status === 'rejected' && rosters.every((r) => r.status === 'rejected')) throw first.reason
    groups.value = ordered
      .map((ws, i) => {
        const r = rosters[i]!
        return { workspaceId: ws.workspaceId, name: ws.name, projects: r.status === 'fulfilled' ? r.value.projects : [] }
      })
      .filter((g) => g.projects.length)
  } catch (e) {
    loadError.value = errorMessage(e, t)
  }
}
onMounted(load)

const query = ref('')
const filtered = computed(() => {
  const q = query.value.trim().toLocaleLowerCase()
  if (!groups.value) return null
  if (!q) return groups.value
  return groups.value
    .map((g) => ({ ...g, projects: g.projects.filter((p) => `${p.name} ${p.description ?? ''}`.toLocaleLowerCase().includes(q)) }))
    .filter((g) => g.projects.length)
})
const total = computed(() => groups.value?.reduce((n, g) => n + g.projects.length, 0) ?? 0)
const multiWorkspace = computed(() => (groups.value?.length ?? 0) > 1 || groups.value?.[0]?.workspaceId !== getWorkspaceId())

/* ------------------------------------------------------------------ preview */

const selected = ref<ProjectSummary | null>(null)
const result = ref<DeriveBlueprintResponse | null>(null)
const deriving = ref(false)
const failure = ref<string | null>(null)
const preview = ref<HTMLElement | null>(null)
/** Only the latest pick may fill the preview: a slow read of an earlier one is dropped. */
let latest = 0

async function derive(project: ProjectSummary) {
  if (!props.canEdit) return
  const mine = ++latest
  selected.value = project
  result.value = null
  failure.value = null
  deriving.value = true
  // Stacked panes (below lg): bring the preview into view, or the click looks like it did nothing.
  if (!window.matchMedia('(min-width: 64rem)').matches) void nextTick(() => preview.value?.scrollIntoView({ block: 'start' }))
  try {
    const res = await api.post('/v1/blueprints/derive', {
      body: { workspaceId: getWorkspaceId(), projectId: project.projectId },
    })
    if (mine === latest) result.value = res
  } catch (e) {
    if (mine === latest) failure.value = `${t('scaffold.derive.failed')} ${errorMessage(e, t)}`
  } finally {
    if (mine === latest) deriving.value = false
  }
}

const outline = computed(() => (result.value?.blueprint.tree.length ? result.value : null))
const facts = computed(() => {
  const r = outline.value
  if (!r) return []
  const c = r.blueprint.conventions
  const pages = countPages(r.blueprint.tree)
  return [
    t('scaffold.create.summaryPages', { count: pages }, pages),
    c?.styleguide && t('scaffold.create.summaryRules', { count: c.styleguide.rules.length }, c.styleguide.rules.length),
    c?.templates && t('scaffold.create.summaryTemplates', { count: c.templates.length }, c.templates.length),
    r.glossary.length && t('scaffold.derive.termsOffered', { count: r.glossary.length }, r.glossary.length),
  ].filter(Boolean) as string[]
})

function use() {
  if (!outline.value || !selected.value) return
  const { blueprint, drafted, glossary } = outline.value
  emit('pick', blueprint, { kind: 'project', projectName: selected.value.name, drafted, glossary })
}

const samples = computed(() => props.builtIns.filter((e) => e.builtIn && e.blueprint.tree.length))
</script>

<template>
  <div class="grid h-full min-h-0 content-start overflow-y-auto lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:content-stretch lg:overflow-hidden">
    <!-- Rail: what can be copied from. -->
    <!-- min-h-0 only side by side: stacked, each pane keeps its full height and the whole step scrolls. -->
    <section class="flex flex-col border-b lg:min-h-0 lg:border-r lg:border-b-0">
      <div class="space-y-3 px-4 pt-4 pb-3 lg:px-6">
        <div class="space-y-1">
          <Button variant="ghost" size="sm" class="text-muted-foreground -ml-2 gap-1.5" @click="emit('back')">
            <ArrowLeft class="size-4" /> {{ t('scaffold.derive.back') }}
          </Button>
          <h2 class="text-lg font-semibold">{{ t('scaffold.derive.title') }}</h2>
        </div>
        <div v-if="total" class="relative">
          <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input v-model="query" class="pl-8" :placeholder="t('scaffold.derive.search')" :aria-label="t('scaffold.derive.search')" />
        </div>
      </div>

      <div class="border-t lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <div v-if="loadError" class="px-4 py-4 text-sm lg:px-6" role="alert">
          <p>{{ t('scaffold.derive.loadFailed') }}</p>
          <p class="text-muted-foreground mt-1 text-xs">{{ loadError }}</p>
          <Button size="sm" variant="outline" class="mt-3" @click="load">{{ t('common.retry') }}</Button>
        </div>

        <div v-else-if="!groups" class="space-y-1 px-4 py-3 lg:px-6" aria-busy="true">
          <Skeleton v-for="i in 6" :key="i" class="h-11 w-full rounded-md" />
        </div>

        <p v-else-if="!total" class="text-muted-foreground px-4 py-4 text-ui leading-relaxed lg:px-6">{{ t('scaffold.derive.none') }}</p>

        <p v-else-if="!filtered?.length" class="text-muted-foreground px-4 py-6 text-center text-sm lg:px-6">{{ t('common.noMatchFor', { query }) }}</p>

        <section v-for="group in filtered" v-else :key="group.workspaceId" :aria-label="group.name || undefined">
          <h3 v-if="multiWorkspace" class="kn-group-head">
            {{ group.name }}
            <span v-if="group.workspaceId !== getWorkspaceId()" class="font-normal tracking-normal normal-case">· {{ t('scaffold.derive.otherWorkspace') }}</span>
          </h3>
          <ul>
            <li v-for="p in group.projects" :key="p.projectId">
              <button
                type="button"
                class="kn-derive-row"
                :disabled="!canEdit || !p.documentCount"
                :aria-pressed="selected?.projectId === p.projectId"
                @click="derive(p)"
              >
                <ProjectAvatar
                  :project-id="p.projectId"
                  :name="p.name"
                  :avatar-url="p.avatarUrl"
                  :avatar-emoji="p.avatarEmoji"
                  :avatar-color="p.avatarColor"
                  size="sm"
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium">{{ p.name }}</span>
                  <span v-if="p.description" class="text-muted-foreground block truncate text-caption">{{ p.description }}</span>
                </span>
                <span class="text-muted-foreground shrink-0 text-caption tabular-nums">
                  {{ p.documentCount ? t('scaffold.start.pages', { count: p.documentCount }, p.documentCount) : t('scaffold.start.noPages') }}
                </span>
              </button>
            </li>
          </ul>
        </section>
      </div>
    </section>

    <!-- Preview: the outline that picking would give, before it is used. -->
    <section ref="preview" class="scroll-mt-4 px-4 py-4 lg:min-h-0 lg:overflow-y-auto lg:px-6" aria-live="polite">
      <!-- Nothing to copy from yet: show what the built-ins look like instead. -->
      <div v-if="groups && !total" class="grid gap-3 xl:grid-cols-2 2xl:grid-cols-3">
        <section v-for="entry in samples" :key="entry.key" class="flex min-w-0 flex-col rounded-xl border p-4">
          <h3 class="flex items-center gap-2 text-sm font-medium">
            <span v-if="entry.blueprint.icon" aria-hidden="true">{{ entry.blueprint.icon }}</span>
            {{ blueprintText(entry.blueprint.name, locale) }}
          </h3>
          <BlueprintTreePreview class="mt-3 mb-4" :tree="entry.blueprint.tree" :locale="locale" :max="10" />
          <Button size="sm" variant="outline" class="mt-auto self-start" :disabled="!canEdit" @click="emit('pickEntry', entry)">
            {{ t('scaffold.derive.useSample') }}
          </Button>
        </section>
      </div>

      <div v-else-if="!selected" class="text-muted-foreground grid h-full min-h-48 place-items-center text-center">
        <div class="kn-measure space-y-2">
          <ListTree class="mx-auto size-6" aria-hidden="true" />
          <p class="text-foreground text-sm font-medium">{{ t('scaffold.derive.pick') }}</p>
          <p class="text-ui leading-relaxed">{{ t('scaffold.derive.body') }}</p>
        </div>
      </div>

      <template v-else>
        <header class="flex flex-wrap items-start gap-3 border-b pb-4">
          <ProjectAvatar
            :project-id="selected.projectId"
            :name="selected.name"
            :avatar-url="selected.avatarUrl"
            :avatar-emoji="selected.avatarEmoji"
            :avatar-color="selected.avatarColor"
            size="md"
          />
          <div class="min-w-0 flex-1">
            <h3 class="truncate text-base font-semibold">{{ selected.name }}</h3>
            <p v-if="outline" class="text-muted-foreground mt-0.5 text-caption tabular-nums">{{ facts.join(' · ') }}</p>
            <p v-else-if="deriving" class="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-caption">
              <Loader2 class="size-3.5 animate-spin" aria-hidden="true" /> {{ t('scaffold.derive.reading') }}
            </p>
          </div>
          <Button v-if="outline" size="sm" class="gap-1.5 max-sm:w-full" @click="use">
            {{ t('scaffold.derive.use') }} <ArrowRight class="size-4" />
          </Button>
        </header>

        <div v-if="deriving" class="space-y-2 pt-4" aria-busy="true">
          <Skeleton v-for="i in 8" :key="i" class="h-4 rounded" :style="{ width: `${40 + ((i * 37) % 45)}%`, marginInlineStart: `${(i % 3) * 1.125}rem` }" />
        </div>
        <div v-else-if="failure" class="pt-4 text-sm" role="alert">
          <p class="text-destructive">{{ failure }}</p>
          <Button size="sm" variant="outline" class="mt-3" @click="derive(selected)">{{ t('common.retry') }}</Button>
        </div>
        <p v-else-if="!outline" class="text-muted-foreground pt-4 text-sm">{{ t('scaffold.derive.empty') }}</p>
        <template v-else>
          <p class="text-muted-foreground flex items-start gap-2 pt-3 text-xs leading-snug">
            <component :is="outline.drafted ? Sparkles : ListTree" class="mt-px size-3.5 shrink-0" aria-hidden="true" />
            {{ outline.drafted ? t('scaffold.provenance.drafted') : t('scaffold.provenance.rulesOnly') }}
          </p>
          <BlueprintTreePreview class="pt-3" :tree="outline.blueprint.tree" :locale="locale" />
        </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
.kn-group-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--background);
  padding: 0.75rem 1rem 0.375rem;
  font-size: var(--text-caption, 0.75rem);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}
.kn-derive-row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 1rem;
  text-align: left;
  transition: background-color 120ms;
}
@media (min-width: 64rem) {
  .kn-group-head,
  .kn-derive-row {
    padding-inline: 1.5rem;
  }
}
.kn-derive-row:hover:not(:disabled) {
  background: var(--accent);
}
.kn-derive-row[aria-pressed='true'] {
  background: color-mix(in oklab, var(--primary) 8%, transparent);
}
.kn-derive-row:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
.kn-derive-row:disabled {
  opacity: 0.55;
}
@media (prefers-reduced-motion: reduce) {
  .kn-derive-row {
    transition-duration: 0.01ms;
  }
}
</style>
