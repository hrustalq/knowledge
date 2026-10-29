<script setup lang="ts">
/**
 * One level of a schema's field tree (#78). A row is name, type and Swagger's
 * `* required`; under it the description and any enum values. A row that
 * holds more says how much while closed ("3 fields", "array of 2 fields",
 * "one of 2 variants") and opens in place on the app's Collapse.
 *
 * Each level hangs from a rail in the card's method hue, with a short tick to
 * each row, so depth reads as a drawn tree rather than as indentation. The
 * toggle is the name itself — a real button with `aria-expanded` — and every
 * row keeps a 20px chevron slot, so names line up whether or not they open.
 *
 * A recursion (`↻ User`) opens one more level when asked (ApiSchema loads it);
 * at the depth cap it says so instead.
 */
import { inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Repeat2 } from 'lucide-vue-next'
import type { SchemaCount, SchemaNode } from '@/entities/api-operation/model/api-spec'
import { Collapse } from '@/shared/ui/collapse'
import { SCHEMA_TREE } from '../model/schema-tree'

defineOptions({ name: 'ApiSchemaTree' })
withDefaults(defineProps<{ nodes: SchemaNode[]; path: string; nested?: boolean }>(), { nested: false })
const { t } = useI18n()
const tree = inject(SCHEMA_TREE)!

const opens = (n: SchemaNode) => n.lazy || n.children.length > 0
const pathOf = (prefix: string, n: SchemaNode) => `${prefix}/${n.name}`
const domId = (path: string) => `${tree.uid}-${path.replace(/[^\w-]+/g, '-')}`

function countLabel(c: SchemaCount): string {
  if (c.kind === 'variants') return t('apiRef.schema.variants', { n: c.n }, c.n)
  return c.array ? t('apiRef.schema.arrayFields', { n: c.n }, c.n) : t('apiRef.schema.fields', { n: c.n }, c.n)
}
</script>

<template>
  <ul class="kn-schema-level" :data-nested="nested || undefined">
    <li v-for="node in nodes" :key="node.name" class="kn-schema-row">
      <div class="kn-schema-line">
        <button
          v-if="opens(node)"
          type="button"
          class="kn-schema-toggle"
          :aria-expanded="tree.isOpen(pathOf(path, node))"
          :aria-controls="domId(pathOf(path, node))"
          @click="tree.toggle(pathOf(path, node), node)"
        >
          <ChevronRight class="kn-schema-chevron" aria-hidden="true" />
          <code class="kn-schema-name" :class="node.deprecated && 'line-through opacity-60'">{{ node.name }}</code>
        </button>
        <span v-else class="kn-schema-leaf">
          <code class="kn-schema-name" :class="node.deprecated && 'line-through opacity-60'">{{ node.name }}</code>
        </span>
        <span class="kn-schema-type">{{ node.type }}</span>
        <span v-if="node.required" class="kn-schema-req">{{ t('apiRef.requiredMark') }}</span>
        <span v-if="node.recursive" class="kn-schema-meta" :title="t('apiRef.recursive', { name: node.refName ?? '' })">
          <Repeat2 class="size-3.5" aria-hidden="true" /><span class="sr-only">{{ t('apiRef.recursive', { name: node.refName ?? '' }) }}</span>
        </span>
        <span v-if="node.count && !tree.isOpen(pathOf(path, node))" class="kn-schema-meta">{{ countLabel(node.count) }}</span>
        <span v-if="node.truncated || (node.recursive && !node.lazy)" class="kn-schema-meta">{{ t('apiRef.truncated') }}</span>
      </div>
      <p v-if="node.description" class="kn-schema-desc">{{ node.description }}</p>
      <p v-if="node.enumValues.length" class="kn-schema-enum">
        <code v-for="v in node.enumValues" :key="v">{{ v }}</code>
      </p>
      <Collapse v-if="opens(node)" :open="tree.isOpen(pathOf(path, node))">
        <div :id="domId(pathOf(path, node))">
          <ApiSchemaTree :nodes="tree.childrenOf(pathOf(path, node), node)" :path="pathOf(path, node)" nested />
        </div>
      </Collapse>
    </li>
  </ul>
</template>

<style scoped>
.kn-schema-level {
  margin: 0;
  padding: 0;
  list-style: none;
}
/* A nested level hangs from a rail under its parent's chevron, in the card's
   hue, with a short tick to each row. */
.kn-schema-level[data-nested] {
  margin: 0.15rem 0 0.25rem 0.6rem;
  padding-left: 0.95rem;
  border-left: 1px solid color-mix(in oklab, var(--kn-accent, var(--border)) 35%, var(--border));
}
.kn-schema-level[data-nested] > .kn-schema-row {
  position: relative;
}
.kn-schema-level[data-nested] > .kn-schema-row::before {
  position: absolute;
  top: 1.05rem;
  left: -0.95rem;
  width: 0.7rem;
  border-top: 1px solid color-mix(in oklab, var(--kn-accent, var(--border)) 35%, var(--border));
  content: '';
}
.kn-schema-row {
  padding-block: 0.4rem;
}
.kn-schema-row + .kn-schema-row {
  border-top: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
}
.kn-schema-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.15rem 0.55rem;
  min-height: 1.6rem;
}
.kn-schema-toggle,
.kn-schema-leaf {
  display: inline-flex;
  align-items: baseline;
  gap: 0.15rem;
  min-width: 0;
}
.kn-schema-leaf {
  padding-left: 1.4rem;
}
.kn-schema-toggle {
  margin: -0.15rem -0.3rem -0.15rem -0.15rem;
  padding: 0.15rem 0.3rem 0.15rem 0.15rem;
  border-radius: 6px;
  transition: background-color 120ms ease-out;
}
.kn-schema-toggle:hover {
  background: color-mix(in oklab, var(--kn-accent, var(--foreground)) 9%, transparent);
}
.kn-schema-toggle:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}
.kn-schema-chevron {
  flex-shrink: 0;
  width: 1rem;
  height: 1rem;
  margin-right: 0.25rem;
  align-self: center;
  color: var(--muted-foreground);
  transition: transform var(--collapse-duration) var(--snap-ease);
}
.kn-schema-toggle[aria-expanded='true'] .kn-schema-chevron {
  transform: rotate(90deg);
}
.kn-schema-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--kn-text-sm);
  font-weight: 600;
  color: var(--foreground);
  overflow-wrap: anywhere;
}
.kn-schema-type {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--kn-text-ui);
  color: color-mix(in oklab, var(--kn-accent, var(--foreground)) 55%, var(--foreground));
  overflow-wrap: anywhere;
}
.kn-schema-req {
  font-size: var(--kn-text-xs);
  font-weight: 600;
  color: color-mix(in oklab, var(--kn-panel-caution) 75%, var(--foreground));
}
.kn-schema-meta {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: var(--kn-text-xs);
  color: var(--muted-foreground);
}
.kn-schema-desc {
  margin-top: 0.15rem;
  padding-left: 1.4rem;
  font-size: var(--kn-text-sm);
  line-height: 1.5;
  color: color-mix(in oklab, var(--foreground) 78%, var(--card));
}
.kn-schema-enum {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.35rem;
  padding-left: 1.4rem;
}
.kn-schema-enum code {
  padding: 0.05rem 0.4rem;
  border-radius: 4px;
  background: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--kn-text-xs);
  color: var(--foreground);
}
@media (prefers-reduced-motion: reduce) {
  .kn-schema-chevron {
    transition: none;
  }
}
</style>
