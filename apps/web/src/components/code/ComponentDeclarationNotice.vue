<script setup lang="ts">
/**
 * A page's `component:` block that resolved to no code connector (#236).
 *
 * Such a page gets no usage index and no derived edges, and nothing else on
 * the page would say so — the declaration would just look like it matched
 * nothing. Also a declaration that resolved but names paths no file matches
 * at the indexed head (phase 6). Renders nothing when the page declares no
 * component, or when its declaration resolved and every path still exists.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { TriangleAlert } from 'lucide-vue-next'
import type { ComponentDeclarationView } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'

const props = defineProps<{ documentId: string }>()
const { t } = useI18n()

const query = useQuery(
  computed(() => apiQueryOptions('/v1/documents/{id}/component', { path: { id: props.documentId } })),
)
const declaration = computed(() => query.data.value as ComponentDeclarationView | null | undefined)
const missing = computed(() => (declaration.value?.warning ? [] : (declaration.value?.missingPaths ?? [])))
</script>

<template>
  <p
    v-if="declaration?.warning"
    role="status"
    class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
  >
    <TriangleAlert class="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
    <span>
      <span class="font-medium">{{ t('component.notice.title') }}</span>
      {{ t(`component.notice.${declaration.warning}`, { repository: declaration.repository ?? '' }) }}
    </span>
  </p>
  <p
    v-else-if="missing.length > 0"
    role="status"
    class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
  >
    <TriangleAlert class="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
    <span>
      <span class="font-medium">{{ t('component.notice.missingTitle') }}</span>
      {{ t('component.notice.missing', { paths: missing.join(', ') }) }}
    </span>
  </p>
</template>
