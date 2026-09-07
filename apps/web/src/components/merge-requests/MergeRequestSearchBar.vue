<script setup lang="ts">
/**
 * GitLab-style filtered search: one bar that is both the search box and the
 * filter control. Chips live *inside* it, and every filter is chosen from the
 * input's own dropdown — there is no second funnel offering the same fields,
 * which is the duplication a separate search box + filter bar creates.
 *
 * The bar does two jobs without them colliding:
 * - what: the typed text narrows the list by title, live, as you type.
 * - who / where: the dropdown turns that same text into a filter token —
 *   "Alice · Author", "“auth” · Source branch" — which lands as a chip.
 *
 * The dropdown never lists merge requests, so it cannot cover the results the
 * same keystrokes just filtered. Picking a token clears the text, because the
 * text was how you found the token rather than a title filter of its own.
 *
 * Every field here is a param `GET /v1/merge-requests` actually serves: the
 * list is cursor-paginated, so a filter the browser applied to the loaded page
 * would disagree with the tab counts and with "Load more" (see mr-filters.ts).
 */
import { computed, nextTick, ref, watch } from 'vue'
import { refDebounced } from '@vueuse/core'
import {
  GitBranch,
  GitMerge,
  Search,
  UserRound,
  UserRoundCheck,
  UserRoundPlus,
} from 'lucide-vue-next'
import { Autocomplete, type AutocompleteOption } from '@/components/ui/autocomplete'
import {
  FilterChip,
  defaultOperators,
  type ActiveFilter,
  type FilterField,
  type FilterOperator,
} from '@/components/ui/filter-bar'
import { useAuthStore } from '@/stores/auth'
import { setFilterValue, type MrFilterKey } from './mr-filters'
import { useMembers } from './use-members'

const props = defineProps<{ filters: ActiveFilter[]; search: string }>()
const emit = defineEmits<{
  'update:filters': [ActiveFilter[]]
  'update:search': [string]
}>()

const auth = useAuthStore()
const { members } = useMembers()

/** People axes share the member roster; only the param they set differs. */
const PEOPLE_FIELDS = [
  { key: 'author', label: 'Author', icon: UserRound, mine: 'Opened by me' },
  { key: 'assignee', label: 'Assignee', icon: UserRoundPlus, mine: 'Assigned to me' },
  { key: 'reviewer', label: 'Reviewer', icon: UserRoundCheck, mine: 'Review requested from me' },
] as const

/** Branches have no workspace-wide roster, so their value is typed, not picked. */
const BRANCH_FIELDS = [
  { key: 'sourceBranch', label: 'Source branch', icon: GitBranch },
  { key: 'targetBranch', label: 'Target branch', icon: GitMerge },
] as const

// --- title text ------------------------------------------------------------
// The field is the only writer, so this mirrors rather than syncs. Debounced
// because every change is a request; the server does the matching.
const typed = ref(props.search)
const debouncedTyped = refDebounced(typed, 300)

watch(debouncedTyped, (value) => {
  const next = value.trim()
  if (next !== props.search) emit('update:search', next)
})

// ...and back, so a reset from elsewhere on the page (the empty state's "clear")
// empties the field too. Comparing against the trimmed text keeps the two from
// fighting over a trailing space.
watch(
  () => props.search,
  (value) => {
    if (value !== typed.value.trim()) typed.value = value
  },
)

// --- fields ----------------------------------------------------------------
/** Role is the one thing that tells two same-named colleagues apart. */
const memberOptions = computed(() =>
  members.value.map((m) => ({ value: m.userId, label: m.displayName, meta: m.role })),
)

// People are single-value `is`: the API takes one id per field and has no
// negation, so offering "is not" or a second value would promise a query the
// server cannot answer. A fixed operator renders as plain text, not a button.
const fields = computed<FilterField[]>(() => [
  ...PEOPLE_FIELDS.map((f) => ({
    key: f.key,
    label: f.label,
    icon: f.icon,
    options: memberOptions.value,
    multiple: false,
    operators: ['is'] as FilterOperator[],
  })),
  ...BRANCH_FIELDS.map((f) => ({
    key: f.key,
    label: f.label,
    icon: f.icon,
    type: 'text' as const,
    // Substring, matching the server: "auth" should find "feature/auth".
    operators: ['contains'] as FilterOperator[],
    placeholder: 'feature/…',
  })),
])

const fieldsByKey = computed(() => new Map(fields.value.map((f) => [f.key, f])))

const chipEntries = computed(() =>
  props.filters
    .map((filter, index) => ({ filter, index, field: fieldsByKey.value.get(filter.key) }))
    .filter((e): e is { filter: ActiveFilter; index: number; field: FilterField } => !!e.field),
)

