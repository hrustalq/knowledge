<script setup lang="ts">
// One merge request as a card (GitLab MR-list style): state icon, title,
// branches, assignee + reviewer avatars, approval/thread stats, age.
import { computed } from 'vue'
import { MessageSquare, ThumbsUp } from 'lucide-vue-next'
import type { MergeRequestInfo } from '@knowledge/contracts'
import { relativeTime } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import UserAvatar from './UserAvatar.vue'
import { mrIcon } from './mr-ui'
import { useMembers } from './use-members'

const props = defineProps<{ mergeRequest: MergeRequestInfo }>()
const { nameOf } = useMembers()

const mr = computed(() => props.mergeRequest)
const state = computed(() => mrIcon(mr.value))
</script>

<template>
  <div class="rounded-lg border bg-card p-3 transition-colors hover:border-primary/40">
    <div class="flex items-start gap-3">
      <component :is="state.icon" class="mt-0.5 size-4 shrink-0" :class="state.class" :title="state.label" />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <RouterLink
            :to="`/merge-requests/${mr.mergeRequestId}`"
            class="truncate text-sm font-medium transition-colors hover:text-primary"
          >
            {{ mr.title }}
          </RouterLink>
          <Badge v-if="mr.isDraft" variant="outline" class="text-xs">Draft</Badge>
        </div>
        <p class="mt-0.5 truncate text-xs text-muted-foreground">
          <span class="font-mono">{{ mr.sourceBranch }} → {{ mr.targetBranch }}</span>
          · opened {{ relativeTime(mr.createdAt) }} by {{ nameOf(mr.authorId) }}
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
        <!-- stats -->
        <span
          v-if="mr.approvedBy.length > 0"
          class="flex items-center gap-1 text-emerald-600"
          :title="`${mr.approvedBy.length} approval(s)`"
        >
          <ThumbsUp class="size-3.5" />{{ mr.approvedBy.length }}
        </span>
        <span
          v-if="mr.threadStats.total > 0"
          class="flex items-center gap-1"
          :class="mr.threadStats.unresolved > 0 ? 'text-amber-600' : ''"
          :title="`${mr.threadStats.unresolved} of ${mr.threadStats.total} threads unresolved`"
        >
          <MessageSquare class="size-3.5" />{{ mr.threadStats.unresolved }}/{{ mr.threadStats.total }}
        </span>

        <!-- people -->
        <span class="flex items-center -space-x-1.5" :title="mr.reviewers.map((r) => nameOf(r)).join(', ')">
          <UserAvatar
            v-for="id in mr.reviewers.slice(0, 3)"
            :key="id"
            :user-id="id"
            :name="nameOf(id)"
            size="sm"
            class="ring-2 ring-card"
          />
          <span v-if="mr.reviewers.length > 3" class="pl-2.5 text-[10px]">+{{ mr.reviewers.length - 3 }}</span>
        </span>
        <UserAvatar
          v-if="mr.assigneeId"
          :user-id="mr.assigneeId"
          :name="`${nameOf(mr.assigneeId)} (assignee)`"
        />
      </div>
    </div>
  </div>
</template>
