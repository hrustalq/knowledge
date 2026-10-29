<script setup lang="ts">
/**
 * Link what a connection reaches to projects (#564). Each picked resource
 * gets one or more destinations, and every resource↔project pair becomes its
 * own connector — 1-1, one repository into two projects from two folders,
 * several spaces into one project. Nothing here deletes: a pair already
 * linked is shown, and removing one is the connector's own delete.
 *
 * A kind the connection can list (repositories, spaces, Jira projects, Notion
 * databases) is a searchable list; any other kind is the typed fields it has
 * always had, as many entries as needed.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { refDebounced } from '@vueuse/core'
import { Loader2, Lock, Plus, Search, X } from 'lucide-vue-next'
import {
  CONNECTOR_RESOURCE_KEYS,
  connectionKindsFor,
  connectorKindInfo,
  type ConnectionLinkResult,
  type ConnectionResource,
  type ConnectionResourcesResponse,
  type ConnectionSummary,
  type ConnectorKind,
  type ListConnectorsResponse,
} from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { getWorkspaceId, relativeTime } from '@/shared/api/api'
import { INTERCOM_REGIONS } from '@/modules/connectors/model/connection-providers'
import { useProjectsStore } from '@/stores/projects'
import ConnectionBranchSelect from './ConnectionBranchSelect.vue'

const props = defineProps<{ connection: ConnectionSummary; projectId?: string }>()
const emit = defineEmits<{ linked: [ConnectionLinkResult[]]; skip: [] }>()

const { t } = useI18n()
const workspaceId = getWorkspaceId()
const projects = useProjectsStore()
if (!projects.loaded) void projects.fetchList()

const kinds = computed(() => connectionKindsFor(props.connection.provider))
const kind = ref<ConnectorKind>(kinds.value[0])
const isRepo = computed(() => kind.value === 'codebase' || kind.value === 'markdown-git')

// --- what the connection reaches ---

const search = ref('')
const q = refDebounced(search, 300)
const namespace = ref<string | null>(null)
const query = useQuery(
  computed(() =>
    apiQueryOptions('/v1/connections/{id}/resources', { path: { id: props.connection.id }, query: { kind: kind.value, q: q.value } }),
  ),
)
const listing = computed(() => query.data.value as ConnectionResourcesResponse | undefined)
const listable = computed(() => listing.value?.listable ?? true)
const namespaces = computed(() => [...new Set((listing.value?.resources ?? []).map((r) => r.namespace).filter((n): n is string => !!n))])
const resources = computed(() => (listing.value?.resources ?? []).filter((r) => !namespace.value || r.namespace === namespace.value))

/** The connectors already reading through this connection — the pairs that exist. */
const connectors = useQuery(apiQueryOptions('/v1/connectors', { query: { workspaceId } }))
const linked = computed(() =>
  ((connectors.data.value as ListConnectorsResponse | undefined)?.connectors ?? []).filter((c) => c.connectionId === props.connection.id),
)
const projectName = (id: string) => projects.items.find((p) => p.projectId === id)?.name ?? id

// --- picks: a resource (or a typed entry) and where it lands ---

interface Destination {
  projectId: string
  folder: string
}
interface Pick {
  key: string
  label: string
  resource: ConnectionResource | null
  config: Record<string, string>
  branch: string
  destinations: Destination[]
}
const picks = reactive<Pick[]>([])
// Started from a project's page, that project; otherwise a deliberate choice, never a guess.
const destination = (): Destination => ({ projectId: props.projectId ?? '', folder: '' })
/** A typed repository URL is on the connection's own host, so say so rather than github.com. */
function placeholderOf(field: { key: string; placeholder?: string }): string | undefined {
  return field.key === 'repoUrl' && props.connection.site ? `${props.connection.site}/group/repository` : field.placeholder
}

