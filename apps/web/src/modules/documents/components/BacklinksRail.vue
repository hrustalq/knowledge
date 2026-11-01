<script setup lang="ts">
/**
 * Pages linking to this one (#673), in the rail. Only pages the reader may
 * open come back, so the list never hints at a restricted one. Reads the same
 * query the collapsed row counts from, so opening the widget costs nothing —
 * and the row exists only once that query has pages, so there is no loading
 * or empty state to draw here.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { FileText } from 'lucide-vue-next'
import type { DocumentBacklinksResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'

const props = defineProps<{ documentId: string }>()
const { t } = useI18n()

const query = useQuery(computed(() => apiQueryOptions('/v1/documents/{id}/backlinks', { path: { id: props.documentId } })))
const backlinks = computed(() => (query.data.value as DocumentBacklinksResponse | undefined)?.backlinks ?? [])
const anchorsOf = (anchors: string[]) => anchors.map((a) => `#${a}`).join(' ')
</script>

<template>
  <div class="space-y-2.5">
    <p class="text-xs text-muted-foreground">{{ t('documents.backlinksHint') }}</p>
    <ul class="space-y-2">
      <li v-for="b in backlinks" :key="b.documentId" class="min-w-0 space-y-0.5">
        <RouterLink
          :to="`/documents/${b.documentId}`"
          class="flex min-w-0 items-center gap-1.5 rounded-sm py-0.5 text-ui outline-none hover:underline hover:underline-offset-2 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          :title="b.title"
        >
          <FileText class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="truncate">{{ b.title }}</span>
        </RouterLink>
        <p v-if="b.anchors.length" class="truncate pl-5 font-mono text-caption text-muted-foreground" :title="anchorsOf(b.anchors)">
          {{ anchorsOf(b.anchors) }}
        </p>
      </li>
    </ul>
  </div>
</template>
