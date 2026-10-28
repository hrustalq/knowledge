<script setup lang="ts">
/**
 * /memos (#551, docs/features/68): your recordings, newest first. A memo is
 * the uploader's alone, so there is no "by" column and no filter for someone
 * else's — the list is what the API answers you with.
 *
 * Scoped to the active project, because that is where a memo's proposals are
 * filed. Polled while any memo is still moving; the row is the truth. With no
 * speech endpoint on the server the page says which variable to set instead
 * of offering an upload that would be refused.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import type { MemoListResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format'
import { useProjectsStore } from '@/stores/projects'
import { PageLayout, PageState } from '@/components/layout/page'
import MemoUpload from '@/components/memos/MemoUpload.vue'
import { MEMO_STATUS_CLASS, MEMO_STATUS_ICON, isMemoInFlight } from '@/components/memos/memo-ui'

const { t } = useI18n()
const projects = useProjectsStore()
const workspaceId = getWorkspaceId()

const listQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/memos', {
      query: { workspaceId, ...(projects.activeId ? { projectId: projects.activeId } : {}) },
    }),
    refetchInterval: (q: { state: { data: unknown } }) =>
      (q.state.data as MemoListResponse | undefined)?.memos.some((m) => isMemoInFlight(m.status)) ? 3000 : false,
  })),
)
const data = computed(() => listQuery.data.value as MemoListResponse | undefined)
const memos = computed(() => data.value?.memos ?? [])
</script>

<template>
  <PageLayout variant="list" :title="t('memos.title')" :subtitle="t('memos.subtitle')">
    <PageState v-if="listQuery.isPending.value" state="loading" :rows="3" row-class="h-14" />
    <PageState v-else-if="listQuery.isError.value" state="error" :error="listQuery.error.value" />

    <template v-else-if="data">
      <div v-if="!data.transcription.enabled" role="status" class="kn-callout-warning kn-measure rounded-md border px-4 py-3 text-sm">
        <p class="font-medium">{{ t('memos.disabled.title') }}</p>
        <i18n-t keypath="memos.disabled.body" tag="p" class="mt-1">
          <template #variable><code class="text-foreground">{{ data.transcription.missing }}</code></template>
        </i18n-t>
      </div>
      <MemoUpload
        v-else
        :workspace-id="workspaceId"
        :project-id="projects.activeId"
        :max-bytes="data.limits.maxBytes"
        :max-minutes="data.limits.maxMinutes"
      />

      <!-- The upload above is already the call to action; a second framed
           "nothing here" box would only repeat it. -->
      <p v-if="!memos.length" class="text-muted-foreground kn-measure text-sm">{{ t('memos.empty') }}</p>

      <ul v-else class="divide-y rounded-lg border bg-card">
        <li v-for="m in memos" :key="m.memoId">
          <RouterLink
            :to="`/memos/${m.memoId}`"
            class="hover:bg-muted/50 focus-visible:ring-ring flex items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset"
          >
            <component
              :is="MEMO_STATUS_ICON[m.status]"
              class="size-4 shrink-0"
              :class="[MEMO_STATUS_CLASS[m.status], m.status === 'transcribing' ? 'motion-safe:animate-spin' : '']"
              aria-hidden="true"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium">{{ m.title }}</p>
              <p class="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
                <span :class="MEMO_STATUS_CLASS[m.status]">{{ t(`memos.status.${m.status}`) }}</span>
                <span v-if="m.durationSeconds" class="tabular-nums">{{ formatDuration(m.durationSeconds * 1000) }}</span>
                <span :title="formatDateTime(m.createdAt)">{{ formatRelative(m.createdAt) }}</span>
              </p>
            </div>
          </RouterLink>
        </li>
      </ul>
    </template>
  </PageLayout>
</template>
