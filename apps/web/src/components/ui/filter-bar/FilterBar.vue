<script setup lang="ts">
/**
 * Data-driven filter bar. A page declares `fields` and binds `v-model` to an
 * `ActiveFilter[]`; `matchesFilters`/`filterRows` turn that into a predicate.
 *
 * Adding a field that is already on the bar focuses the existing chip rather
 * than stacking a second one — two chips over the same field read as an
 * impossible AND ("role is admin and role is viewer") far more often than as
 * what the user meant.
 */
import { useI18n } from 'vue-i18n'
import { computed, nextTick, ref } from 'vue'
import { ListFilter } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import FilterChip from './FilterChip.vue'
import FilterPopover from './FilterPopover.vue'
import { defaultOperators, type ActiveFilter, type FilterField } from './types'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    modelValue: ActiveFilter[]
    fields: FilterField[]
    /** Shown next to the funnel while the bar is empty. */
    emptyLabel?: string
  }>(),
  // Default only; every caller passes a specific empty-label. Left untranslated
  // here because a prop default is evaluated at module scope, outside any app's
  // i18n instance — the fallback below resolves it at render (docs/features/18).
  {},
)

const emit = defineEmits<{ 'update:modelValue': [ActiveFilter[]] }>()

const chips = ref<InstanceType<typeof FilterChip>[]>([])
const fieldsByKey = computed(() => new Map(props.fields.map((f) => [f.key, f])))

// Pinned fields are scopes the page owns — they are always on the bar, so
// offering them here would only ever be a no-op.
const pickerItems = computed(() =>
  props.fields
    .filter((f) => !f.pinned)
    .map((f) => ({
      value: f.key,
      label: f.label,
      icon: f.icon,
      group: f.group,
    })),
)

const clearable = computed(() =>
  props.modelValue.filter((f) => !fieldsByKey.value.get(f.key)?.pinned),
)

/**
 * Chips paired with their field, dropping any whose field is unknown — a page
 * can restore filters (from a URL, say) before the roster that defines them
 * has loaded, and a chip with no field has nothing to render.
 */
const chipEntries = computed(() =>
  props.modelValue
    .map((filter, index) => ({ filter, index, field: fieldsByKey.value.get(filter.key) }))
    .filter((entry): entry is { filter: ActiveFilter; index: number; field: FilterField } =>
      entry.field !== undefined,
    ),
)

function addField(key: string) {
  const field = fieldsByKey.value.get(key)
  if (!field) return
  if (props.modelValue.some((f) => f.key === key)) return
  emit('update:modelValue', [
    ...props.modelValue,
    { key, operator: defaultOperators(field)[0], values: [] },
  ])
  // Let the new chip mount, then open its value picker — adding a filter and
  // immediately choosing a value is one gesture, not two.
  void nextTick(() => chips.value.at(-1)?.openValues())
}

function updateAt(index: number, next: ActiveFilter) {
  emit('update:modelValue', props.modelValue.map((f, i) => (i === index ? next : f)))
}

function removeAt(index: number) {
  emit('update:modelValue', props.modelValue.filter((_, i) => i !== index))
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <FilterChip
      v-for="entry in chipEntries"
      ref="chips"
      :key="entry.filter.key"
      :filter="entry.filter"
      :field="entry.field"
      @update="(next) => updateAt(entry.index, next)"
      @remove="removeAt(entry.index)"
    />

    <Button
      v-if="clearable.length > 0"
      variant="ghost"
      size="sm"
      class="h-7 px-2 text-xs"
      @click="emit('update:modelValue', modelValue.filter((f) => fieldsByKey.get(f.key)?.pinned))"
    >
      Clear
    </Button>

    <FilterPopover
      :items="pickerItems"
      search-placeholder="Filter…"
      empty-label="No filters left"
      @select="addField"
    >
      <template #trigger="{ toggle }">
        <button
          type="button"
          class="text-muted-foreground hover:bg-accent hover:text-foreground flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors"
          :aria-label="emptyLabel ?? t('common.filter')"
          @click="toggle"
        >
          <ListFilter class="size-3.5" />
          <span v-if="clearable.length === 0">{{ emptyLabel ?? t('common.filter') }}</span>
        </button>
      </template>
    </FilterPopover>
  </div>
</template>
