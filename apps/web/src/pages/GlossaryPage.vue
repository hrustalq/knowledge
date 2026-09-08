<script setup lang="ts">
/**
 * Glossary (docs/features/14): the project's shared vocabulary, and the one
 * place a definition is written.
 *
 * Two ways in. Someone writes a term by hand, or the assistant reads a page
 * and drafts the entries the project is missing — and a draft is never a fact:
 * nothing from the model reaches the glossary until a person accepts it, which
 * is why "Add" is a separate click on every suggestion rather than a bulk
 * import.
 *
 * The controls are the app's own: the filter bar scopes and narrows the roster
 * (project is a *pinned* field — it decides what is fetched, not what is
 * hidden), pages are chosen with the autocomplete rather than a `<select>`
 * that would list a thousand titles, and a definition is written in the same
 * editor a page is.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { BookMarked, FolderKanban, Plus, Sparkles, Trash2, Type, Wand2 } from 'lucide-vue-next'
import type {
  GlossaryTerm,
  GlossaryTermSuggestion,
  ListGlossaryResponse,
  SuggestGlossaryTermsResponse,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getProjectId, getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'
import { useGlossaryStore } from '@/stores/glossary'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Autocomplete } from '@/components/ui/autocomplete'
import {
  FilterBar,
  filterRows,
  type ActiveFilter,
  type FilterAccessors,
  type FilterField,
} from '@/components/ui/filter-bar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import RichEditor from '@/components/editor/RichEditor.vue'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'

const route = useRoute()
const auth = useAuthStore()
const documents = useDocumentsStore()
const projects = useProjectsStore()
const glossaryStore = useGlossaryStore()
const workspaceId = getWorkspaceId()

const canEdit = computed(() => auth.canEdit)

// --- filters -----------------------------------------------------------------
// Project is a scope: it decides which roster is fetched. Everything else is a
// predicate over the rows already in memory — a project glossary is small.
const PROJECT_KEY = 'project'
const filters = ref<ActiveFilter[]>([
  { key: PROJECT_KEY, operator: 'is', values: getProjectId() ? [getProjectId()!] : [] },
])

const scopedProjectId = computed(
  () => filters.value.find((f) => f.key === PROJECT_KEY)?.values[0] ?? null,
)

const filterFields = computed<FilterField[]>(() => [
  {
    key: PROJECT_KEY,
    label: 'Project',
    icon: FolderKanban,
    pinned: true,
    multiple: false,
    operators: ['is'],
    options: projects.items.map((p) => ({ value: p.projectId, label: p.name })),
  },
  {
    key: 'source',
    label: 'Source',
    icon: Sparkles,
    options: [
      { value: 'manual', label: 'Written by hand' },
      { value: 'ai', label: 'Accepted from AI' },
    ],
  },
  {
    key: 'enabled',
    label: 'Linked in pages',
    icon: BookMarked,
    options: [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' },
    ],
  },
  {
    key: 'text',
    label: 'Term or definition',
    icon: Type,
    group: 'Text',
    type: 'text',
    placeholder: 'merge base…',
  },
])

const filterAccessors: FilterAccessors<GlossaryTerm> = {
  source: (t) => t.source,
  enabled: (t) => t.enabled,
  text: (t) => [t.term, t.definition, ...t.aliases],
}

const query = useQuery(
  computed(() =>
    apiQueryOptions('/v1/glossary', {
      query: { workspaceId, ...(scopedProjectId.value ? { projectId: scopedProjectId.value } : {}) },
    }),
  ),
)
const terms = computed(() => (query.data.value as ListGlossaryResponse | undefined)?.terms ?? [])
const visibleTerms = computed(() => filterRows(terms.value, filters.value, filterAccessors))

/**
 * Every write also refreshes the pinia roster, not just the query cache: the
 * roster is what already-open pages link against, so a definition edited here
 * has to reach them without a reload.
 */
