<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { FileText } from 'lucide-vue-next'
import type { WorkflowRunInfo } from '@knowledge/contracts'
import { relativeTime } from '@/lib/api'
import { isBusyStatus, RUN_STATUS_CLASS, RUN_STATUS_ICON, RUN_STATUS_LABEL } from './workflow-ui'

const { t } = useI18n()

/** One run in a list (docs/features/17): what it is, where it got to, what it wants. */
const props = defineProps<{ run: WorkflowRunInfo }>()

/** Progress as a count rather than a bar: a fan-out means the total grows as it
 *  goes, and a bar that slides backwards reads as a bug. */
const progress = computed(() => {
  const { total, materialized, awaitingReview, failed } = props.run.nodeStats
  return { total, materialized, awaitingReview, failed }
})
</script>

<template>
  <RouterLink
    :to="`/workflows/${run.id}`"
    class="hover:border-border hover:bg-muted/40 focus-visible:ring-ring block rounded-lg border p-3 transition-colors focus-visible:ring-2 focus-visible:outline-none"
  >
    <div class="flex items-start gap-3">
      <component
        :is="RUN_STATUS_ICON[run.status]"
        class="mt-0.5 size-4 shrink-0"
        :class="[RUN_STATUS_CLASS[run.status], isBusyStatus(run.status) ? 'animate-spin' : '']"
      />
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium">{{ run.definitionName }}</p>
        <p class="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
          <FileText class="size-3" />
          <span class="truncate">{{ run.rootDocumentTitle ?? run.rootDocumentId }}</span>
          <span>· {{ t(RUN_STATUS_LABEL[run.status]) }}</span>
          <span>· {{ relativeTime(run.startedAt ?? run.createdAt) }}</span>
          <span v-if="run.startedBy === 'trigger'" class="bg-muted rounded px-1">auto</span>
        </p>
      </div>
      <div class="text-muted-foreground shrink-0 text-right text-xs">
        <p v-if="progress.awaitingReview" class="text-amber-600 dark:text-amber-500">
          {{ progress.awaitingReview }} to review
        </p>
        <p v-if="progress.failed" class="text-destructive">{{ progress.failed }} failed</p>
        <p>{{ progress.materialized }}/{{ progress.total }} published</p>
      </div>
    </div>
  </RouterLink>
</template>
