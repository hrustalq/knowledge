<script setup lang="ts">
/**
 * The page's open reports (docs/features/38, phase 3): what readers and agents
 * said is wrong with it, where each report is on its way to a fix, and the
 * two things a person can do about one — resolve it (the page is right now)
 * or dismiss it (the report was not). A viewer sees the list and the Report
 * button; closing is an editor's act, so the buttons are theirs alone.
 *
 * Reads through vue-query so a report filed from the thumbs in the Ask widget
 * on the same page shows up here on the next refetch, and a closed one leaves
 * the moment the mutation settles.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Flag, GitMerge } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import type { KnowledgeIssueInfo, ListKnowledgeIssuesResponse } from '@knowledge/contracts'
import { isOpenIssueStatus } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { getWorkspaceId, relativeTime } from '@/shared/api/api'
import { labelFor } from '@/shared/i18n/labels'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { useAuthStore } from '@/stores/auth'
import { useFeedbackStore } from '@/modules/assistant/model/feedback.store'
import ReportIssueDialog from './ReportIssueDialog.vue'
import WorkItemChips from './WorkItemChips.vue'

const props = defineProps<{
  documentId: string
  title: string
  revisionId?: string | null
}>()

const { t } = useI18n()
const auth = useAuthStore()
const feedback = useFeedbackStore()
const queryClient = useQueryClient()

const query = useQuery(
  computed(() =>
    apiQueryOptions('/v1/knowledge-issues', {
      query: { workspaceId: getWorkspaceId(), documentId: props.documentId },
    }),
  ),
)
const issues = computed(() => (query.data.value as ListKnowledgeIssuesResponse | undefined)?.issues ?? [])
const open = computed(() => issues.value.filter((i) => isOpenIssueStatus(i.status)))
const closed = computed(() => issues.value.filter((i) => !isOpenIssueStatus(i.status)).slice(0, 5))

const reporting = ref(false)
const busy = ref<string | null>(null)

function refresh() {
  void queryClient.invalidateQueries({ queryKey: ['/v1/knowledge-issues'] })
  // The page's own detail reads the flag: a closed report un-flags it.
  void queryClient.invalidateQueries({ queryKey: ['/v1/documents/{id}', { id: props.documentId }] })
}

async function close(issue: KnowledgeIssueInfo, status: 'resolved' | 'dismissed') {
  if (busy.value) return
  busy.value = issue.id
  try {
    await feedback.closeIssue(issue.id, status)
    toast.success(t(`knowledgeIssue.toast.${status}`))
    refresh()
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = null
  }
}

/** The latest note the sentinel or a person attached — what the row says under the detail. */
function lastNote(issue: KnowledgeIssueInfo): string | null {
  for (let i = issue.evidence.length - 1; i >= 0; i -= 1) {
    const note = issue.evidence[i]?.note
    if (note) return note
  }
  return null
}

const statusVariant = (status: string) =>
  status === 'proposed' ? 'default' : status === 'checking' ? 'secondary' : status === 'open' ? 'destructive' : 'outline'
</script>

<template>
  <div class="space-y-3 text-sm">
    <div v-if="query.isPending.value" class="text-xs text-muted-foreground">{{ t('common.loading') }}</div>

    <p v-else-if="open.length === 0" class="text-xs text-muted-foreground">{{ t('knowledgeIssue.empty') }}</p>

    <ul v-else class="space-y-2">
      <li v-for="issue in open" :key="issue.id" class="rounded-md border p-2.5">
        <div class="flex items-center gap-1.5">
          <Flag class="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
          <span class="font-medium">{{ labelFor(t, 'knowledgeIssue.kind', issue.kind) }}</span>
          <Badge :variant="statusVariant(issue.status)" class="ml-auto">{{ labelFor(t, 'knowledgeIssue.status', issue.status) }}</Badge>
        </div>
        <p class="mt-1 whitespace-pre-wrap break-words text-xs">{{ issue.detail }}</p>
        <p v-if="lastNote(issue)" class="mt-1 text-xs text-muted-foreground">{{ lastNote(issue) }}</p>
        <p class="mt-1.5 flex flex-wrap items-center gap-x-2 text-caption text-muted-foreground">
          <span>{{ relativeTime(issue.createdAt) }}</span>
          <span v-if="issue.reportCount > 1">· {{ t('knowledgeIssue.reportCount', { n: issue.reportCount }, issue.reportCount) }}</span>
          <RouterLink
            v-if="issue.mergeRequestId"
            :to="`/merge-requests/${issue.mergeRequestId}`"
            class="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
          >
            <GitMerge class="size-3" aria-hidden="true" />
            {{ t('knowledgeIssue.openMergeRequest') }}
          </RouterLink>
        </p>
        <div v-if="auth.canEdit" class="mt-2 flex gap-1.5">
          <Button variant="outline" size="sm" class="h-7 text-xs" :disabled="busy === issue.id" @click="close(issue, 'resolved')">
            {{ t('knowledgeIssue.resolve') }}
          </Button>
          <Button variant="ghost" size="sm" class="h-7 text-xs" :disabled="busy === issue.id" @click="close(issue, 'dismissed')">
            {{ t('knowledgeIssue.dismiss') }}
          </Button>
        </div>
        <WorkItemChips source-kind="issue" :source-id="issue.id" :can-handoff="auth.canEdit" class="mt-2" />
      </li>
    </ul>

    <details v-if="closed.length" class="text-xs text-muted-foreground">
      <summary class="cursor-pointer">{{ t('knowledgeIssue.recentlyClosed', { n: closed.length }, closed.length) }}</summary>
      <ul class="mt-1.5 space-y-1">
        <li v-for="issue in closed" :key="issue.id" class="flex items-center gap-1.5">
          <span class="line-through">{{ labelFor(t, 'knowledgeIssue.kind', issue.kind) }}</span>
          <span>· {{ labelFor(t, 'knowledgeIssue.status', issue.status) }}</span>
          <span v-if="issue.resolvedAt">· {{ relativeTime(issue.resolvedAt) }}</span>
        </li>
      </ul>
    </details>

    <Button variant="outline" size="sm" class="w-full" @click="reporting = true">
      <Flag class="size-3.5" aria-hidden="true" />
      {{ t('knowledgeIssue.report') }}
    </Button>

    <ReportIssueDialog
      v-model:open="reporting"
      :document-id="documentId"
      :title="title"
      :revision-id="revisionId"
      @reported="refresh"
    />
  </div>
</template>
