<script setup lang="ts">
/**
 * One body's schema as a field tree (#78): the type line, an Expand all /
 * Collapse all toggle, then the rows (ApiSchemaTree).
 *
 * Which rows are open lives here, keyed by the path of names from the root,
 * so Expand all can reach every level and a row keeps its state while its
 * parent closes and opens again. A recursion opened on request is built once
 * (`expandRecursive`) and kept, so closing it is free and reopening it costs
 * nothing.
 *
 * Expand all opens what the tree already holds and never follows a
 * recursion: a self-referencing type grows one level per click, never by
 * itself.
 */
import { computed, provide, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-vue-next'
import { expandRecursive, type SchemaNode } from '@/entities/api-operation/model/api-spec'
import ApiSchemaTree from './ApiSchemaTree.vue'
import { SCHEMA_TREE, type SchemaTreeState } from '../model/schema-tree'

const props = defineProps<{ document: Record<string, unknown>; nodes: SchemaNode[]; type: string }>()
const { t } = useI18n()

const open = ref(new Set<string>())
const loaded = ref(new Map<string, SchemaNode[]>())

function childrenOf(path: string, node: SchemaNode): SchemaNode[] {
  return node.lazy ? (loaded.value.get(path) ?? []) : node.children
}

function toggle(path: string, node: SchemaNode) {
  const next = new Set(open.value)
  if (next.has(path)) next.delete(path)
  else {
    next.add(path)
    if (node.lazy && !loaded.value.has(path)) loaded.value = new Map(loaded.value).set(path, expandRecursive(props.document, node))
  }
  open.value = next
}

/** Every path Expand all may open: rows with children of their own, never a recursion not yet opened by hand. */
const openable = computed(() => {
  const out: string[] = []
  const walk = (nodes: SchemaNode[], prefix: string) => {
    for (const n of nodes) {
      const path = `${prefix}/${n.name}`
      const kids = n.lazy ? loaded.value.get(path) : n.children
      if (!kids?.length) continue
      out.push(path)
      walk(kids, path)
    }
  }
  walk(props.nodes, '')
  return out
})
const allOpen = computed(() => openable.value.length > 0 && openable.value.every((p) => open.value.has(p)))
function setAll(next: boolean) {
  open.value = next ? new Set([...open.value, ...openable.value]) : new Set()
}

provide<SchemaTreeState>(SCHEMA_TREE, {
  uid: useId(),
  isOpen: (path) => open.value.has(path),
  toggle,
  childrenOf,
})
</script>

<template>
  <div class="kn-schema min-w-0">
    <div class="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <code class="font-mono text-ui font-medium text-[color-mix(in_oklab,var(--foreground)_80%,var(--card))]">{{ type }}</code>
      <button v-if="openable.length" type="button" class="kn-schema-all" :aria-pressed="allOpen" @click="setAll(!allOpen)">
        <component :is="allOpen ? ChevronsDownUp : ChevronsUpDown" class="size-3.5" aria-hidden="true" />
        {{ allOpen ? t('apiRef.collapseAll') : t('apiRef.expandAll') }}
      </button>
    </div>
    <ApiSchemaTree v-if="nodes.length" :nodes="nodes" path="" />
    <p v-else class="text-sm text-muted-foreground">{{ t('apiRef.schema.noFields') }}</p>
  </div>
</template>

<style scoped>
.kn-schema-all {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  height: 1.75rem;
  padding-inline: 0.5rem;
  border-radius: 6px;
  font-size: var(--kn-text-ui);
  color: var(--muted-foreground);
  transition: background-color 120ms ease-out, color 120ms ease-out;
}
.kn-schema-all:hover {
  color: var(--foreground);
  background: var(--accent);
}
.kn-schema-all:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}
</style>
