<script setup lang="ts">
// Approve / merge / close / reopen / draft-toggle button row. All mutations go
// through the typed vue-query client; the merge 409 gate reasons
// (draft | approvals | diverged, see MergeGateConflictDetails) surface as
// toasts, with a comparison link on divergence.
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import type { MergeRequestInfo, MergeGateConflictDetails, MergeStrategy } from '@knowledge/contracts'
import { useApiMutation, isApiRequestError } from '@/api/queries'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'

const props = defineProps<{ mergeRequest: MergeRequestInfo }>()
const emit = defineEmits<{ changed: [] }>()

const router = useRouter()
const auth = useAuthStore()
const strategy = ref<MergeStrategy>('merge-commit')

const mr = computed(() => props.mergeRequest)
const id = computed(() => ({ path: { id: mr.value.mergeRequestId } }))
const isOpen = computed(() => mr.value.status === 'open')
const alreadyApproved = computed(() => !!auth.me && mr.value.approvedBy.includes(auth.me.userId))
const detailKey = computed(() => ['/v1/merge-requests/{id}', { id: mr.value.mergeRequestId }, null])

const invalidates = () => [detailKey.value, ['/v1/merge-requests'], ['/v1/documents/{id}/merge-requests']]

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
        toast.success('Merged')
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
    {
      onSuccess: () => emit('changed'),
      onError: (e) => toast.error(e.message),
    },
  )
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <template v-if="isOpen">
      <Button size="sm" variant="outline" :disabled="busy || alreadyApproved" @click="act(approve, 'Approved')">
        {{ alreadyApproved ? 'Approved ✓' : 'Approve' }}
      </Button>
      <div class="flex items-center gap-1">
        <select v-model="strategy" class="h-8 rounded-md border bg-background px-2 text-xs">
          <option value="merge-commit">merge commit</option>
          <option value="squash">squash</option>
        </select>
        <Button size="sm" :disabled="busy || mr.isDraft" :title="mr.isDraft ? 'Draft — mark ready to merge' : ''" @click="onMerge">
          Merge
        </Button>
      </div>
      <Button size="sm" variant="ghost" :disabled="busy" @click="toggleDraft">
        {{ mr.isDraft ? 'Mark ready' : 'Mark as draft' }}
      </Button>
      <Button size="sm" variant="ghost" :disabled="busy" @click="act(close, 'Closed')">Close</Button>
    </template>
    <Button v-else-if="mr.status === 'closed'" size="sm" variant="outline" :disabled="busy" @click="act(reopen, 'Reopened')">
      Reopen
    </Button>
  </div>
</template>
