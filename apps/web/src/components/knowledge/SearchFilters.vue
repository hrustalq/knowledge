<script setup lang="ts">
// The app's filter rail for the search sheet and the /search page, passed into
// SearchPanel's `filters` slot. Rendered twice — as the desktop left rail and
// inside the mobile disclosure — so it owns no layout of its own.
//
// The three document facets (project, category, tag) live in DocumentFacets so
// the pages list offers exactly the same ones; what stays here is the part that
// is only meaningful while searching: which workspace, and how the query runs.
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import type { DocumentCategory, ReleaseTagDto } from '@knowledge/contracts'
import { X } from 'lucide-vue-next'
import { fetchApi } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { Input } from '@/components/ui/input'
import { useWorkspacesStore } from '@/stores/workspaces'
import { Autocomplete, type AutocompleteOption } from '@/components/ui/autocomplete'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import DocumentFacets from './DocumentFacets.vue'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { UseSearch } from './use-search'

const { t } = useI18n()
const queryClient = useQueryClient()

const props = defineProps<{ search: UseSearch }>()
const emit = defineEmits<{ 'switch-workspace': [workspaceId: string] }>()

const workspaces = useWorkspacesStore()

const activeWs = ref([getWorkspaceId()])

const workspaceOptions = computed<AutocompleteOption[]>(() =>
  workspaces.items.map((w) => ({ value: w.workspaceId, label: w.name })),
)
// The autocompletes speak string[]; the composable holds Sets.
const selectedCategories = computed({
  get: () => [...props.search.categories.value],
  set: (v: string[]) => {
    props.search.categories.value = new Set(v as DocumentCategory[])
  },
})
const selectedProjects = computed({
  get: () => [...props.search.projectIds.value],
  set: (v: string[]) => {
    props.search.projectIds.value = new Set(v)
  },
})
const selectedTags = computed({
  get: () => [...props.search.tags.value],
  set: (v: string[]) => {
    props.search.tags.value = new Set(v)
  },
})

/* ------------------------------------------------------------- as of (#81) */

const releaseTags = ref<ReleaseTagDto[]>([])
onMounted(async () => {
  try {
    releaseTags.value = (
      await fetchApi(queryClient, '/v1/release-tags', { query: { workspaceId: getWorkspaceId() } })
    ).tags
  } catch {
    // The date field still works; tags are a shortcut to a date.
  }
})

/** A local calendar day, YYYY-MM-DD — what `<input type="date">` speaks. */
const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = dayOf(new Date())

const asOfTag = computed({
  get: () => (props.search.asOf.value?.startsWith('tag:') ? props.search.asOf.value.slice(4) : ''),
  set: (name: string) => {
    props.search.asOf.value = name ? `tag:${name}` : null
  },
})
/**
 * A picked day means "as the day ended": a page changed at 3 pm on the 4th
 * read as changed on the 4th. The instant is the end of that local day.
 */
const asOfDay = computed({
  get: () => {
    const v = props.search.asOf.value
    return v && !v.startsWith('tag:') ? dayOf(new Date(v)) : ''
  },
  set: (day: string | number) => {
    props.search.asOf.value = day ? new Date(`${day}T23:59:59.999`).toISOString() : null
  },
})

function onWorkspace(next: string[]) {
  const id = next[0]
  if (!id || id === getWorkspaceId()) return
  activeWs.value = [id]
  emit('switch-workspace', id)
}
</script>

<template>
  <div class="space-y-5">
    <div class="space-y-1">
      <Autocomplete
        :model-value="activeWs"
        :label="t('search.workspace')"
        :placeholder="t('search.switchWorkspace')"
        :multiple="false"
        :options="workspaceOptions"
        @update:model-value="onWorkspace"
      />
      <p class="text-caption leading-snug text-muted-foreground">{{ t('search.switchingReloads') }}</p>
    </div>

    <div class="border-t" />

    <DocumentFacets
      v-model:projects="selectedProjects"
      v-model:categories="selectedCategories"
      v-model:tags="selectedTags"
    />

    <div class="border-t" />

    <section class="space-y-2.5 text-sm">
      <div class="flex items-center justify-between gap-2">
        <Label
          for="search-mode"
          class="text-caption font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {{ t('search.mode') }}
        </Label>
        <Select v-model="search.mode.value">
          <SelectTrigger id="search-mode" size="sm" class="text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hybrid">{{ t('search.modeHybrid') }}</SelectItem>
            <SelectItem value="semantic">{{ t('search.modeSemantic') }}</SelectItem>
            <SelectItem value="keyword">{{ t('search.modeKeyword') }}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div
        class="flex items-center justify-between gap-2"
        :class="search.mode.value !== 'hybrid' ? 'opacity-50' : ''"
      >
        <Label for="search-expand" class="gap-1.5 text-xs font-normal text-muted-foreground">
          <Checkbox
            id="search-expand"
            v-model="search.expand.value"
            :disabled="search.mode.value !== 'hybrid'"
          />
          {{ t('search.graphExpansion') }}
        </Label>
        <Select
          v-model="search.depth.value"
          :disabled="!search.expand.value || search.mode.value !== 'hybrid'"
        >
          <SelectTrigger size="sm" class="text-xs" :aria-label="t('search.expansionDepth')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="1">1</SelectItem>
            <SelectItem :value="2">2</SelectItem>
            <SelectItem :value="3">3</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex items-center justify-between gap-2">
        <Label
          for="search-limit"
          class="text-caption font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {{ t('search.limit') }}
        </Label>
        <Select v-model="search.limit.value">
          <SelectTrigger id="search-limit" size="sm" class="text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="10">10</SelectItem>
            <SelectItem :value="20">20</SelectItem>
            <SelectItem :value="50">50</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </section>

    <div class="border-t" />

    <!-- #81: the knowledge base as it read at a point. A day or a release tag,
         never both: picking one clears the other. -->
    <section class="space-y-2 text-sm">
      <div class="flex items-center justify-between gap-2">
        <Label for="search-as-of" class="text-caption font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('search.asOf.label') }}
        </Label>
        <button
          v-if="search.asOf.value"
          type="button"
          class="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
          @click="search.asOf.value = null"
        >
          <X class="size-3" />
          {{ t('search.asOf.clear') }}
        </button>
      </div>
      <Input id="search-as-of" v-model="asOfDay" type="date" :max="today" class="h-8 text-xs" :aria-label="t('search.asOf.pickDate')" />
      <Select v-if="releaseTags.length" v-model="asOfTag">
        <SelectTrigger size="sm" class="w-full text-xs" :aria-label="t('search.asOf.pickTag')">
          <SelectValue :placeholder="t('search.asOf.pickTag')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="tag in releaseTags" :key="tag.id" :value="tag.name">
            {{ tag.name }} <span class="text-muted-foreground">· {{ formatDate(tag.at) }}</span>
          </SelectItem>
        </SelectContent>
      </Select>
      <p class="text-caption leading-snug text-muted-foreground">{{ t('search.asOf.hint') }}</p>
    </section>
  </div>
</template>
