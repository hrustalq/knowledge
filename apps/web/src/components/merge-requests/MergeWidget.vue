<script setup lang="ts">
// GitLab-style merge widget: readiness checklist + the merge/close/reopen
// controls in one card. 409 gate reasons (draft | approvals | diverged, see
// MergeGateConflictDetails) surface as toasts — divergence with a compare link.
import { useI18n } from 'vue-i18n'
import { formatDateTime } from '@/lib/format'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { AlertTriangle, Check, CircleDashed, GitMerge, MessageSquare, ThumbsUp } from 'lucide-vue-next'
import type { MergeGateConflictDetails, MergeRequestInfo, MergeStrategy } from '@knowledge/contracts'
import { useApiMutation, isApiRequestError } from '@/api/queries'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { actorLabel, mrIcon } from './mr-ui'

const { t } = useI18n()

const props = withDefaults(defineProps<{ mergeRequest: MergeRequestInfo; unresolvedThreads?: number }>(), {
  unresolvedThreads: 0,
})
const emit = defineEmits<{ changed: [] }>()

const router = useRouter()
const auth = useAuthStore()
const strategy = ref<MergeStrategy>('merge-commit')

const mr = computed(() => props.mergeRequest)
const id = computed(() => ({ path: { id: mr.value.mergeRequestId } }))
const isOpen = computed(() => mr.value.status === 'open')
const alreadyApproved = computed(() => !!auth.me && mr.value.approvedBy.includes(auth.me.userId))

const invalidates = () => [
  ['/v1/merge-requests/{id}', { id: mr.value.mergeRequestId }, null],
  ['/v1/merge-requests'],
  ['/v1/documents/{id}/merge-requests'],
]

const approve = useApiMutation('post', '/v1/merge-requests/{id}/approve', { invalidates })
const merge = useApiMutation('post', '/v1/merge-requests/{id}/merge', { invalidates })
const close = useApiMutation('post', '/v1/merge-requests/{id}/close', { invalidates })
const reopen = useApiMutation('post', '/v1/merge-requests/{id}/reopen', { invalidates })
const update = useApiMutation('patch', '/v1/merge-requests/{id}', { invalidates })

const busy = computed(
  () =>
    approve.isPending.value ||
    merge.isPending.value ||
    close.isPending.value ||
    reopen.isPending.value ||
    update.isPending.value,
)

function onMerge() {
  merge.mutate(
    { ...id.value, body: { strategy: strategy.value } },
    {
      onSuccess: () => {
        toast.success('Merge request merged')
        emit('changed')
      },
      onError: (e) => {
        if (isApiRequestError(e) && e.status === 409) {
          const details = (e.payload.details ?? {}) as unknown as Partial<MergeGateConflictDetails>
          if (details.reason === 'approvals') {
            toast.error(`Needs ${details.requiredApprovals} approval(s) — has ${details.approvals} (author excluded)`)
          } else if (details.reason === 'draft') {
            toast.error('Draft merge requests cannot be merged — mark it ready first')
          } else if (details.comparisonUrl) {
            toast.error('Target branch diverged — rebase the source branch', {
              action: { label: 'Compare', onClick: () => void router.push(comparePagePath(details.comparisonUrl!)) },
            })
          } else {
            toast.error(e.message)
          }
        } else {
          toast.error(e.message)
        }
      },
    },
  )
}

/** API comparison URL → the document revisions tab, which hosts the compare UI. */
function comparePagePath(apiUrl: string): string {
  const m = /\/v1\/documents\/([^/]+)\/compare/.exec(apiUrl)
  return m ? `/documents/${m[1]}?tab=revisions` : '/documents'
}

function act(mutation: typeof close, label: string) {
  mutation.mutate(id.value, {
    onSuccess: () => {
      toast.success(label)
      emit('changed')
    },
    onError: (e) => toast.error(e.message),
  })
}

function toggleDraft() {
  update.mutate(
    { ...id.value, body: { isDraft: !mr.value.isDraft } },
    { onSuccess: () => emit('changed'), onError: (e) => toast.error(e.message) },
  )
}
</script>