function picked(resource: ConnectionResource) {
  return picks.some((p) => p.key === resource.id)
}
function toggle(resource: ConnectionResource) {
  const at = picks.findIndex((p) => p.key === resource.id)
  if (at >= 0) picks.splice(at, 1)
  else picks.push({ key: resource.id, label: resource.label, resource, config: { ...resource.config }, branch: '', destinations: [destination()] })
}

/** Typed fields: the kind's own text fields, minus the long tail the connector page sets later. */
const LATER = new Set(['apiSpecs', 'maxModules', 'figmaTokenExpires'])
const typedFields = computed(() =>
  (connectorKindInfo(kind.value)?.fields ?? []).filter(
    (f) => f.kind === 'text' && !LATER.has(f.key) && !(isRepo.value && (f.key === 'branch' || f.key === 'subdir')),
  ),
)
/** What a typed entry starts with: the connection already fixes the site (or region). */
function seed(): Record<string, string> {
  const site = props.connection.site ?? ''
  const region = Object.entries(INTERCOM_REGIONS).find(([, host]) => host === site)?.[0]
  if (kind.value === 'intercom') return region ? { region } : {}
  if (kind.value === 'zendesk' || kind.value === 'confluence-server') return { baseUrl: site }
  if (kind.value === 'confluence') return { baseUrl: `${site}/wiki` }
  if (kind.value === 'jira') return { baseUrl: site }
  return {}
}
function addTyped() {
  picks.push({ key: `typed-${picks.length}-${Date.now()}`, label: '', resource: null, config: seed(), branch: '', destinations: [destination()] })
}

watch(kind, () => {
  picks.splice(0)
  namespace.value = null
  search.value = ''
})
// A kind with no listing opens with one entry to fill in, not an empty screen.
watch(listable, (yes) => {
  if (!yes && !picks.length) addTyped()
})

// --- submit ---

