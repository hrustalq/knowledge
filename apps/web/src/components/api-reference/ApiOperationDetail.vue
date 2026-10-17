<script setup lang="ts">
/**
 * One operation or channel (#78) as its own card: the endpoint line, the
 * summary as its heading, then what to send, what comes back, and who links it.
 * The card is the boundary between endpoints; inside it, sections separate by
 * heading and hairline only, so no box ever sits in another.
 *
 * Descriptions are the spec author's markdown, so they go through MarkdownView
 * and its sanitizer; nothing here uses `v-html`.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy } from 'lucide-vue-next'
import type { ApiOperationInfo } from '@knowledge/contracts'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import { operationView, schemaTree, statusTone, typeLabel } from '@/lib/api-spec'
import { operationDomId } from './use-api-reference'
import { useCopy } from '@/lib/use-copy'
import ApiEndpoint from './ApiEndpoint.vue'
import ApiOperationLinks from './ApiOperationLinks.vue'
import ApiSchemaTree from './ApiSchemaTree.vue'
import ApiTone from './ApiTone.vue'

const props = withDefaults(
  defineProps<{
    document: Record<string, unknown>
    operation: ApiOperationInfo
    workspaceId: string
    /** Read the linked pages: only once the card has been on screen, so a spec of 300 operations is not 300 graph reads. */
    links?: boolean
  }>(),
  { links: false },
)
const { t, te } = useI18n()
const { state: copyState, copy } = useCopy()

const view = computed(() => operationView(props.document, props.operation))
const paramGroups = computed(() => {
  const groups = new Map<string, NonNullable<typeof view.value>['parameters']>()
  for (const p of view.value?.parameters ?? []) groups.set(p.in, [...(groups.get(p.in) ?? []), p])
  return [...groups.entries()]
})
const tree = (schema: unknown) => schemaTree(props.document, schema)
const example = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))
const groupTitle = (where: string) => (te(`apiRef.in.${where}`) ? t(`apiRef.in.${where}`) : t('apiRef.params'))
</script>

