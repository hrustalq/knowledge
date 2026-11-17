<script setup lang="ts" generic="T extends string">
/**
 * One question's answers as hairline cards (#1225). Real radios or checkboxes
 * under the card, so arrow keys, Space and a screen reader's "2 of 5" all come
 * from the platform; the card is only the label made large.
 */
export interface Choice<V extends string> {
  value: V
  label: string
  hint?: string
}

const props = defineProps<{
  legend: string
  name: string
  options: Choice<T>[]
  multiple?: boolean
  /** Shown beside the legend: why the current pick is what it is. */
  note?: string
  /** Narrow cards in a grid (a list of tools) rather than one per row. */
  compact?: boolean
  /** The step's heading already asks the question: keep the legend for screen readers only. */
  quietLegend?: boolean
}>()
const model = defineModel<T | T[] | null>({ required: true })

function checked(value: T): boolean {
  return Array.isArray(model.value) ? model.value.includes(value) : model.value === value
}

function pick(value: T, on: boolean) {
  if (!props.multiple) {
    model.value = value
    return
  }
  const now = Array.isArray(model.value) ? model.value : []
  model.value = on ? [...now, value] : now.filter((v) => v !== value)
}
</script>

<template>
  <fieldset class="grid min-w-0 gap-2">
    <legend
      :class="quietLegend && !note ? 'sr-only' : 'mb-2 flex flex-wrap items-baseline gap-x-2 text-xs font-medium text-muted-foreground'"
    >
      <span :class="{ 'sr-only': quietLegend }">{{ legend }}</span>
      <span v-if="note" class="font-normal">{{ quietLegend ? note : `· ${note}` }}</span>
    </legend>
    <div :class="compact ? 'grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-2' : 'grid gap-2'">
      <label
        v-for="o in options"
        :key="o.value"
        class="kn-choice group flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border bg-card px-3.5 py-3 transition-colors hover:bg-accent/40"
        :class="checked(o.value) ? 'border-primary/50 bg-primary/5' : ''"
      >
        <input
          :type="multiple ? 'checkbox' : 'radio'"
          :name="name"
          :value="o.value"
          :checked="checked(o.value)"
          class="mt-0.5 size-4 shrink-0 accent-primary"
          @change="pick(o.value, ($event.target as HTMLInputElement).checked)"
        />
        <span class="min-w-0">
          <span class="block text-sm font-medium wrap-anywhere">{{ o.label }}</span>
          <span v-if="o.hint" class="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{{ o.hint }}</span>
        </span>
      </label>
    </div>
  </fieldset>
</template>

<style scoped>
/* The focus ring goes on the card: the native control is small, the card is what the eye follows. */
.kn-choice:has(input:focus-visible) {
  outline: none;
  box-shadow: 0 0 0 3px var(--ring);
  border-color: var(--ring);
}
</style>
