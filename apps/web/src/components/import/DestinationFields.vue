<script setup lang="ts">
/**
 * Where the imported page lands: project, category, parent.
 *
 * The same `Autocomplete` the editor's settings sheet and the search filters
 * use — picking a project should not be a different gesture depending on which
 * screen you are on. Everything is pre-filled from the active scope, so the
 * common path through this step is to change nothing.
 */
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { DOCUMENT_CATEGORIES, type DocumentCategory } from '@knowledge/contracts'
import { Autocomplete, type AutocompleteOption } from '@/components/ui/autocomplete'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'

const { t } = useI18n()

const props = withDefaults(defineProps<{ stacked?: boolean }>(), { stacked: false })

const TOP_LEVEL = '__root__'

const projectId = defineModel<string>('projectId', { required: true })
const category = defineModel<DocumentCategory>('category', { required: true })
const parentId = defineModel<string>('parentId', { required: true })

const projects = useProjectsStore()
const documents = useDocumentsStore()

/** Autocomplete speaks string[]; these bridge it to the single values held here. */
function single<T extends string>(model: { value: T }, fallback: T) {
  return computed<string[]>({
    get: () => (model.value ? [model.value] : []),
    set: (v) => (model.value = (v[0] ?? fallback) as T),
  })
}

const projectSelection = single(projectId, '' as string)
const categorySelection = single(category, 'other' as DocumentCategory)
const parentSelection = computed<string[]>({
  get: () => [parentId.value || TOP_LEVEL],
  set: (v) => (parentId.value = v[0] === TOP_LEVEL ? '' : (v[0] ?? '')),
})

const projectOptions = computed<AutocompleteOption[]>(() =>
  projects.items.map((p) => ({ value: p.projectId, label: p.name, meta: p.documentCount })),
)
const categoryOptions = computed<AutocompleteOption[]>(() =>
  DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: c })),
)
const parentOptions = computed<AutocompleteOption[]>(() => [
  { value: TOP_LEVEL, label: 'Top level' },
  ...documents.items.map((d) => ({ value: d.documentId, label: d.title, meta: d.category })),
])
</script>

<template>
  <div :class="props.stacked ? 'grid gap-4' : 'grid gap-5 sm:grid-cols-2'">
    <Autocomplete
      v-model="projectSelection"
      :label="t('import.project')"
      :placeholder="t('import.searchProjects')"
      :options="projectOptions"
      :multiple="false"
      :empty-hint="t('hints.noProjects')"
    />
    <Autocomplete
      v-model="categorySelection"
      :label="t('import.category')"
      :placeholder="t('import.searchCategories')"
      :options="categoryOptions"
      :multiple="false"
    />
    <div :class="props.stacked ? '' : 'sm:col-span-2'">
      <Autocomplete
        v-model="parentSelection"
        :label="t('import.parentPage')"
        :placeholder="t('import.searchPages')"
        :options="parentOptions"
        :multiple="false"
        :empty-hint="t('hints.noPagesTopLevel')"
      />
    </div>
  </div>
</template>
