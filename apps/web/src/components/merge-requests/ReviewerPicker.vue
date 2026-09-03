<script setup lang="ts">
// Reviewer assignment: checkbox list of workspace members, replace-set PUT.
import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type { ListWorkspaceMembersResponse, MergeRequestInfo } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'

const props = defineProps<{ mergeRequest: MergeRequestInfo; readonly?: boolean }>()
const emit = defineEmits<{ changed: [] }>()

const membersQuery = useQuery(
  apiQueryOptions('/v1/workspaces/{id}/members', { path: { id: getWorkspaceId() } }),
)
const members = computed(
  () => (membersQuery.data.value as ListWorkspaceMembersResponse | undefined)?.members ?? [],
)

const selected = ref<Set<string>>(new Set(props.mergeRequest.reviewers))
watch(
  () => props.mergeRequest.reviewers,
  (next) => (selected.value = new Set(next)),
)
const dirty = computed(
  () =>
    selected.value.size !== props.mergeRequest.reviewers.length ||
    props.mergeRequest.reviewers.some((id) => !selected.value.has(id)),
)

const save = useApiMutation('put', '/v1/merge-requests/{id}/reviewers', {
  invalidates: () => [['/v1/merge-requests/{id}', { id: props.mergeRequest.mergeRequestId }, null]],
})

function toggle(userId: string) {
  const next = new Set(selected.value)
  if (next.has(userId)) next.delete(userId)
  else next.add(userId)
  selected.value = next
}

function submit() {
  save.mutate(
    { path: { id: props.mergeRequest.mergeRequestId }, body: { reviewerIds: [...selected.value] } },
    {
      onSuccess: () => {
        toast.success('Reviewers updated')
        emit('changed')
      },
      onError: (e) => toast.error(e.message),
    },
  )
}
</script>

<template>
  <div class="space-y-2">
    <p class="text-xs font-medium text-muted-foreground">Reviewers</p>
    <p v-if="members.length === 0" class="text-xs text-muted-foreground">No workspace members.</p>
    <label
      v-for="m in members"
      :key="m.userId"
      class="flex cursor-pointer items-center gap-2 text-sm"
      :class="readonly ? 'pointer-events-none opacity-60' : ''"
    >
      <input
        type="checkbox"
        :checked="selected.has(m.userId)"
        :disabled="readonly || save.isPending.value"
        @change="toggle(m.userId)"
      />
      <span>{{ m.displayName }}</span>
      <span class="text-xs text-muted-foreground">{{ m.email }}</span>
    </label>
    <Button v-if="!readonly && dirty" size="xs" variant="outline" :disabled="save.isPending.value" @click="submit">
      Save reviewers
    </Button>
  </div>
</template>