const invalidates = () => [['/v1/glossary']]
const afterWrite = () => void glossaryStore.refresh()
const createTerm = useApiMutation('post', '/v1/glossary', { invalidates })
const updateTerm = useApiMutation('patch', '/v1/glossary/{id}', { invalidates })
const deleteTerm = useApiMutation('delete', '/v1/glossary/{id}', { invalidates })
const busy = computed(
  () => createTerm.isPending.value || updateTerm.isPending.value || deleteTerm.isPending.value,
)

// --- page picker -------------------------------------------------------------
const pageOptions = computed(() =>
  documents.items.map((d) => ({ value: d.documentId, label: d.title, meta: d.category })),
)
const pageLabel = (id: string) =>
  documents.items.find((d) => d.documentId === id)?.title ?? 'page'

// --- editor dialog -----------------------------------------------------------
const open = ref(false)
const editing = ref<GlossaryTerm | null>(null)
const form = ref({ term: '', definition: '', aliases: '', enabled: true })
/** Autocomplete carries 0-or-1 entry in single-select mode. */
const formDocument = ref<string[]>([])

function openNew(seed?: Partial<GlossaryTermSuggestion>) {
  editing.value = null
  form.value = {
    term: seed?.term ?? '',
    definition: seed?.definition ?? '',
    aliases: (seed?.aliases ?? []).join(', '),
    enabled: true,
  }
  formDocument.value = sourceDocument.value.length ? [...sourceDocument.value] : []
  open.value = true
}

function openEdit(term: GlossaryTerm) {
  if (!canEdit.value) return
  editing.value = term
  form.value = {
    term: term.term,
    definition: term.definition,
    aliases: term.aliases.join(', '),
    enabled: term.enabled,
  }
  formDocument.value = term.documentId ? [term.documentId] : []
  open.value = true
}

/** New terms land in the scoped project; edits never move an existing one. */
const targetProjectId = computed(() => scopedProjectId.value ?? projects.activeId)

async function submit() {
  const f = form.value
  const definition = (definitionEl.value?.flush() ?? f.definition).trim()
  if (!f.term.trim() || !definition) return
  const body = {
    term: f.term.trim(),
    definition,
    aliases: f.aliases.split(',').map((a) => a.trim()).filter(Boolean),
    documentId: formDocument.value[0] ?? null,
    enabled: f.enabled,
  }
  try {
    if (editing.value) {
      await updateTerm.mutateAsync({ path: { id: editing.value.termId }, body })
      toast.success('Term updated')
    } else {
      if (!targetProjectId.value) {
        toast.error('Choose a project first — vocabulary belongs to a project.')
        return
      }
      await createTerm.mutateAsync({
        body: { workspaceId, projectId: targetProjectId.value, ...body },
      })
      toast.success(`"${body.term}" added to the glossary`)
    }
    afterWrite()
    open.value = false
  } catch (e) {
    toast.error((e as Error).message)
  }
}

const definitionEl = ref<InstanceType<typeof RichEditor> | null>(null)

