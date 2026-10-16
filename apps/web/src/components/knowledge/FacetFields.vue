<script setup lang="ts">
/**
 * The document facets as fields — project, category, tag — over options the
 * caller hands in. Store-free, so a published site's reader (#205) offers the
 * same fields as the app: each surface declares the facets it has by passing
 * their options, and a facet with none passed is not drawn.
 *
 * The app's options come from DocumentFacets; the reader's from its version's
 * snapshot (GET /v1/public/sites/:siteId/facets).
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Autocomplete, type AutocompleteOption } from '@/components/ui/autocomplete'

const { t } = useI18n()

const props = defineProps<{
  projects?: string[]
  categories: string[]
  tags: string[]
  /** Omitted where the surface has no project to choose (the reader, a project-scoped list). */
  projectOptions?: AutocompleteOption[]
  categoryOptions?: AutocompleteOption[]
  /** A bounded roster, filtered in the browser… */
  tagOptions?: AutocompleteOption[]
  /** …or an unbounded one, searched server-side. */
  loadTags?: (query: string) => Promise<AutocompleteOption[]>
  tagLabel?: (value: string) => string
  projectsHint?: string
  tagsHint?: string
}>()

const emit = defineEmits<{
  'update:projects': [string[]]
  'update:categories': [string[]]
  'update:tags': [string[]]
}>()

const selectedProjects = computed({
  get: () => props.projects ?? [],
  set: (v: string[]) => emit('update:projects', v),
})
const selectedCategories = computed({
  get: () => props.categories,
  set: (v: string[]) => emit('update:categories', v),
})
const selectedTags = computed({
  get: () => props.tags,
  set: (v: string[]) => emit('update:tags', v),
})
</script>

<template>
  <Autocomplete
    v-if="projectOptions"
    v-model="selectedProjects"
    :label="t('search.projects')"
    :placeholder="t('search.filterByProject')"
    :options="projectOptions"
    :empty-hint="projectsHint"
  />

  <Autocomplete
    v-if="categoryOptions"
    v-model="selectedCategories"
    :label="t('search.category')"
    :placeholder="t('search.filterByCategory')"
    :options="categoryOptions"
  />

  <Autocomplete
    v-if="tagOptions || loadTags"
    v-model="selectedTags"
    :label="t('search.tags')"
    :placeholder="t('search.filterByTag')"
    :options="tagOptions"
    :load="loadTags"
    :fallback-label="tagLabel"
    :empty-hint="tagsHint"
  />
</template>