<template>
  <div class="rounded-lg border bg-card">
    <!-- readiness checklist (open MRs) -->
    <div v-if="isOpen" class="space-y-2 border-b px-4 py-3 text-sm">
      <p class="flex items-center gap-2" :class="mr.isDraft ? 'text-muted-foreground' : ''">
        <CircleDashed v-if="mr.isDraft" class="size-4 text-amber-500" />
        <Check v-else class="size-4 text-emerald-500" />
        <span v-if="mr.isDraft">{{ t('mr.markedDraft') }}</span>
        <span v-else>{{ t('mr.readyNotDraft') }}</span>
      </p>
      <p class="flex items-center gap-2">
        <ThumbsUp class="size-4" :class="mr.approvedBy.length > 0 ? 'text-emerald-500' : 'text-muted-foreground/60'" />
        <span v-if="mr.approvedBy.length > 0">
          Approved by {{ mr.approvedBy.map((a) => actorLabel(a)).join(', ') }}
        </span>
        <span v-else class="text-muted-foreground">{{ t('mr.noApprovals') }}</span>
        <Button
          v-if="auth.canEdit"
          variant="outline"
          size="xs"
          class="ml-auto"
          :disabled="busy || alreadyApproved"
          @click="act(approve, 'Approved')"
        >
          {{ alreadyApproved ? 'Approved ✓' : 'Approve' }}
        </Button>
      </p>
      <p class="flex items-center gap-2">
        <MessageSquare class="size-4" :class="unresolvedThreads > 0 ? 'text-amber-500' : 'text-muted-foreground/60'" />
        <span v-if="unresolvedThreads > 0">
          {{ t('count.unresolvedThreads', { n: unresolvedThreads }, unresolvedThreads) }}
        </span>
        <span v-else class="text-muted-foreground">{{ t('mr.allThreadsResolved') }}</span>
      </p>
    </div>

    <!-- terminal-state summary -->
    <div v-else class="flex items-center gap-2 border-b px-4 py-3 text-sm">
      <component :is="mrIcon(mr).icon" class="size-4" :class="mrIcon(mr).class" />
      <span v-if="mr.status === 'merged'">
        {{ t('mr.mergedAt', { when: mr.mergedAt ? formatDateTime(mr.mergedAt) : '' }) }}{{ mr.strategy ? ` (${mr.strategy})` : '' }}
      </span>
      <span v-else>
        {{ t('mr.closedAt', { when: mr.closedAt ? formatDateTime(mr.closedAt) : '' }) }}
      </span>
      <RouterLink
        v-if="mr.mergedRevisionId"
        :to="`/documents/${mr.documentId}?tab=revisions`"
        class="ml-auto font-mono text-xs text-primary hover:underline"
      >
        {{ mr.mergedRevisionId.slice(0, 8) }}
      </RouterLink>
    </div>

    <!-- controls -->
    <div v-if="auth.canEdit" class="flex flex-wrap items-center gap-2 px-4 py-3">
      <template v-if="isOpen">
        <Select v-model="strategy" :disabled="busy">
          <SelectTrigger size="sm" class="text-xs" :aria-label="t('mr.mergeStrategy')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="merge-commit">{{ t('mr.mergeCommit') }}</SelectItem>
            <SelectItem value="squash">{{ t('mr.squash') }}</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" :disabled="busy || mr.isDraft" @click="onMerge">
          <GitMerge class="size-3.5" /> Merge
        </Button>
        <Button size="sm" variant="ghost" :disabled="busy" @click="toggleDraft">
          {{ mr.isDraft ? 'Mark as ready' : 'Mark as draft' }}
        </Button>
        <Button size="sm" variant="ghost" class="text-destructive" :disabled="busy" @click="act(close, 'Closed')">
          Close
        </Button>
      </template>
      <Button
        v-else-if="mr.status === 'closed'"
        size="sm"
        variant="outline"
        :disabled="busy"
        @click="act(reopen, 'Reopened')"
      >
        Reopen
      </Button>
      <p v-else class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <AlertTriangle class="size-3.5" /> Merged merge requests are final.
      </p>
    </div>
  </div>
</template>
