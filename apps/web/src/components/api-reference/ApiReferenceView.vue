<script setup lang="ts">
/**
 * The main column of a spec document (#78): the spec's own front matter, then
 * every operation, each in its own card, under its tag. The index is the
 * Operations widget in the page rail (ApiOperationIndex); below `lg`, where the
 * rail falls under the content, the same index opens inline above the cards.
 *
 * A scroll-spy reports the card being read back to the shared state, so the
 * index keeps its active trail as the reader scrolls — what "On this page"
 * does for headings. A card mounts its linked pages the first time it is on
 * screen, not before.
 *
 * A custom renderer rather than Scalar's: its client would send requests
 * around the try-it proxy and the ACLs, it has no Russian, and it brings a
 * second theme (docs/features/52).
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-vue-next'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import { Button } from '@/components/ui/button'
import { PageState } from '@/components/layout/page'
import { operationRowKey, serversOf } from '@/lib/api-spec'
import ApiOperationDetail from './ApiOperationDetail.vue'
import ApiOperationIndex from './ApiOperationIndex.vue'
import type { ApiReferenceState } from './use-api-reference'

const props = defineProps<{ state: ApiReferenceState; workspaceId: string }>()
const { t } = useI18n()

const spec = computed(() => props.state.spec.value)
const count = computed(() => props.state.operations.value.length)
const info = computed(() => (spec.value?.document.info ?? {}) as Record<string, unknown>)
const servers = computed(() => (spec.value ? serversOf(spec.value.document) : []))
const description = computed(() => (typeof info.value.description === 'string' ? info.value.description : null))
const indexing = computed(() => !!props.state.revisionStatus.value && props.state.revisionStatus.value !== 'indexed')
const tagLabel = (tag: string | null) =>
  tag ?? t(spec.value?.kind === 'asyncapi' ? 'apiRef.untaggedChannels' : 'apiRef.untagged')

/** Cards that have been on screen at least once. */
const seen = ref(new Set<string>())
const root = ref<HTMLElement | null>(null)
let spy: IntersectionObserver | null = null

function observe() {
  spy?.disconnect()
  if (import.meta.env.SSR || typeof IntersectionObserver === 'undefined' || !root.value) return
  spy = new IntersectionObserver(
    (entries) => {
      const next = new Set(seen.value)
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const key = (e.target as HTMLElement).dataset.key
        if (key) next.add(key)
      }
      if (next.size !== seen.value.size) seen.value = next
      // The topmost card crossing the reading line is the one being read.
      const reading = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
      const key = (reading?.target as HTMLElement | undefined)?.dataset.key
      if (key) props.state.active.value = key
    },
    // A band near the top of the viewport, under the sticky chrome.
    { rootMargin: '-112px 0px -60% 0px', threshold: 0 },
  )
  for (const el of root.value.querySelectorAll<HTMLElement>('[data-key]')) spy.observe(el)
}

watch(
  () => props.state.operations.value.map(operationRowKey).join('|') + (spec.value ? '+' : ''),
  async () => {
    await nextTick()
    observe()
  },
  { immediate: true },
)
onBeforeUnmount(() => spy?.disconnect())
</script>

<template>
  <PageState v-if="state.error.value" state="error" :description="state.error.value.message" />
  <PageState v-else-if="!spec" state="loading" :rows="1" row-class="h-96" />
  <div v-else ref="root" class="space-y-8">
    <header class="max-w-[46rem] space-y-3">
      <dl class="flex flex-wrap items-center gap-x-4 gap-y-1 text-ui text-muted-foreground">
        <div class="flex gap-1.5">
          <dt class="sr-only">{{ t('apiRef.format') }}</dt>
          <dd class="font-medium text-foreground">{{ t(`apiRef.kind.${spec.kind}`) }} {{ spec.specVersion }}</dd>
        </div>
        <div v-if="spec.version" class="flex gap-1.5">
          <dt>{{ t('apiRef.versionLabel') }}</dt>
          <dd class="font-mono text-foreground">{{ spec.version }}</dd>
        </div>
        <div class="tabular-nums">{{ t('apiRef.operationCount', { n: count }, count) }}</div>
      </dl>
      <MarkdownView v-if="description" :markdown="description" />
      <dl v-if="servers.length" class="flex flex-wrap items-baseline gap-x-2 gap-y-1.5 text-sm">
        <dt class="text-muted-foreground">{{ t('apiRef.servers') }}</dt>
        <dd v-for="s in servers" :key="s"><code class="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-ui">{{ s }}</code></dd>
      </dl>
    </header>

    <PageState v-if="count === 0" state="empty" :title="indexing ? t('apiRef.indexing') : t('apiRef.empty')" />
    <template v-else>
      <ApiOperationIndex :state="state" inline class="lg:hidden" />
      <section v-for="(g, gi) in state.groups.value" :key="g.tag ?? ''" class="space-y-3">
        <div class="flex items-end gap-3 border-b pb-2">
          <h2 class="min-w-0 flex-1 font-display text-[1.35rem] font-semibold tracking-[-0.015em]">
            {{ tagLabel(g.tag) }}
            <span class="ml-1 font-sans text-sm font-normal text-muted-foreground tabular-nums">{{ g.operations.length }}</span>
          </h2>
          <!-- Once, on the first group: it opens or closes every card on the page. -->
          <Button v-if="gi === 0 && count > 1" variant="ghost" size="sm" class="h-7 shrink-0 text-ui text-muted-foreground" @click="state.setAll(!state.allOpen.value)">
            <component :is="state.allOpen.value ? ChevronsDownUp : ChevronsUpDown" />
            {{ state.allOpen.value ? t('apiRef.collapseAll') : t('apiRef.expandAll') }}
          </Button>
        </div>
        <ApiOperationDetail
          v-for="o in g.operations"
          :key="operationRowKey(o)"
          :data-key="operationRowKey(o)"
          :document="spec.document"
          :operation="o"
          :workspace-id="workspaceId"
          :open="state.isOpen(o)"
          :links="seen.has(operationRowKey(o))"
          @toggle="(v) => state.setOpen(o, v)"
        />
      </section>
    </template>
  </div>
</template>
