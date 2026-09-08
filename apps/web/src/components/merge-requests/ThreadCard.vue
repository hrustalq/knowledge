<script setup lang="ts">
// One discussion — a review thread or a comment on a page (feature 15); the
// card does not care which. Collapsible comment list (collapsed when
// resolved), anchor label, reply, resolve, and editing your own comment in
// place. Resolve is offered only on a resolvable thread: a plain comment (see
// ReviewThread.resolvable) is a remark with nothing to close.
import { computed, nextTick, ref, watch } from 'vue'
import { CheckCircle2, ChevronDown, ChevronRight, History, MapPin, Pencil, Reply } from 'lucide-vue-next'
import type { ReviewThread } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import CommentComposer from './CommentComposer.vue'
import UserAvatar from './UserAvatar.vue'
import { useMembers } from './use-members'
import { fullTime, timelineTime } from './mr-ui'
import { useAuthStore } from '@/stores/auth'

const props = withDefaults(
  defineProps<{
    thread: ReviewThread
    outdated?: boolean
    readonly?: boolean
    busy?: boolean
    /** Document that reply attachments belong to; without it the control hides. */
    resolveDocumentId?: () => Promise<string | null>
  }>(),
  { outdated: false, readonly: false, busy: false, resolveDocumentId: undefined },
)
const emit = defineEmits<{
  reply: [body: string]
  resolve: [resolved: boolean]
  edit: [commentId: string, body: string]
}>()

const { nameOf } = useMembers()
const auth = useAuthStore()

/** Resolved threads start collapsed; resolving/unresolving follows along. */
const expanded = ref(!props.thread.resolved)
watch(
  () => props.thread.resolved,
  (resolved) => (expanded.value = !resolved),
)

const replyBox = ref<InstanceType<typeof CommentComposer> | null>(null)
/** The comment currently being rewritten in place, if any. */
const editing = ref<string | null>(null)
const editingBody = computed(
  () => props.thread.comments.find((c) => c.commentId === editing.value)?.body ?? '',
)

/**
 * Only a comment's own author may rewrite it — the same rule the API enforces
 * (403 otherwise), mirrored here so the control does not offer what the server
 * will refuse. In `AUTH_MODE=none` every comment is the dev principal's, so
 * editing stays available in dev.
 */
function canEdit(authorId: string): boolean {
  return !props.readonly && !props.thread.resolved && auth.me?.userId === authorId
}

function startEdit(commentId: string) {
  editing.value = commentId
}

function submitEdit(body: string) {
  if (!editing.value) return
  emit('edit', editing.value, body)
  editing.value = null
}

/** A Reply beside a comment opens the one composer at the foot of the thread. */
function focusReply() {
  expanded.value = true
  editing.value = null
  void nextTick(() => replyBox.value?.expand())
}

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
      <span
        v-if="anchorLabel"
        class="flex min-w-0 items-center gap-1 font-mono text-muted-foreground"
        :title="anchorLabel"
      >
        <MapPin class="size-3 shrink-0" /><span class="truncate">{{ anchorLabel }}</span>
      </span>
      <span v-if="!expanded && starter" class="hidden min-w-0 items-center gap-1.5 text-muted-foreground sm:flex">
        <UserAvatar :user-id="starter" :name="nameOf(starter)" size="sm" />
        <span class="truncate">{{ thread.comments[0]?.body }}</span>
      </span>
      <span class="ml-auto shrink-0 text-muted-foreground" :title="fullTime(thread.createdAt)">
        {{ thread.comments.length }} comment{{ thread.comments.length === 1 ? '' : 's' }}
        · {{ timelineTime(thread.createdAt) }}
      </span>
      <!-- A plain comment has nothing to resolve, so it is offered nothing. -->
      <Button
        v-if="!readonly && thread.resolvable"
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
        <div v-for="comment in thread.comments" :key="comment.commentId" class="group/comment px-3 py-2">
          <p class="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <UserAvatar :user-id="comment.authorId" :name="nameOf(comment.authorId)" size="sm" />
            <span class="font-medium text-foreground">{{ nameOf(comment.authorId) }}</span>
            <span :title="fullTime(comment.createdAt)">· {{ timelineTime(comment.createdAt) }}</span>
            <span
              v-if="comment.updatedAt"
              class="italic"
              :title="`Edited ${fullTime(comment.updatedAt)}`"
            >
              · edited
            </span>
            <!-- Actions ride the row rather than a menu: two of them, and a
                 discussion is read far more often than it is corrected. -->
            <span
              v-if="!readonly && !thread.resolved && editing !== comment.commentId"
              class="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100"
            >
              <button
                type="button"
                class="rounded p-1 hover:bg-accent hover:text-foreground"
                title="Reply in this thread"
                aria-label="Reply in this thread"
                @click="focusReply"
              >
                <Reply class="size-3.5" />
              </button>
              <button
                v-if="canEdit(comment.authorId)"
                type="button"
                class="rounded p-1 hover:bg-accent hover:text-foreground"
                title="Edit this comment"
                aria-label="Edit this comment"
                @click="startEdit(comment.commentId)"
              >
                <Pencil class="size-3.5" />
              </button>
            </span>
          </p>
          <CommentComposer
            v-if="editing === comment.commentId"
            auto-expand
            cancellable
            :initial-body="editingBody"
            placeholder="Edit your comment…"
            submit-label="Save"
            :busy="busy"
            :resolve-document-id="resolveDocumentId"
            @submit="submitEdit"
            @cancel="editing = null"
          />
          <MarkdownView v-else :markdown="comment.body" />
        </div>
      </div>
      <div v-if="!readonly && !thread.resolved" class="border-t bg-muted/20 px-3 py-2">
        <CommentComposer
          ref="replyBox"
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
