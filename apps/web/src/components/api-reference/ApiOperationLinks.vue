<script setup lang="ts">
/**
 * The pages that link this operation (#78): use cases that IMPLEMENTS it,
 * guides that DESCRIBES it, services that DEPENDS_ON it. The same answer the
 * agent gets from `knowledge_get_api_operation` — a capability for one and not
 * the other would be unfinished. Each row says what kind of fact it is
 * (frontmatter, explicit, inferred…), because a deterministic link and an
 * inferred one do not deserve the same trust.
 *
 * Empty, it teaches the one way in: the key, ready to paste into a page's
 * `relations:`.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Check, Copy } from 'lucide-vue-next'
import type { EntityNeighborsResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { useCopy } from '@/lib/use-copy'
import { Button } from '@/components/ui/button'

const props = defineProps<{ workspaceId: string; entityKey: string; specDocumentId: string }>()
const { t } = useI18n()
const { state: copyState, copy } = useCopy()

const neighbors = useQuery(
  computed(() =>
    apiQueryOptions('/v1/entities/{key}/neighbors', {
      path: { key: props.entityKey },
      query: { workspaceId: props.workspaceId, depth: '1' },
    }),
  ),
)
const links = computed(() =>
  ((neighbors.data.value as EntityNeighborsResponse | undefined)?.edges ?? []).filter(
    (e) => e.documentId !== props.specDocumentId,
  ),
)
const snippet = computed(() => `relations:\n  - type: IMPLEMENTS\n    target: "${props.entityKey}"`)
</script>

<template>
  <!-- Opens on the card's section band (`kn-op-section-title`, ApiOperationDetail). -->
  <section>
    <h4 class="kn-op-section-title">
      {{ t('apiRef.linked.title') }}<span v-if="links.length" class="kn-op-count">{{ links.length }}</span>
    </h4>
    <div class="kn-op-pad">
      <p v-if="neighbors.isPending.value" class="text-[0.875rem] text-muted-foreground">{{ t('apiRef.linked.loading') }}</p>
      <ul v-else-if="links.length" class="divide-y">
        <li v-for="e in links" :key="`${e.documentId}${e.relationType}`" class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2.5 first:pt-0">
          <code class="w-28 shrink-0 font-mono text-[0.78rem] text-muted-foreground">{{ e.relationType }}</code>
          <RouterLink :to="`/documents/${e.documentId}`" class="min-w-0 flex-1 text-[0.9rem] font-medium text-primary underline-offset-4 hover:underline">
            {{ e.documentTitle }}
          </RouterLink>
          <span class="text-[0.8rem] text-muted-foreground">{{ t(`assistant.provenance.fact.${e.extractor}`) }}</span>
        </li>
      </ul>
      <div v-else class="space-y-3 rounded-lg border border-dashed p-4">
        <p class="text-[0.875rem] leading-relaxed text-[color-mix(in_oklab,var(--foreground)_75%,var(--card))]">{{ t('apiRef.linked.empty') }}</p>
        <pre class="overflow-x-auto rounded-md border bg-[color-mix(in_oklab,var(--foreground)_4%,var(--card))] px-3 py-2.5 font-mono text-[0.8rem] leading-relaxed">{{ snippet }}</pre>
        <Button variant="outline" size="sm" @click="copy(entityKey)">
          <Check v-if="copyState === 'copied'" class="size-3.5" />
          <Copy v-else class="size-3.5" />
          {{ copyState === 'copied' ? t('apiRef.linked.copied') : copyState === 'failed' ? t('apiRef.linked.copyFailed') : t('apiRef.linked.copyKey') }}
        </Button>
      </div>
    </div>
  </section>
</template>
