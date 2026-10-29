<script setup lang="ts">
/**
 * The three facets that describe a document: project, category, tag — with
 * the app's options for them.
 *
 * Extracted so the search sheet and the pages list cannot drift. They are the
 * same question asked in two places — "which pages am I looking at" — and the
 * moment one of them offers a facet the other does not, the reader has to learn
 * which surface knows about tags. The fields themselves are FacetFields, which
 * a published site's reader draws too, over its own options.
 *
 * Project and category are bounded lists filtered in the browser; tags are
 * unbounded and searched server-side against GET /v1/entities?type=tag&q=.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { DOCUMENT_CATEGORIES } from '@knowledge/contracts'
import { tagLabel, useTagOptions } from '@/modules/documents/model/tag-options'
import { useProjectsStore } from '@/stores/projects'
import type { AutocompleteOption } from '@/shared/ui/autocomplete'
import FacetFields from './FacetFields.vue'

const loadTagOptions = useTagOptions()

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

const projectOptions = computed<AutocompleteOption[] | undefined>(() =>
  props.showProjects
    ? projectsStore.items.map((p) => ({ value: p.projectId, label: p.name, meta: p.documentCount }))
    : undefined,
)
const categoryOptions = computed<AutocompleteOption[]>(() =>
  DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: t(`category.${c}`) })),
)
</script>

<template>
  <FacetFields
    :projects="projects"
    :categories="categories"
    :tags="tags"
    :project-options="projectOptions"
    :category-options="categoryOptions"
    :load-tags="loadTagOptions"
    :tag-label="tagLabel"
    :projects-hint="t('hints.noProjects')"
    :tags-hint="t('hints.tagsFromFrontmatter')"
    @update:projects="emit('update:projects', $event)"
    @update:categories="emit('update:categories', $event)"
    @update:tags="emit('update:tags', $event)"
  />
</template>