// --- dropdown tokens -------------------------------------------------------
/**
 * What picking an option does. Held beside the options rather than encoded in
 * their ids, so a branch value containing any separator stays intact.
 */
type TokenAction =
  | { kind: 'set'; key: MrFilterKey; operator: FilterOperator; value: string }
  | { kind: 'field'; key: MrFilterKey }

const actions = new Map<string, TokenAction>()

async function loadTokens(query: string): Promise<AutocompleteOption[]> {
  const text = query.trim()
  const needle = text.toLowerCase()
  const options: AutocompleteOption[] = []
  actions.clear()

  const add = (id: string, label: string, meta: string, action: TokenAction) => {
    actions.set(id, action)
    options.push({ value: id, label, meta })
  }

  // Empty field: the views this page is opened for, then the fields themselves
  // so filtering is discoverable without knowing a name to type. Review leads —
  // the first option is pre-highlighted, so focus + Enter reaches "waiting on
  // me" without touching the mouse.
  if (!needle) {
    const meId = auth.me?.userId
    if (meId) {
      for (const f of [...PEOPLE_FIELDS].reverse()) {
        add(`me:${f.key}`, f.mine, f.label, { kind: 'set', key: f.key, operator: 'is', value: meId })
      }
    }
    for (const f of [...PEOPLE_FIELDS, ...BRANCH_FIELDS]) {
      if (props.filters.some((active) => active.key === f.key)) continue
      add(`field:${f.key}`, f.label, 'Filter', { kind: 'field', key: f.key })
    }
    return options
  }

  // Typed text: every axis it could mean. People first — a name is the more
  // likely reading of a word than a branch fragment.
  for (const m of members.value) {
    if (!m.displayName.toLowerCase().includes(needle) && !m.email.toLowerCase().includes(needle)) {
      continue
    }
    for (const f of PEOPLE_FIELDS) {
      add(`set:${f.key}:${m.userId}`, m.displayName, f.label, {
        kind: 'set',
        key: f.key,
        operator: 'is',
        value: m.userId,
      })
    }
  }
  for (const f of BRANCH_FIELDS) {
    add(`branch:${f.key}`, `“${text}”`, f.label, {
      kind: 'set',
      key: f.key,
      operator: 'contains',
      value: text,
    })
  }
  return options
}

/**
 * The field holds no selection — a picked token becomes a chip and the box
 * goes back to being empty and ready to type in.
 */
const picked = ref<string[]>([])
const chips = ref<InstanceType<typeof FilterChip>[]>([])

watch(picked, (values) => {
  const id = values[0]
  if (!id) return
  picked.value = []
  const action = actions.get(id)
  if (!action) return

  if (action.kind === 'set') {
    emit('update:filters', setFilterValue(props.filters, action.key, action.operator, action.value))
    return
  }

  // A field chosen with no value yet. Add the chip, then open its value picker
  // (or focus its input) — adding a filter and filling it is one gesture.
  const field = fieldsByKey.value.get(action.key)
  if (!field || props.filters.some((f) => f.key === action.key)) return
  emit('update:filters', [
    ...props.filters,
    { key: action.key, operator: defaultOperators(field)[0], values: [] },
  ])
  void nextTick(() => chips.value.at(-1)?.openValues())
})

// --- chip edits ------------------------------------------------------------
function updateAt(index: number, next: ActiveFilter) {
  emit('update:filters', props.filters.map((f, i) => (i === index ? next : f)))
}
function removeAt(index: number) {
  emit('update:filters', props.filters.filter((_, i) => i !== index))
}

const hasNarrowing = computed(() => props.filters.length > 0 || typed.value !== '')
function clearAll() {
  typed.value = ''
  emit('update:filters', [])
  emit('update:search', '')
}
</script>

<template>
  <div
    class="flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border bg-background px-2 py-1 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
  >
    <Search class="size-3.5 shrink-0 text-muted-foreground" />

    <FilterChip
      v-for="entry in chipEntries"
      ref="chips"
      :key="entry.filter.key"
      :filter="entry.filter"
      :field="entry.field"
      @update="(next) => updateAt(entry.index, next)"
      @remove="removeAt(entry.index)"
    />

    <!-- Wide enough that the dropdown, which is sized to this input, stays
         readable once several chips have pushed it along the row. -->
    <div class="min-w-56 flex-1">
      <Autocomplete
        :model-value="picked"
        label="Search merge requests"
        hide-label
        bare
        placeholder="Search or filter…"
        :multiple="false"
        :load="loadTokens"
        :query="typed"
        @update:model-value="picked = $event"
        @update:query="typed = $event"
      />
    </div>

    <button
      v-if="hasNarrowing"
      type="button"
      class="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      @click="clearAll"
    >
      Clear
    </button>
  </div>
</template>
