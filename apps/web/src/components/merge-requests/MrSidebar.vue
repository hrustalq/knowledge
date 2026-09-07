<script setup lang="ts">
// Right rail of the MR detail page (GitLab-style): assignee, reviewers with
// avatars + names, AI check, revision ids.
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Pencil } from 'lucide-vue-next'
import type { MergeRequestInfo } from '@knowledge/contracts'
import { useApiMutation } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import UserAvatar from './UserAvatar.vue'
import AiCheckCard from './AiCheckCard.vue'
import { useMembers } from './use-members'

const props = defineProps<{ mergeRequest: MergeRequestInfo; readonly?: boolean }>()
const emit = defineEmits<{ changed: [] }>()

const { members, nameOf } = useMembers()
const mr = computed(() => props.mergeRequest)

const invalidates = () => [
  ['/v1/merge-requests/{id}', { id: mr.value.mergeRequestId }, null],
  ['/v1/merge-requests'],
]

// --- assignee ----------------------------------------------------------------
const editingAssignee = ref(false)
const updateMr = useApiMutation('patch', '/v1/merge-requests/{id}', { invalidates })

function setAssignee(userId: string | null) {
  updateMr.mutate(
    { path: { id: mr.value.mergeRequestId }, body: { assigneeId: userId } },
    {
      onSuccess: () => {
        editingAssignee.value = false
        emit('changed')
      },
      onError: (e) => toast.error(e.message),
    },
  )
}

// --- reviewers ---------------------------------------------------------------
const editingReviewers = ref(false)
const selected = ref<Set<string>>(new Set(props.mergeRequest.reviewers))
watch(
  () => props.mergeRequest.reviewers,
  (next) => (selected.value = new Set(next)),
)
const reviewersDirty = computed(
  () =>
    selected.value.size !== mr.value.reviewers.length ||
    mr.value.reviewers.some((id) => !selected.value.has(id)),
)

const saveReviewers = useApiMutation('put', '/v1/merge-requests/{id}/reviewers', { invalidates })

function toggleReviewer(userId: string) {
  const next = new Set(selected.value)
  if (next.has(userId)) next.delete(userId)
  else next.add(userId)
  selected.value = next
}
function submitReviewers() {
  saveReviewers.mutate(
    { path: { id: mr.value.mergeRequestId }, body: { reviewerIds: [...selected.value] } },
    {
      onSuccess: () => {
        editingReviewers.value = false
        toast.success('Reviewers updated')
        emit('changed')
      },
      onError: (e) => toast.error(e.message),
    },
  )
}
</script>

<template>
  <aside class="space-y-4">
    <!-- assignee -->
    <div class="rounded-lg border bg-card p-3">
      <div class="flex items-center gap-2">
        <p class="text-xs font-medium text-muted-foreground">Assignee</p>
        <button
          v-if="!readonly"
          class="ml-auto text-muted-foreground transition-colors hover:text-foreground"
          title="Edit assignee"
          @click="editingAssignee = !editingAssignee"
        >
          <Pencil class="size-3" />
        </button>
      </div>
      <div v-if="!editingAssignee" class="mt-2">
        <div v-if="mr.assigneeId" class="flex items-center gap-2 text-sm">
          <UserAvatar :user-id="mr.assigneeId" :name="nameOf(mr.assigneeId)" size="sm" />
          <span class="truncate">{{ nameOf(mr.assigneeId) }}</span>
        </div>
        <p v-else class="text-xs text-muted-foreground">None</p>
      </div>
      <div v-else class="mt-2 space-y-1">
        <button
          class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted"
          :disabled="updateMr.isPending.value"
          @click="setAssignee(null)"
        >
          <span class="size-5" /> <span class="text-muted-foreground">Unassigned</span>
        </button>
        <button
          v-for="m in members"
          :key="m.userId"
          class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted"
          :class="mr.assigneeId === m.userId ? 'bg-muted/70' : ''"
          :disabled="updateMr.isPending.value"
          @click="setAssignee(m.userId)"
        >
          <UserAvatar :user-id="m.userId" :name="m.displayName" size="sm" />
          <span class="truncate">{{ m.displayName }}</span>
        </button>
      </div>
    </div>

    <!-- reviewers -->
    <div class="rounded-lg border bg-card p-3">
      <div class="flex items-center gap-2">
        <p class="text-xs font-medium text-muted-foreground">
          Reviewers
          <span v-if="mr.reviewers.length > 0" class="text-muted-foreground/70">· {{ mr.reviewers.length }}</span>
        </p>
        <button
          v-if="!readonly"
          class="ml-auto text-muted-foreground transition-colors hover:text-foreground"
          title="Edit reviewers"
          @click="editingReviewers = !editingReviewers"
        >
          <Pencil class="size-3" />
        </button>
      </div>

      <div v-if="!editingReviewers" class="mt-2 space-y-1.5">
        <p v-if="mr.reviewers.length === 0" class="text-xs text-muted-foreground">None</p>
        <div v-for="id in mr.reviewers" :key="id" class="flex items-center gap-2 text-sm">
          <UserAvatar :user-id="id" :name="nameOf(id)" size="sm" />
          <span class="truncate">{{ nameOf(id) }}</span>
          <span
            v-if="mr.approvedBy.includes(id)"
            class="ml-auto text-xs text-emerald-600"
            title="Approved"
          >✓</span>
        </div>
      </div>

      <div v-else class="mt-2 space-y-1">
        <p v-if="members.length === 0" class="text-xs text-muted-foreground">No workspace members.</p>
        <Label
          v-for="m in members"
          :key="m.userId"
          class="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm font-normal hover:bg-muted"
        >
          <Checkbox
            :model-value="selected.has(m.userId)"
            :disabled="saveReviewers.isPending.value"
            @update:model-value="toggleReviewer(m.userId)"
          />
          <UserAvatar :user-id="m.userId" :name="m.displayName" size="sm" />
          <span class="truncate">{{ m.displayName }}</span>
        </Label>
        <Button
          v-if="reviewersDirty"
          size="xs"
          variant="outline"
          class="mt-1"
          :disabled="saveReviewers.isPending.value"
          @click="submitReviewers"
        >
          Save reviewers
        </Button>
      </div>
    </div>

    <AiCheckCard :merge-request="mr" />

    <!-- revisions -->
    <div class="rounded-lg border bg-card p-3 text-xs text-muted-foreground">
      <p class="mb-2 font-medium text-foreground">Revisions</p>
      <p v-if="mr.sourceHeadRevisionId" class="flex justify-between gap-2">
        source head <span class="font-mono">{{ mr.sourceHeadRevisionId.slice(0, 8) }}</span>
      </p>
      <p v-if="mr.targetHeadRevisionId" class="flex justify-between gap-2">
        target head <span class="font-mono">{{ mr.targetHeadRevisionId.slice(0, 8) }}</span>
      </p>
      <p v-if="mr.mergeBaseRevisionId" class="flex justify-between gap-2">
        merge base <span class="font-mono">{{ mr.mergeBaseRevisionId.slice(0, 8) }}</span>
      </p>
      <p v-if="mr.mergedRevisionId" class="flex justify-between gap-2">
        merged as <span class="font-mono">{{ mr.mergedRevisionId.slice(0, 8) }}</span>
      </p>
    </div>
  </aside>
</template>