<template>
  <article
    :id="operationDomId(operation)"
    class="scroll-mt-28 space-y-7 rounded-xl border bg-card p-5 sm:p-6"
    :data-op="operation.entityKey"
  >
    <template v-if="view">
    <header class="space-y-3">
      <ApiEndpoint :method="view.method" :path="view.path" :protocol="view.protocol" size="lg" />
      <h3 v-if="view.summary" class="font-display text-[1.12rem] leading-snug font-semibold tracking-[-0.015em] text-balance">
        {{ view.summary }}
      </h3>
      <dl class="flex flex-wrap gap-x-5 gap-y-1 text-[0.8rem] text-muted-foreground">
        <div v-if="view.deprecated" class="flex items-center gap-1.5">
          <ApiTone tone="warning">{{ t('apiRef.deprecated') }}</ApiTone>
        </div>
        <div v-if="view.operationId" class="flex gap-1.5">
          <dt>{{ t('apiRef.operationId') }}</dt>
          <dd><code class="font-mono text-foreground">{{ view.operationId }}</code></dd>
        </div>
        <div v-if="view.security.length" class="flex gap-1.5">
          <dt>{{ t('apiRef.auth') }}</dt>
          <dd><code class="font-mono text-foreground">{{ view.security.join(', ') }}</code></dd>
        </div>
        <div class="flex min-w-0 max-w-full items-center gap-1.5">
          <dt class="shrink-0 whitespace-nowrap">{{ t('apiRef.entityKey') }}</dt>
          <dd class="flex min-w-0 items-center gap-1">
            <code class="truncate font-mono text-foreground">{{ operation.entityKey }}</code>
            <button
              type="button"
              class="grid size-6 shrink-0 place-items-center rounded-sm hover:bg-accent hover:text-foreground"
              :aria-label="copyState === 'copied' ? t('apiRef.linked.copied') : t('apiRef.linked.copyKey')"
              :title="copyState === 'failed' ? t('apiRef.linked.copyFailed') : t('apiRef.linked.copyKey')"
              @click="copy(operation.entityKey)"
            >
              <Check v-if="copyState === 'copied'" class="size-3.5" />
              <Copy v-else class="size-3.5" />
            </button>
          </dd>
        </div>
      </dl>
      <MarkdownView v-if="view.description" :markdown="view.description" />
    </header>

    <section v-for="[where, params] in paramGroups" :key="where" class="space-y-2">
      <h4 class="font-display text-base font-semibold tracking-[-0.015em] text-muted-foreground">{{ groupTitle(where) }}</h4>
      <ul class="divide-y border-y">
        <li v-for="p in params" :key="p.name" class="py-2">
          <p class="flex flex-wrap items-baseline gap-x-2 leading-6">
            <code class="font-mono text-[0.82rem] font-medium" :class="p.deprecated && 'line-through opacity-60'">{{ p.name }}</code>
            <span class="font-mono text-[0.75rem] text-muted-foreground">{{ p.type }}</span>
            <span v-if="p.required" class="text-[0.7rem] font-semibold tracking-wide uppercase">{{ t('apiRef.required') }}</span>
          </p>
          <p v-if="p.description" class="text-[0.82rem] leading-relaxed text-muted-foreground">{{ p.description }}</p>
        </li>
      </ul>
    </section>

    <section v-if="view.requestBody" class="space-y-2">
      <h4 class="flex items-baseline gap-2 font-display text-base font-semibold tracking-[-0.015em] text-muted-foreground">
        {{ t('apiRef.body') }}
        <span v-if="view.requestBody.required" class="font-sans text-[0.7rem] font-semibold tracking-wide uppercase">{{ t('apiRef.required') }}</span>
      </h4>
      <MarkdownView v-if="view.requestBody.description" :markdown="view.requestBody.description" />
      <div v-for="c in view.requestBody.contents" :key="c.mediaType" class="space-y-1">
        <p class="font-mono text-[0.75rem] text-muted-foreground">{{ c.mediaType }} · {{ typeLabel(document, c.schema) }}</p>
        <ApiSchemaTree v-if="tree(c.schema).length" :nodes="tree(c.schema)" />
        <pre v-if="c.example !== undefined" class="mt-2 overflow-x-auto rounded-lg border bg-muted/50 p-3 font-mono text-[0.78rem]">{{ example(c.example) }}</pre>
      </div>
    </section>

    <section v-if="view.responses.length" class="space-y-2">
      <h4 class="font-display text-base font-semibold tracking-[-0.015em] text-muted-foreground">{{ t('apiRef.responses') }}</h4>
      <div class="divide-y border-y">
        <details v-for="r in view.responses" :key="r.status" class="group" :open="r.status.startsWith('2') && r.contents.length > 0">
          <summary
            class="flex list-none items-baseline gap-3 py-2 text-sm [&::-webkit-details-marker]:hidden"
            :class="r.contents.length ? 'cursor-pointer' : 'cursor-default'"
          >
            <ApiTone :tone="statusTone(r.status)">{{ r.status }}</ApiTone>
            <span class="min-w-0 flex-1">{{ r.description }}</span>
            <span v-if="r.contents.length" class="font-mono text-[0.72rem] text-muted-foreground group-open:hidden">
              {{ r.contents.map((c) => c.mediaType).join(', ') }}
            </span>
          </summary>
          <div v-if="r.contents.length" class="space-y-3 pb-3 pl-[4.1rem]">
            <div v-for="c in r.contents" :key="c.mediaType" class="space-y-1">
              <p class="font-mono text-[0.75rem] text-muted-foreground">{{ c.mediaType }} · {{ typeLabel(document, c.schema) }}</p>
              <ApiSchemaTree v-if="tree(c.schema).length" :nodes="tree(c.schema)" />
              <pre v-if="c.example !== undefined" class="mt-2 overflow-x-auto rounded-lg border bg-muted/50 p-3 font-mono text-[0.78rem]">{{ example(c.example) }}</pre>
            </div>
          </div>
        </details>
      </div>
    </section>

    <section v-if="view.messages.length" class="space-y-2">
      <h4 class="font-display text-base font-semibold tracking-[-0.015em] text-muted-foreground">{{ t('apiRef.messages') }}</h4>
      <div class="divide-y border-y">
        <div v-for="(m, i) in view.messages" :key="i" class="space-y-1 py-3">
          <p class="text-sm font-medium">{{ m.name ?? t('apiRef.message', { n: i + 1 }) }}</p>
          <p v-if="m.summary" class="text-[0.82rem] text-muted-foreground">{{ m.summary }}</p>
          <MarkdownView v-if="m.description" :markdown="m.description" />
          <p class="font-mono text-[0.75rem] text-muted-foreground">{{ t('apiRef.payload') }} · {{ typeLabel(document, m.payload) }}</p>
          <ApiSchemaTree v-if="tree(m.payload).length" :nodes="tree(m.payload)" />
        </div>
      </div>
    </section>

    <ApiOperationLinks
      v-if="links"
      :workspace-id="workspaceId"
      :entity-key="operation.entityKey"
      :spec-document-id="operation.documentId"
    />
    </template>
    <p v-else class="text-sm text-muted-foreground">{{ t('apiRef.missing') }}</p>
  </article>
</template>
