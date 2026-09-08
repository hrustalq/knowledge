<script setup lang="ts">
// One review discussion: collapsible comment list (collapsed when resolved),
// anchor label, reply + resolve.
import { computed, ref, watch } from 'vue'
import { CheckCircle2, ChevronDown, ChevronRight, History, MapPin } from 'lucide-vue-next'
import type { MergeRequestThread } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import CommentComposer from './CommentComposer.vue'
import UserAvatar from './UserAvatar.vue'
import { useMembers } from './use-members'
import { fullTime, timelineTime } from './mr-ui'

const props = withDefaults(
  defineProps<{
    thread: MergeRequestThread
    outdated?: boolean
    readonly?: boolean
    busy?: boolean
    /** Document that reply attachments belong to; without it the control hides. */
    resolveDocumentId?: () => Promise<string | null>
  }>(),
  { outdated: false, readonly: false, busy: false, resolveDocumentId: undefined },
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
  // A review-mode anchor has no position to name, so it names the passage.
  if (a.type === 'text') return `“${a.quote.slice(0, 40)}${a.quote.length > 40 ? '…' : ''}”`
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
      <span v-if="thread.resolved" class="flex shrink-0 items-center gap-1 whitespace-nowrap text-emerald-600">
        <CheckCircle2 class="size-3.5" /> Resolved
      </span>
      <span
        v-if="outdated"
        class="flex shrink-0 items-center gap-1 whitespace-nowrap text-amber-600"
        title="The branch advanced past this anchor"
      >
        <History class="size-3.5" /> Outdated
      </span>
      <span v-if="anchorLabel" class="flex shrink-0 items-center gap-1 font-mono whitespace-nowrap text-muted-foreground">
        <MapPin class="size-3" />{{ anchorLabel }}
      </span>
      <span v-if="!expanded && starter" class="hidden min-w-0 items-center gap-1.5 text-muted-foreground sm:flex">
        <UserAvatar :user-id="starter" :name="nameOf(starter)" size="sm" />
        <span class="truncate">{{ thread.comments[0]?.body }}</span>
      </span>
      <span class="ml-auto shrink-0 text-muted-foreground" :title="fullTime(thread.createdAt)">
        {{ thread.comments.length }} comment{{ thread.comments.length === 1 ? '' : 's' }}
        · {{ timelineTime(thread.createdAt) }}
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
            <span :title="fullTime(comment.createdAt)">· {{ timelineTime(comment.createdAt) }}</span>
          </p>
          <MarkdownView :markdown="comment.body" />
        </div>
      </div>
      <div v-if="!readonly && !thread.resolved" class="border-t bg-muted/20 px-3 py-2">
        <CommentComposer
          placeholder="Reply…"
          submit-label="Reply"
          :busy="busy"
          :resolve-document-id="resolveDocumentId"
          @submit="(b: string) => emit('reply', b)"
        />
      </div>
    </template>
  </div>
</template>
