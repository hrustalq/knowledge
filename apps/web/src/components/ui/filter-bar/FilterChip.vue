<script setup lang="ts">
/**
 * One active filter, as a segmented pill: `field · operator · value ·  ×`.
 * Every segment but the field is interactive — the operator cycles through the
 * field's allowed set, the value opens a picker (or is typed inline for a text
 * field), and the last segment removes the filter.
 */
import { computed, ref } from 'vue'
import { X } from 'lucide-vue-next'
import { Input } from '@/components/ui/input'
import FilterPopover from './FilterPopover.vue'
import { OPERATOR_LABELS, defaultOperators, type ActiveFilter, type FilterField } from './types'

const props = defineProps<{ filter: ActiveFilter; field: FilterField }>()
const emit = defineEmits<{ update: [ActiveFilter]; remove: [] }>()

const valueMenu = ref<InstanceType<typeof FilterPopover> | null>(null)
const operators = computed(() => defaultOperators(props.field))
const isText = computed(() => props.field.type === 'text')
/** One allowed operator has nothing to cycle to — render it as plain text. */
const operatorIsFixed = computed(() => operators.value.length < 2)
const multiple = computed(() => props.field.multiple !== false)

const optionsByValue = computed(
  () => new Map((props.field.options ?? []).map((o) => [o.value, o])),
)

/** One selected value renders with its icon; several collapse to "+N". */
const selected = computed(() => props.filter.values.map((v) => optionsByValue.value.get(v)))
const soleOption = computed(() => (selected.value.length === 1 ? selected.value[0] : undefined))

const valueLabel = computed(() => {
  if (isText.value) return props.filter.values[0] ?? ''
  const labels = selected.value.map((o, i) => o?.label ?? props.filter.values[i])
  if (labels.length === 0) return 'any'
  if (labels.length === 1) return labels[0]
  return `${labels[0]} +${labels.length - 1}`
})

function cycleOperator() {
  const list = operators.value
  const next = list[(list.indexOf(props.filter.operator) + 1) % list.length]
  emit('update', { ...props.filter, operator: next })
}

function setValues(values: string[]) {
  emit('update', { ...props.filter, values })
}

// The bar opens a freshly added chip's roster, so adding a filter and choosing
// its value stays one gesture.
defineExpose({ openValues: () => valueMenu.value?.openMenu() })
</script>

<template>
  <div class="bg-card flex h-7 items-center overflow-hidden rounded-md border text-xs">
    <span class="text-foreground flex items-center gap-1.5 px-2">
      <component :is="field.icon" v-if="field.icon" class="text-muted-foreground size-3.5" />
      {{ field.label }}
    </span>

    <span
      v-if="operatorIsFixed"
      class="text-muted-foreground flex h-full items-center border-l px-2"
    >{{ OPERATOR_LABELS[filter.operator] }}</span>
    <button
      v-else
      type="button"
      class="text-muted-foreground hover:bg-accent hover:text-foreground h-full border-l px-2 transition-colors"
      :title="`Change operator (${operators.map((o) => OPERATOR_LABELS[o]).join(' / ')})`"
      @click="cycleOperator"
    >
      {{ OPERATOR_LABELS[filter.operator] }}
    </button>

    <!-- Text fields type in place; select fields open the value roster. -->
    <div v-if="isText" class="h-full border-l">
      <Input
        :model-value="filter.values[0] ?? ''"
        :placeholder="field.placeholder ?? 'type a value…'"
        class="h-full w-36 rounded-none border-0 bg-transparent px-2 text-xs shadow-none focus-visible:ring-0 md:text-xs dark:bg-transparent"
        @update:model-value="(v) => setValues([String(v)])"
      />
    </div>
    <FilterPopover
      v-else
      ref="valueMenu"
      :multiple="multiple"
      :items="field.options ?? []"
      :model-value="filter.values"
      :search-placeholder="`Filter ${field.label.toLowerCase()}…`"
      @update:model-value="setValues"
      @select="(v) => setValues([v])"
    >
      <template #trigger="{ toggle }">
        <button
          type="button"
          class="text-foreground hover:bg-accent flex h-full max-w-48 items-center gap-1.5 border-l px-2 transition-colors"
          @click="toggle"
        >
          <component
            :is="soleOption.icon"
            v-if="soleOption?.icon"
            class="text-muted-foreground size-3.5 shrink-0"
          />
          <span class="truncate" :class="filter.values.length === 0 ? 'text-muted-foreground' : ''">
            {{ valueLabel }}
          </span>
        </button>
      </template>
    </FilterPopover>

    <!-- A pinned field is a scope the page always has; there is no "off". -->
    <button
      v-if="!field.pinned"
      type="button"
      class="text-muted-foreground hover:bg-accent hover:text-foreground h-full border-l px-1.5 transition-colors"
      :aria-label="`Remove ${field.label} filter`"
      @click="emit('remove')"
    >
      <X class="size-3.5" />
    </button>
  </div>
</template>
