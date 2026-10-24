<script setup lang="ts">
/**
 * Name → value rows for a test fixture (#483): inputs, a request's path, query
 * and headers, and captures. Rows are removed by their own button and added at
 * the end; focus moves to the new row's name so a keyboard user keeps typing.
 */
import { nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Row } from '@/lib/test-fixture'

const rows = defineModel<Row[]>({ required: true })
defineProps<{
  legend: string
  namePlaceholder: string
  valuePlaceholder: string
  addLabel: string
  /** Monospace values: captures and request values are code; input defaults are too. */
  mono?: boolean
  /** The section already has a visible heading; keep the legend for screen readers only. */
  legendHidden?: boolean
  /** Values are secrets (a test environment's): typed into a password field. */
  secret?: boolean
}>()
const { t } = useI18n()
const list = ref<HTMLElement | null>(null)

async function add() {
  rows.value = [...rows.value, { name: '', value: '' }]
  await nextTick()
  list.value?.querySelector<HTMLInputElement>('li:last-child input')?.focus()
}

function remove(i: number) {
  rows.value = rows.value.filter((_, n) => n !== i)
}
</script>

<template>
  <fieldset class="min-w-0 space-y-1.5">
    <legend class="text-caption text-muted-foreground mb-1 font-medium" :class="legendHidden && 'sr-only'">{{ legend }}</legend>
    <ul v-if="rows.length" ref="list" class="space-y-1.5">
      <li v-for="(row, i) in rows" :key="i" class="flex min-w-0 items-center gap-1.5">
        <Input
          v-model="row.name"
          :aria-label="`${legend}: ${namePlaceholder}`"
          :placeholder="namePlaceholder"
          spellcheck="false"
          autocapitalize="off"
          class="h-8 w-[38%] min-w-0 font-mono text-ui"
        />
        <Input
          v-model="row.value"
          :aria-label="`${legend}: ${valuePlaceholder}`"
          :placeholder="valuePlaceholder"
          :type="secret ? 'password' : 'text'"
          :autocomplete="secret ? 'new-password' : 'off'"
          spellcheck="false"
          autocapitalize="off"
          class="h-8 min-w-0 flex-1 text-ui"
          :class="mono && 'font-mono'"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="text-muted-foreground size-8 shrink-0"
          :aria-label="t('testFixture.removeRow', { name: row.name || legend })"
          @click="remove(i)"
        >
          <X class="size-3.5" />
        </Button>
      </li>
    </ul>
    <Button type="button" variant="ghost" size="sm" class="text-muted-foreground -ml-2 h-7" @click="add">
      <Plus class="size-3.5" /> {{ addLabel }}
    </Button>
  </fieldset>
</template>
