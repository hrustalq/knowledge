<script setup lang="ts">
// One review discussion: collapsible comment list (collapsed when resolved),
// anchor label, reply + resolve.
import { computed, ref, watch } from 'vue'
import { CheckCircle2, ChevronDown, ChevronRight, History, MapPin } from 'lucide-vue-next'
import type { MergeRequestThread } from '@knowledge/contracts'
import { relativeTime } from '@/lib/api'
import { Button } from '@/components/ui/button'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import CommentComposer from './CommentComposer.vue'
import UserAvatar from './UserAvatar.vue'
import { useMembers } from './use-members'

const props = withDefaults(
  defineProps<{ thread: MergeRequestThread; outdated?: boolean; readonly?: boolean; busy?: boolean }>(),
  { outdated: false, readonly: false, busy: false },
)
const emit = defineEmits<{ reply: [body: string]; resolve: [resolved: boolean] }>()

const { nameOf } = useMembers()

/** Resolved threads start collapsed; resolving/unresolving follows along. */
const expanded = ref(!props.thread.resolved)
watch(
  () => props.thread.resolved,
  (resolved) => (expanded.value = !resolved),
)

const anchorLabel = computed(() => {
  const a = props.thread.anchor
  if (!a) return null
  if (a.type === 'line') return `line ${a.line}`
  if (a.type === 'section') return `§ ${a.heading}`
  return a.entityKey
})
const starter = computed(() => props.thread.comments[0]?.authorId)
</script>

<template>
  <div class="overflow-hidden rounded-lg border bg-card" :class="thread.resolved ? 'opacity-75' : ''">
    <button
      class="flex w-full items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <component :is="expanded ? ChevronDown : ChevronRight" class="size-3.5 shrink-0 text-muted-foreground" />
      <span v-if="thread.resolved" class="flex items-center gap-1 text-emerald-600">
        <CheckCircle2 class="size-3.5" /> Resolved
      </span>
      <span v-if="outdated" class="flex items-center gap-1 text-amber-600" title="The branch advanced past this anchor">
        <History class="size-3.5" /> Outdated
      </span>
      <span v-if="anchorLabel" class="flex items-center gap-1 font-mono text-muted-foreground">
        <MapPin class="size-3" />{{ anchorLabel }}
      </span>
      <span v-if="!expanded && starter" class="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <UserAvatar :user-id="starter" :name="nameOf(starter)" size="sm" />
        <span class="truncate">{{ thread.comments[0]?.body }}</span>
      </span>
      <span class="ml-auto shrink-0 text-muted-foreground">
        {{ thread.comments.length }} comment{{ thread.comments.length === 1 ? '' : 's' }}
        · {{ relativeTime(thread.createdAt) }}
      </span>
      <Button
        v-if="!readonly"
        variant="ghost"
        size="xs"
        :disabled="busy"
        @click.stop="emit('resolve', !thread.resolved)"
      >
        {{ thread.resolved ? 'Reopen' : 'Resolve' }}
      </Button>
    </button>

    <template v-if="expanded">
      <div class="divide-y">
        <div v-for="comment in thread.comments" :key="comment.commentId" class="px-3 py-2">
          <p class="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <UserAvatar :user-id="comment.authorId" :name="nameOf(comment.authorId)" size="sm" />
            <span class="font-medium text-foreground">{{ nameOf(comment.authorId) }}</span>
            · {{ relativeTime(comment.createdAt) }}
          </p>
          <MarkdownView :markdown="comment.body" />
        </div>
      </div>
      <div v-if="!readonly && !thread.resolved" class="border-t bg-muted/20 px-3 py-2">
        <CommentComposer placeholder="Reply…" submit-label="Reply" :busy="busy" @submit="(b) => emit('reply', b)" />
      </div>
    </template>
  </div>
</template>
