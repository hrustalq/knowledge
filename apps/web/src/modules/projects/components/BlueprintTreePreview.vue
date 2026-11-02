<script setup lang="ts">
/**
 * A blueprint's page tree, read-only (#716): the settings pane, the save
 * dialog and the empty "From a project" gallery. Indent is depth; a collection
 * shows its title pattern, and its initial items their numbered titles — the
 * same titles the scaffold will write (`itemTitles`).
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Layers } from 'lucide-vue-next'
import { blueprintText, type BlueprintNode, type Locale } from '@knowledge/contracts'
import { itemTitles } from '@/modules/projects/model/blueprint-tree'

const props = withDefaults(defineProps<{ tree: BlueprintNode[]; locale: Locale; max?: number }>(), { max: Infinity })

const { t } = useI18n()

interface Row {
  key: string
  depth: number
  title: string
  pattern: string
  isCollection: boolean
}

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (nodes: BlueprintNode[], depth: number, parent: BlueprintNode | null, prefix: string) => {
    const titles = parent?.collection ? itemTitles(parent, props.locale) : []
    nodes.forEach((node, i) => {
      const key = `${prefix}${i}`
      out.push({
        key,
        depth,
        title: titles[i] ?? blueprintText(node.title, props.locale),
        pattern: blueprintText(node.collection?.childTitlePattern, props.locale).trim(),
        isCollection: !!node.collection,
      })
      walk(node.children ?? [], depth + 1, node, `${key}.`)
    })
  }
  walk(props.tree, 0, null, '')
  return out
})
const shown = computed(() => rows.value.slice(0, props.max))
</script>

<template>
  <p v-if="!rows.length" class="text-muted-foreground text-ui">{{ t('scaffold.start.noPages') }}</p>
  <ul v-else class="space-y-px text-ui">
    <li
      v-for="row in shown"
      :key="row.key"
      class="flex min-w-0 items-baseline gap-2 py-0.5"
      :style="{ paddingInlineStart: `${row.depth * 1.125}rem` }"
    >
      <span class="min-w-0 truncate" :class="row.depth ? 'text-muted-foreground' : 'font-medium'">{{ row.title }}</span>
      <span v-if="row.isCollection" class="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-caption" :title="t('scaffold.shape.collectionChip')">
        <Layers class="size-3" aria-hidden="true" />
        <span class="sr-only">{{ t('scaffold.shape.collection') }}</span>
        <code v-if="row.pattern" class="font-mono">{{ row.pattern }}…</code>
      </span>
    </li>
    <li v-if="rows.length > shown.length" class="text-muted-foreground py-0.5 text-caption">
      {{ t('blueprints.morePages', { count: rows.length - shown.length }, rows.length - shown.length) }}
    </li>
  </ul>
</template>