async function toggle(term: GlossaryTerm, enabled: boolean) {
  try {
    await updateTerm.mutateAsync({ path: { id: term.termId }, body: { enabled } })
    afterWrite()
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function remove(term: GlossaryTerm) {
  try {
    await deleteTerm.mutateAsync({ path: { id: term.termId } })
    afterWrite()
    toast.success(`Removed "${term.term}"`)
  } catch (e) {
    toast.error((e as Error).message)
  }
}

// --- AI extraction -----------------------------------------------------------
const sourceDocument = ref<string[]>([])
const suggestions = ref<GlossaryTermSuggestion[] | null>(null)
const suggestProjectId = ref<string | null>(null)
const assistantOff = ref(false)
const suggest = useApiMutation('post', '/v1/glossary/suggest')

async function runSuggest() {
  const documentId = sourceDocument.value[0]
  if (!documentId) return
  try {
    const res = (await suggest.mutateAsync({
      body: { workspaceId, documentId },
    })) as SuggestGlossaryTermsResponse
    assistantOff.value = !res.enabled
    suggestions.value = res.suggestions
    // The project comes back from the server — it is the source page's, not
    // whatever the bar happens to be scoped to.
    suggestProjectId.value = res.projectId
    if (res.enabled && res.suggestions.length === 0) {
      toast.info('Nothing new — every term on that page is already defined.')
    }
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function accept(suggestion: GlossaryTermSuggestion) {
  const projectId = suggestProjectId.value ?? targetProjectId.value
  if (!projectId) return
  try {
    await createTerm.mutateAsync({
      body: {
        workspaceId,
        projectId,
        term: suggestion.term,
        definition: suggestion.definition,
        aliases: suggestion.aliases,
        documentId: sourceDocument.value[0] ?? null,
        source: 'ai',
      },
    })
    afterWrite()
    dismiss(suggestion)
    toast.success(`"${suggestion.term}" added`)
  } catch (e) {
    toast.error((e as Error).message)
  }
}

function dismiss(suggestion: GlossaryTermSuggestion) {
  suggestions.value = (suggestions.value ?? []).filter((s) => s.term !== suggestion.term)
}

onMounted(() => {
  if (!documents.loaded) void documents.fetchList()
  if (!projects.loaded) void projects.fetchList()
})

// Glossary links point here with ?term=… so a reader can jump from a word in a
// page straight to the entry that defines it.
const highlighted = computed(() => (typeof route.query.term === 'string' ? route.query.term : null))
watch(highlighted, (id) => {
  // Arriving at a specific entry must not land on a filtered-out row.
  if (id) filters.value = filters.value.filter((f) => f.key === PROJECT_KEY)
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="font-display text-2xl font-bold tracking-tight">Glossary</h1>
        <p class="text-muted-foreground max-w-2xl text-sm">
          The words this project uses precisely. Every page links them automatically as it renders — nothing is
          written into the documents themselves, so editing a definition here updates it everywhere.
        </p>
      </div>
      <Button v-if="canEdit" size="sm" @click="openNew()"><Plus class="size-3.5" /> New term</Button>
    </div>

    <!-- AI extraction -->
    <section v-if="canEdit" class="space-y-3 rounded-lg border bg-card p-3">
      <div class="flex flex-wrap items-end gap-2">
        <Sparkles class="text-primary mb-2 size-4 shrink-0" />
        <div class="min-w-56 flex-1">
          <Autocomplete
            v-model="sourceDocument"
            label="Build the glossary from a page"
            placeholder="Find a page…"
            :multiple="false"
            :options="pageOptions"
            :fallback-label="pageLabel"
            empty-hint="No pages in this project yet."
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          :disabled="!sourceDocument.length || suggest.isPending.value"
          @click="runSuggest"
        >
          <Wand2 class="size-3.5" />
          {{ suggest.isPending.value ? 'Reading…' : 'Suggest terms' }}
        </Button>
      </div>

      <p v-if="assistantOff" class="text-muted-foreground text-xs">
        The assistant is disabled for this workspace — configure a provider under Settings → AI to extract terms.
      </p>

      <ul v-if="suggestions?.length" class="divide-y rounded-md border">
        <li v-for="s in suggestions" :key="s.term" class="flex flex-wrap items-start gap-3 p-3">
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-center gap-2 text-sm font-medium">
              {{ s.term }}
              <Badge variant="secondary" class="font-normal">{{ s.occurrences }}× on the page</Badge>
              <Badge v-if="s.existingTermId" variant="outline">already defined</Badge>
            </p>
            <p class="text-muted-foreground text-sm">{{ s.definition }}</p>
            <p v-if="s.aliases.length" class="text-muted-foreground mt-1 text-xs">
              also: {{ s.aliases.join(', ') }}
            </p>
          </div>
          <div class="flex shrink-0 gap-1">
            <Button size="xs" :disabled="busy || !!s.existingTermId" @click="accept(s)">Add</Button>
            <Button size="xs" variant="ghost" @click="openNew(s)">Edit…</Button>
            <Button size="xs" variant="ghost" @click="dismiss(s)">Skip</Button>
          </div>
        </li>
      </ul>
    </section>

    <FilterBar v-model="filters" :fields="filterFields" empty-label="Filter terms" />

    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton v-for="i in 4" :key="i" class="h-10 w-full" />
    </div>

    <div v-else-if="visibleTerms.length === 0" class="text-muted-foreground py-12 text-center text-sm">
      <BookMarked class="mx-auto mb-2 size-6 opacity-50" />
      <p v-if="terms.length">No term matches these filters.</p>
      <p v-else>No terms yet. Add one, or let the assistant read a page and propose some.</p>
    </div>

    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead>Term</TableHead>
          <TableHead>Definition</TableHead>
          <TableHead class="w-40">Defined in</TableHead>
          <TableHead class="w-24">Linked</TableHead>
          <TableHead class="w-12"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow
          v-for="term in visibleTerms"
          :key="term.termId"
          :class="highlighted === term.termId ? 'bg-primary/5' : ''"
        >
          <TableCell class="align-top">
            <button class="text-left" :disabled="!canEdit" @click="openEdit(term)">
              <span class="font-medium" :class="canEdit && 'hover:text-primary'">{{ term.term }}</span>
              <span v-if="term.aliases.length" class="text-muted-foreground block text-xs">
                {{ term.aliases.join(', ') }}
              </span>
            </button>
            <Badge v-if="term.source === 'ai'" variant="outline" class="mt-1 font-normal">AI</Badge>
          </TableCell>
          <TableCell class="align-top text-sm">
            <MarkdownView :markdown="term.definition" />
          </TableCell>
          <TableCell class="align-top">
            <RouterLink
              v-if="term.documentId"
              :to="`/documents/${term.documentId}`"
              class="text-primary text-sm hover:underline"
            >
              {{ term.documentTitle ?? 'page' }}
            </RouterLink>
            <span v-else class="text-muted-foreground text-xs">—</span>
          </TableCell>
          <TableCell class="align-top">
            <Checkbox
              :model-value="term.enabled"
              :disabled="!canEdit"
              :aria-label="`Link ${term.term} in documents`"
              @update:model-value="toggle(term, $event === true)"
            />
          </TableCell>
          <TableCell class="align-top text-right">
            <Button
              v-if="canEdit"
              variant="ghost"
              size="sm"
              :aria-label="`Delete ${term.term}`"
              @click="remove(term)"
            >
              <Trash2 class="size-3.5" />
            </Button>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>

    <Dialog v-model:open="open">
      <DialogContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ editing ? 'Edit term' : 'New term' }}</DialogTitle>
          <DialogDescription>
            The term and its aliases are what pages are matched against; the definition is what readers see when
            they hover one.
          </DialogDescription>
        </DialogHeader>

        <form id="glossary-form" class="space-y-4" @submit.prevent="submit">
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">Term</span>
            <Input v-model="form.term" required placeholder="Merge base" />
          </label>
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">Aliases (comma separated)</span>
            <Input v-model="form.aliases" placeholder="merge-base, common ancestor" />
          </label>
          <div class="space-y-1">
            <span class="text-muted-foreground text-xs font-medium">Definition</span>
            <div
              class="focus-within:border-ring focus-within:ring-ring/25 overflow-hidden rounded-md border bg-card shadow-xs transition-[border-color,box-shadow] duration-150 focus-within:ring-3"
            >
              <RichEditor
                ref="definitionEl"
                v-model="form.definition"
                compact
                placeholder="The nearest common ancestor of two revisions in the DAG."
              />
            </div>
          </div>
          <Autocomplete
            v-model="formDocument"
            label="Defined in (optional)"
            placeholder="Find a page…"
            :multiple="false"
            :options="pageOptions"
            :fallback-label="pageLabel"
            empty-hint="No pages to link to yet."
          />
          <label class="flex items-center gap-2">
            <Checkbox :model-value="form.enabled" @update:model-value="form.enabled = $event === true" />
            <span class="text-sm">Link this term in documents</span>
          </label>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" @click="open = false">Cancel</Button>
          <Button type="submit" form="glossary-form" size="sm" :disabled="busy">
            {{ editing ? 'Save' : 'Create' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
