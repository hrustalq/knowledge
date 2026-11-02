<script setup lang="ts">
/**
 * Start → From a project (#716): every project the person can see, in every
 * workspace they belong to, each roster read under their access there
 * (`GET /v1/projects` is scope-filtered per workspace, so a restricted project
 * they cannot open is simply absent). Picking one derives a blueprint from it
 * — titles and headings only — and hands it to the wizard.
 *
 * With no project anywhere, the built-ins' sample trees stand in, read-only:
 * the picker never ends at a blank panel.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, Loader2, Search } from 'lucide-vue-next'
import {
  blueprintText,
  type Blueprint,
  type BlueprintEntry,
  type Locale,
  type ProjectSummary,
} from '@knowledge/contracts'
import { api } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { errorMessage } from '@/shared/api/errors'
import { useWorkspacesStore } from '@/stores/workspaces'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Skeleton } from '@/shared/ui/skeleton'
import ProjectAvatar from '@/modules/projects/components/ProjectAvatar.vue'
import BlueprintTreePreview from '@/modules/projects/components/BlueprintTreePreview.vue'
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

const deriving = ref<string | null>(null)
const deriveError = ref<{ projectId: string; message: string } | null>(null)

async function derive(project: ProjectSummary) {
  if (deriving.value || !props.canEdit) return
  deriving.value = project.projectId
  deriveError.value = null
  try {
    const res = await api.post('/v1/blueprints/derive', {
      body: { workspaceId: getWorkspaceId(), projectId: project.projectId },
    })
    // An empty outline would land on Create as if Blank were picked: say why instead.
    if (!res.blueprint.tree.length) deriveError.value = { projectId: project.projectId, message: t('scaffold.derive.empty') }
    else emit('pick', res.blueprint, { kind: 'project', projectName: project.name, drafted: res.drafted, glossary: res.glossary })
  } catch (e) {
    deriveError.value = { projectId: project.projectId, message: `${t('scaffold.derive.failed')} ${errorMessage(e, t)}` }
  } finally {
    deriving.value = null
  }
}

const samples = computed(() => props.builtIns.filter((e) => e.builtIn && e.blueprint.tree.length))
</script>

<template>
  <div class="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-8 lg:py-10">
    <div>
      <Button variant="ghost" size="sm" class="text-muted-foreground -ml-2 mb-2 gap-1.5" @click="emit('back')">
        <ArrowLeft class="size-4" /> {{ t('scaffold.derive.back') }}
      </Button>
      <h2 class="text-lg font-semibold">{{ t('scaffold.derive.title') }}</h2>
      <p class="kn-measure text-muted-foreground mt-1 text-sm leading-relaxed">{{ t('scaffold.derive.body') }}</p>
    </div>

    <div v-if="loadError" class="rounded-xl border p-4 text-sm" role="alert">
      <p>{{ t('scaffold.derive.loadFailed') }}</p>
      <p class="text-muted-foreground mt-1 text-xs">{{ loadError }}</p>
      <Button size="sm" variant="outline" class="mt-3" @click="load">{{ t('common.retry') }}</Button>
    </div>

    <div v-else-if="!groups" class="space-y-2" aria-busy="true">
      <Skeleton class="h-9 w-full" />
      <Skeleton v-for="i in 4" :key="i" class="h-14 w-full rounded-lg" />
    </div>

    <!-- Nothing to copy from yet: show what the built-ins look like instead. -->
    <template v-else-if="!total">
      <p class="rounded-lg border border-dashed px-4 py-3 text-sm">
        {{ t('scaffold.derive.none') }}
      </p>
      <div class="grid gap-2.5 sm:grid-cols-2">
        <section v-for="entry in samples" :key="entry.key" class="flex min-w-0 flex-col rounded-xl border p-4">
          <h3 class="flex items-center gap-2 text-sm font-medium">
            <span v-if="entry.blueprint.icon" aria-hidden="true">{{ entry.blueprint.icon }}</span>
            {{ blueprintText(entry.blueprint.name, locale) }}
          </h3>
          <BlueprintTreePreview class="mt-3 mb-4" :tree="entry.blueprint.tree" :locale="locale" :max="8" />
          <Button size="sm" variant="outline" class="mt-auto self-start" :disabled="!canEdit" @click="emit('pickEntry', entry)">
            {{ t('scaffold.derive.useSample') }}
          </Button>
        </section>
      </div>
    </template>

    <template v-else>
      <div class="relative">
        <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input v-model="query" class="pl-8" :placeholder="t('scaffold.derive.search')" :aria-label="t('scaffold.derive.search')" />
      </div>

      <p v-if="!filtered?.length" class="text-muted-foreground py-6 text-center text-sm">{{ t('common.noMatchFor', { query }) }}</p>

      <section v-for="group in filtered" :key="group.workspaceId" :aria-label="group.name || undefined">
        <h3 v-if="multiWorkspace" class="text-muted-foreground mb-1.5 text-caption font-semibold tracking-wider uppercase">
          {{ group.name }}
          <span v-if="group.workspaceId !== getWorkspaceId()" class="font-normal tracking-normal normal-case">· {{ t('scaffold.derive.otherWorkspace') }}</span>
        </h3>
        <ul class="divide-y rounded-lg border">
          <li v-for="p in group.projects" :key="p.projectId">
            <button
              type="button"
              class="kn-derive-row"
              :disabled="!canEdit || !p.documentCount || (!!deriving && deriving !== p.projectId)"
              :aria-busy="deriving === p.projectId || undefined"
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
              <span v-if="deriving === p.projectId" class="text-muted-foreground flex shrink-0 items-center gap-1.5 text-caption">
                <Loader2 class="size-3.5 animate-spin" /> {{ t('scaffold.derive.reading') }}
              </span>
              <span v-else class="text-muted-foreground shrink-0 text-caption tabular-nums">
                {{ p.documentCount ? t('scaffold.start.pages', { count: p.documentCount }, p.documentCount) : t('scaffold.start.noPages') }}
              </span>
            </button>
            <p v-if="deriveError?.projectId === p.projectId" role="alert" class="text-destructive px-3 pb-2.5 text-xs">
              {{ deriveError.message }}
            </p>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.kn-derive-row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  text-align: left;
  transition: background-color 120ms;
}
.kn-derive-row:hover:not(:disabled) {
  background: var(--accent);
}
.kn-derive-row:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
.kn-derive-row:disabled:not([aria-busy]) {
  opacity: 0.55;
}
</style>
