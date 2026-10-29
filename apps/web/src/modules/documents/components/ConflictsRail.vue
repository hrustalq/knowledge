<script setup lang="ts">
/**
 * The page's open contradictions (#81), in the rail: each one leads with what
 * the other page says, since the reader is already on this one. Closed ones
 * fold away under a details row, as reports do. Reads the same query the
 * collapsed row counts from, so opening the widget costs nothing.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import type { ListConflictsResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import ConflictCard from './ConflictCard.vue'

const props = defineProps<{ documentId: string }>()
const { t } = useI18n()

const query = useQuery(
  computed(() => apiQueryOptions('/v1/conflicts', { query: { workspaceId: getWorkspaceId(), documentId: props.documentId } })),
)
const conflicts = computed(() => (query.data.value as ListConflictsResponse | undefined)?.conflicts ?? [])
const open = computed(() => conflicts.value.filter((c) => c.status === 'open'))
const closed = computed(() => conflicts.value.filter((c) => c.status !== 'open').slice(0, 5))
</script>

<template>
  <div class="space-y-2.5">
    <div class="divide-y [&>*]:py-2.5 [&>*:first-child]:pt-0">
      <ConflictCard v-for="c in open" :key="c.id" :conflict="c" :current-document-id="documentId" layout="stacked" />
    </div>
    <details v-if="closed.length" class="text-xs text-muted-foreground">
      <summary class="cursor-pointer">{{ t('conflicts.recentlyClosed', { n: closed.length }, closed.length) }}</summary>
      <div class="mt-2 divide-y [&>*]:py-2.5">
        <ConflictCard v-for="c in closed" :key="c.id" :conflict="c" :current-document-id="documentId" layout="stacked" />
      </div>
    </details>
    <RouterLink to="/conflicts" class="block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
      {{ t('conflicts.allInWorkspace') }}
    </RouterLink>
  </div>
</template>
