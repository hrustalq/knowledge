<script setup lang="ts">
/**
 * The three facets that describe a document: project, category, tag.
 *
 * Extracted so the search sheet and the pages list cannot drift. They are the
 * same question asked in two places — "which pages am I looking at" — and the
 * moment one of them offers a facet the other does not, the reader has to learn
 * which surface knows about tags.
 *
 * Project and category are bounded lists filtered in the browser; tags are
 * unbounded and searched server-side against GET /v1/entities?type=tag&q=.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DocumentCategory } from '@knowledge/contracts'
import { DOCUMENT_CATEGORIES } from '@knowledge/contracts'
import { loadTagOptions, tagLabel } from '@/lib/tag-options'
import { useProjectsStore } from '@/stores/projects'
import { Autocomplete, type AutocompleteOption } from '@/components/ui/autocomplete'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    projects: string[]
    categories: string[]
    tags: string[]
    /** Hidden where the surface is already scoped to one project. */
    showProjects?: boolean
  }>(),
  { showProjects: true },
)

const emit = defineEmits<{
  'update:projects': [string[]]
  'update:categories': [string[]]
  'update:tags': [string[]]
}>()

const projectsStore = useProjectsStore()

const projectOptions = computed<AutocompleteOption[]>(() =>
  projectsStore.items.map((p) => ({ value: p.projectId, label: p.name, meta: p.documentCount })),
)
const categoryOptions = computed<AutocompleteOption[]>(() =>
  DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: t(`category.${c}`) })),
)

const selectedProjects = computed({
  get: () => props.projects,
  set: (v: string[]) => emit('update:projects', v),
})
const selectedCategories = computed({
  get: () => props.categories,
  set: (v: string[]) => emit('update:categories', v as DocumentCategory[]),
})
const selectedTags = computed({
  get: () => props.tags,
  set: (v: string[]) => emit('update:tags', v),
})
</script>

<template>
  <Autocomplete
    v-if="showProjects"
    v-model="selectedProjects"
    :label="t('search.projects')"
    :placeholder="t('search.filterByProject')"
    :options="projectOptions"
    :empty-hint="t('hints.noProjects')"
  />

  <Autocomplete
    v-model="selectedCategories"
    :label="t('search.category')"
    :placeholder="t('search.filterByCategory')"
    :options="categoryOptions"
  />

  <Autocomplete
    v-model="selectedTags"
    :label="t('search.tags')"
    :placeholder="t('search.filterByTag')"
    :load="loadTagOptions"
    :fallback-label="tagLabel"
    :empty-hint="t('hints.tagsFromFrontmatter')"
  />
</template>
