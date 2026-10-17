<script setup lang="ts">
/**
 * A schema as a field tree (#78), drawn the way the page tree is: each level
 * indents and hangs a hairline from its parent, and every row keeps a 20px
 * disclosure slot whether or not it has children, so rows never jitter.
 *
 * `lib/api-spec.schemaTree` has already capped the depth and turned a
 * recursive `$ref` into a marker; this only renders. Nested levels open on
 * request, so a wide response reads flat first.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Repeat2 } from 'lucide-vue-next'
import type { SchemaNode } from '@/lib/api-spec'

defineOptions({ name: 'ApiSchemaTree' })
withDefaults(defineProps<{ nodes: SchemaNode[]; nested?: boolean }>(), { nested: false })
const { t } = useI18n()
const open = ref(new Set<string>())

function toggle(name: string) {
  const next = new Set(open.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  open.value = next
}
</script>

<template>
  <ul :class="nested ? 'ml-[9px] border-l pl-3' : ''">
    <li v-for="node in nodes" :key="node.name" class="py-1.5">
      <div class="flex items-start gap-1">
        <button
          v-if="node.children.length"
          type="button"
          class="mt-[3px] grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          :aria-expanded="open.has(node.name)"
          :aria-label="t(open.has(node.name) ? 'apiRef.collapse' : 'apiRef.expand', { name: node.name })"
          @click="toggle(node.name)"
        >
          <ChevronRight class="size-3.5 transition-transform duration-150" :class="open.has(node.name) && 'rotate-90'" />
        </button>
        <span v-else class="size-5 shrink-0" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 leading-6">
            <code class="font-mono text-[0.82rem] font-medium" :class="node.deprecated && 'line-through opacity-60'">{{ node.name }}</code>
            <span class="font-mono text-[0.75rem] text-muted-foreground">{{ node.type }}</span>
            <span v-if="node.required" class="text-[0.7rem] font-semibold tracking-wide uppercase">{{ t('apiRef.required') }}</span>
            <span v-if="node.recursive" class="inline-flex items-center gap-1 text-[0.75rem] text-muted-foreground">
              <Repeat2 class="size-3" aria-hidden="true" />{{ t('apiRef.recursive', { name: node.refName ?? '' }) }}
            </span>
            <span v-if="node.truncated" class="text-[0.75rem] text-muted-foreground">{{ t('apiRef.truncated') }}</span>
          </p>
          <p v-if="node.description" class="text-[0.82rem] leading-relaxed text-muted-foreground">{{ node.description }}</p>
          <p v-if="node.enumValues.length" class="mt-1 flex flex-wrap gap-1">
            <code v-for="v in node.enumValues" :key="v" class="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.72rem]">{{ v }}</code>
          </p>
          <ApiSchemaTree v-if="node.children.length && open.has(node.name)" :nodes="node.children" nested />
        </div>
      </div>
    </li>
  </ul>
</template>
