<script setup lang="ts">
// One review discussion: anchor label, flat comment list, reply + resolve.
import { computed } from 'vue'
import type { MergeRequestThread } from '@knowledge/contracts'
import { relativeTime } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import CommentComposer from './CommentComposer.vue'

const props = withDefaults(
  defineProps<{ thread: MergeRequestThread; outdated?: boolean; readonly?: boolean; busy?: boolean }>(),
  { outdated: false, readonly: false, busy: false },
)
const emit = defineEmits<{ reply: [body: string]; resolve: [resolved: boolean] }>()

const anchorLabel = computed(() => {
  const a = props.thread.anchor
  if (!a) return null
  if (a.type === 'line') return `line ${a.line}`
  if (a.type === 'section') return `§ ${a.heading}`
  return a.entityKey
})
</script>

<template>
  <div class="rounded-md border" :class="thread.resolved ? 'opacity-70' : ''">
    <div class="flex items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-xs">
      <Badge v-if="thread.resolved" variant="secondary">Resolved</Badge>
      <Badge v-if="outdated" variant="outline">Outdated</Badge>
      <span v-if="anchorLabel" class="font-mono text-muted-foreground">{{ anchorLabel }}</span>
      <span class="ml-auto text-muted-foreground">{{ relativeTime(thread.createdAt) }}</span>
      <Button
        v-if="!readonly"
        variant="ghost"
        size="xs"
        :disabled="busy"
        @click="emit('resolve', !thread.resolved)"
      >{{ thread.resolved ? 'Unresolve' : 'Resolve' }}</Button>
    </div>
    <div class="divide-y">
      <div v-for="comment in thread.comments" :key="comment.commentId" class="px-3 py-2">
        <p class="mb-1 text-xs text-muted-foreground">
          <span class="font-mono">{{ comment.authorId.slice(0, 8) }}</span>
          · {{ relativeTime(comment.createdAt) }}
        </p>
        <MarkdownView :markdown="comment.body" />
      </div>
    </div>
    <div v-if="!readonly && !thread.resolved" class="border-t px-3 py-2">
      <CommentComposer placeholder="Reply…" submit-label="Reply" :busy="busy" @submit="(b) => emit('reply', b)" />
    </div>
  </div>
</template>