const pairs = computed(() =>
  picks.flatMap((p) =>
    p.destinations
      .filter((d) => d.projectId)
      .map((d) => ({
        kind: kind.value,
        projectId: d.projectId,
        // The folder is part of the name: one repository into one project from two folders is two connectors.
        label: `${p.label || labelOf(p.config)}${isRepo.value && d.folder.trim() ? ` (${d.folder.trim().replace(/^\/+|\/+$/g, '')})` : ''}`,
        config: {
          ...p.config,
          ...(isRepo.value && p.branch ? { branch: p.branch } : {}),
          ...(isRepo.value && d.folder.trim() ? { subdir: d.folder.trim().replace(/^\/+|\/+$/g, '') } : {}),
        },
      })),
  ),
)
/** A typed entry's name is its first resource value: the repo path, the space key, the tag. */
function labelOf(config: Record<string, string>): string {
  const first = CONNECTOR_RESOURCE_KEYS[kind.value].map((k) => config[k]?.trim()).find(Boolean) ?? kind.value
  return first.replace(/^https?:\/\/[^/]+\//, '')
}
const ready = computed(() => pairs.value.length > 0 && picks.every((p) => p.resource || typedFields.value.every((f) => !f.required || p.config[f.key]?.trim())))

const saving = ref(false)
const error = ref<string | null>(null)
async function link() {
  saving.value = true
  error.value = null
  try {
    const res = await api.post('/v1/connections/{id}/links', { path: { id: props.connection.id }, body: { links: pairs.value } })
    emit('linked', res.results)
  } catch (e) {
    error.value = errorMessage(e, t)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- One provider can feed two kinds: code or prose from one repository, Confluence or Jira from one site. -->
    <div v-if="kinds.length > 1" role="group" :aria-label="t('connectors.link.kindLabel')" class="bg-muted inline-flex rounded-lg p-0.5">
      <button
        v-for="k in kinds"
        :key="k"
        type="button"
        :aria-pressed="kind === k"
        class="focus-visible:ring-ring rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
        :class="kind === k ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
        @click="kind = k"
      >
        {{ connectorKindInfo(k)?.label ?? k }}
      </button>
    </div>

    <details v-if="linked.length" class="rounded-lg border px-3 py-2 text-xs">
      <summary class="text-muted-foreground hover:text-foreground cursor-pointer select-none">
        {{ t('connectors.link.alreadyLinked', { count: linked.length }, linked.length) }}
      </summary>
      <ul class="mt-2 space-y-1">
        <li v-for="c in linked" :key="c.id" class="flex min-w-0 items-center gap-1.5">
          <RouterLink :to="`/settings/connectors/${c.id}`" class="truncate underline-offset-2 hover:underline">{{ c.name }}</RouterLink>
          <span class="text-muted-foreground shrink-0">→ {{ projectName(c.projectId) }}</span>
        </li>
      </ul>
    </details>

    <!-- A listable kind: search, the account / group switcher, then the list. -->
    <template v-if="listable">
      <div class="space-y-2">
        <label class="relative block">
          <span class="sr-only">{{ t('connectors.link.search') }}</span>
          <Search class="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" aria-hidden="true" />
          <Input v-model="search" type="search" class="ps-8" :placeholder="t('connectors.link.search')" />
        </label>
        <div v-if="namespaces.length > 1" class="flex flex-wrap gap-1.5" role="group" :aria-label="t('connectors.link.namespaceLabel')">
          <button
            v-for="ns in [null, ...namespaces]"
            :key="ns ?? '*'"
            type="button"
            :aria-pressed="namespace === ns"
            class="focus-visible:ring-ring max-w-full truncate rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none"
            :class="namespace === ns ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-muted'"
            @click="namespace = ns"
          >
            {{ ns ?? t('connectors.link.allNamespaces') }}
          </button>
        </div>
      </div>

      <div class="max-h-64 overflow-y-auto rounded-lg border">
        <div v-if="query.isPending.value" class="text-muted-foreground flex items-center gap-2 p-3 text-sm">
          <Loader2 class="size-4 animate-spin" aria-hidden="true" /> {{ t('connectors.link.loading') }}
        </div>
        <p v-else-if="listing?.error" class="text-destructive p-3 text-xs" role="alert">{{ listing.error }}</p>
        <p v-else-if="!resources.length" class="text-muted-foreground p-3 text-sm">{{ t('connectors.link.none') }}</p>
        <ul v-else class="divide-y">
          <li v-for="r in resources" :key="r.id">
            <label class="hover:bg-muted/60 flex cursor-pointer items-start gap-2.5 px-3 py-2">
              <Checkbox :model-value="picked(r)" class="mt-0.5" @update:model-value="toggle(r)" />
              <span class="min-w-0 flex-1">
                <span class="flex min-w-0 items-center gap-1.5 text-sm">
                  <span class="truncate" :class="{ 'font-mono text-xs': isRepo }" :title="r.label">{{ r.label }}</span>
                  <Lock v-if="r.private" class="text-muted-foreground size-3 shrink-0" :aria-label="t('connectors.link.private')" />
                </span>
                <span class="text-muted-foreground block truncate text-xs">
                  <template v-if="r.defaultBranch">{{ r.defaultBranch }}</template>
                  <template v-if="r.defaultBranch && r.updatedAt"> · </template>
                  <template v-if="r.updatedAt">{{ relativeTime(r.updatedAt) }}</template>
                  <template v-if="r.description && !r.defaultBranch"> {{ r.description }}</template>
                </span>
              </span>
            </label>
          </li>
        </ul>
      </div>
    </template>

    <!-- Nowhere to land: say so before anyone fills in a form that cannot be sent. -->
    <p v-if="projects.loaded && !projects.items.length" class="text-panel-warning-ink text-sm" role="status">
      {{ t('connectors.link.noProjects') }}
      <RouterLink to="/settings/projects" class="underline underline-offset-2">{{ t('connectors.link.createProject') }}</RouterLink>
    </p>

    <!-- Each pick and where it lands. Picks are listed in the order they were made. -->
    <section v-if="picks.length" class="space-y-3">
      <h3 class="text-sm font-medium">{{ t('connectors.link.destinations') }}</h3>
      <div v-for="(p, i) in picks" :key="p.key" class="space-y-2.5 rounded-lg border p-3">
        <div class="flex min-w-0 items-center gap-2">
          <p v-if="p.resource" class="min-w-0 flex-1 truncate text-sm font-medium" :class="{ 'font-mono text-xs': isRepo }" :title="p.label">
            {{ p.label }}
          </p>
          <p v-else class="text-muted-foreground min-w-0 flex-1 text-xs">{{ t('connectors.link.typedEntry', { n: i + 1 }) }}</p>
          <Button size="sm" variant="ghost" class="size-7 p-0" :aria-label="t('connectors.link.removePick')" @click="picks.splice(i, 1)">
            <X class="size-3.5" />
          </Button>
        </div>

        <!-- Typed fields, for a kind the connection cannot list. -->
        <div v-if="!p.resource" class="grid gap-2 sm:grid-cols-2">
          <label v-for="f in typedFields" :key="f.key" class="block min-w-0 space-y-1">
            <span class="text-muted-foreground text-xs">{{ f.label }}<template v-if="f.required"> *</template></span>
            <Input v-model="p.config[f.key]" class="h-8 text-xs" :placeholder="placeholderOf(f)" :required="f.required" />
          </label>
        </div>

        <ConnectionBranchSelect
          v-if="p.resource && isRepo"
          v-model="p.branch"
          :connection-id="connection.id"
          :repo="p.resource.id"
          :default-branch="p.resource.defaultBranch"
          :label="t('connectors.link.branch')"
        />
        <label v-if="p.resource && kind === 'jira'" class="block space-y-1">
          <span class="text-muted-foreground text-xs">{{ t('connectors.link.jql') }}</span>
          <Input v-model="p.config.jql" class="h-8 font-mono text-xs" />
        </label>

        <!-- Where it lands: one row per project. Same resource, two projects, two folders is two connectors. -->
        <div class="space-y-1.5">
          <div v-for="(d, j) in p.destinations" :key="j" class="flex min-w-0 flex-wrap items-end gap-2">
            <label class="block min-w-0 flex-1 basis-40 space-y-1">
              <span class="text-muted-foreground text-xs">{{ t('connectors.link.project') }}</span>
              <Select v-model="d.projectId">
                <SelectTrigger class="h-8 w-full min-w-0 text-xs"><SelectValue :placeholder="t('connectors.link.pickProject')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="proj in projects.items" :key="proj.projectId" :value="proj.projectId">{{ proj.name }}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label v-if="isRepo" class="block min-w-0 flex-1 basis-32 space-y-1">
              <span class="text-muted-foreground text-xs">{{ t('connectors.link.folder') }}</span>
              <Input v-model="d.folder" class="h-8 font-mono text-xs" :placeholder="t('connectors.link.folderPlaceholder')" />
            </label>
            <Button
              v-if="p.destinations.length > 1"
              size="sm"
              variant="ghost"
              class="size-8 p-0"
              :aria-label="t('connectors.link.removeDestination')"
              @click="p.destinations.splice(j, 1)"
            >
              <X class="size-3.5" />
            </Button>
          </div>
          <button type="button" class="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs" @click="p.destinations.push(destination())">
            <Plus class="size-3" aria-hidden="true" /> {{ t('connectors.link.addDestination') }}
          </button>
        </div>
      </div>
    </section>

    <button v-if="!listable" type="button" class="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs" @click="addTyped">
      <Plus class="size-3" aria-hidden="true" /> {{ t('connectors.link.addTyped') }}
    </button>

    <p v-if="error" class="text-destructive text-xs" role="alert">{{ error }}</p>
    <div class="flex flex-wrap items-center justify-end gap-2">
      <Button variant="ghost" @click="emit('skip')">{{ t('connectors.link.skip') }}</Button>
      <Button :disabled="!ready || saving" @click="link">
        <Loader2 v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
        {{ t('connectors.link.submit', { count: pairs.length }, pairs.length) }}
      </Button>
    </div>
  </div>
</template>
