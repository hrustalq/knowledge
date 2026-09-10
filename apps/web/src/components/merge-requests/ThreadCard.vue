<script setup lang="ts">
// One discussion — a review thread or a comment on a page (feature 15); the
// card does not care which.
//
// The comment list is flat and time-ordered on the wire, and the whole job of
// this card is to stop it *reading* as flat. Three things do that:
//
// - A rail runs through every avatar, so a reply is visibly inside the
//   discussion the first comment opened rather than beside it.
// - A reply that answers one comment in particular carries a pointer back to
//   it: author plus a line of what they said. Hovering the pointer lifts that
//   comment; clicking it scrolls there and flashes it. The question this
//   answers — "which of these is that a reply to?" — is the one a flat list
//   cannot answer at all.
// - Replying from beside a comment aims at it, and the composer says so
//   before you send, so attribution is chosen deliberately rather than
//   inferred afterwards.
//
// Deliberately *not* a tree. Indenting a conversation trades the answer to
// "what was said, in what order" for the answer to "what hangs off what", and
// a thread pinned to one passage is short enough that order is worth more.
import { useI18n } from 'vue-i18n'
import { computed, nextTick, ref, useId, watch } from 'vue'
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  CornerUpLeft,
  History,
  Loader2,
  MapPin,
  MessagesSquare,
  Pencil,
  Reply,
  Trash2,
  X,
} from 'lucide-vue-next'
import type { ReviewComment, ReviewThread } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { Collapse } from '@/components/ui/collapse'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import { excerpt } from '@/lib/markdown/plain'
import CommentComposer from './CommentComposer.vue'
import UserChip from '@/components/people/UserChip.vue'
import { useMembers } from './use-members'
import { useAgentNames } from './use-agent-names'
import { fullTime, timelineTime } from './mr-ui'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()

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
  /** `replyToId` names the comment answered, or null for the thread at large. */
  reply: [body: string, replyToId: string | null]
  resolve: [resolved: boolean]
  edit: [commentId: string, body: string]
  delete: [commentId: string]
}>()

const { nameOf } = useMembers()
const { agentNames } = useAgentNames()
const auth = useAuthStore()
const panelId = useId()

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
/** The comment the pending reply answers, if it was aimed at one. */
const replyTo = ref<string | null>(null)
/** The comment a delete is waiting on confirmation for. */
const deleting = ref<string | null>(null)
/** Pointer-hovered target, lifted so the link is legible without a click. */
const linked = ref<string | null>(null)
const flashed = ref<string | null>(null)

const byId = computed(() => new Map(props.thread.comments.map((c) => [c.commentId, c])))
function parentOf(comment: ReviewComment): ReviewComment | null {
  // A pointer at a comment that has since been deleted resolves to nothing;
  // the reply then reads as a reply to the thread, which is what it now is.
  return comment.replyToId ? (byId.value.get(comment.replyToId) ?? null) : null
}

/**
 * Only a comment's own author may rewrite or remove it — the same rule the API
 * enforces (403 otherwise), mirrored here so the controls do not offer what
 * the server will refuse. In `AUTH_MODE=none` every comment is the dev
 * principal's, so both stay available in dev.
 */
function isMine(authorId: string): boolean {
  return !props.readonly && !props.thread.resolved && auth.me?.userId === authorId
}

/**
 * Whether a machine wrote this comment.
 *
 * Two signals, because there are two ways an AI remark gets here and neither
 * subsumes the other:
 *
 * - `comment.agentKey` — an agent tagged with `@` (docs/features/21). It replies
 *   inside somebody else's thread, and `authorId` is the person who tagged it,
 *   so only the comment can answer this.
 * - `thread.source === 'ai'` on the opening comment — a review posted whole from
 *   the AI check pane. That path writes no `agentKey`, so dropping it here would
 *   put a colleague's name and face on a model's findings.
 */
function isAgent(comment: ReviewComment, index: number): boolean {
  return comment.agentKey !== null || (props.thread.source === 'ai' && index === 0)
}

function authorLabel(comment: ReviewComment, index: number): string {
  if (comment.agentKey) return t('mention.agentLabel', { agent: agentName(comment.agentKey) })
  if (props.thread.source === 'ai' && index === 0) return t('mention.assistant')
  return nameOf(comment.authorId)
}

/** Falls back to the key: a workspace may rename an agent, or drop a custom one. */
function agentName(key: string): string {
  return agentNames.value.get(key) ?? key
}

function startEdit(commentId: string) {
  replyTo.value = null
  editing.value = commentId
}

function submitEdit(body: string) {
  if (!editing.value) return
  emit('edit', editing.value, body)
  editing.value = null
}

function confirmDelete() {
  if (!deleting.value) return
  emit('delete', deleting.value)
  deleting.value = null
}

/**
 * Reply beside a comment aims the one composer at the foot of the thread at
 * that comment. One box, because a thread with a composer under every comment
 * is a form, not a conversation.
 */
function focusReply(commentId: string | null) {
  expanded.value = true
  editing.value = null
  replyTo.value = commentId
  void nextTick(() => replyBox.value?.expand())
}

function submitReply(body: string) {
  emit('reply', body, replyTo.value)
  replyTo.value = null
}

const itemEls = new Map<string, HTMLElement>()
function registerItem(commentId: string, el: unknown) {
  if (el instanceof HTMLElement) itemEls.set(commentId, el)
  else itemEls.delete(commentId)
}

let flashTimer: ReturnType<typeof setTimeout> | undefined
function jumpTo(commentId: string) {
  itemEls.get(commentId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  // Re-triggering the animation needs the attribute to actually leave the DOM
  // between two jumps to the same comment, hence the nextTick round trip.
  flashed.value = null
  void nextTick(() => {
    flashed.value = commentId
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => (flashed.value = null), 1500)
  })
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
const opener = computed(() => props.thread.comments[0])
/** Collapsed, the card shows what it is about — as text, not as its markup. */
const summary = computed(() => excerpt(opener.value?.body ?? '', 90))
const replyTarget = computed(() =>
  replyTo.value ? (byId.value.get(replyTo.value) ?? null) : null,
)
</script>

<template>
  <article
    class="overflow-hidden rounded-lg border bg-card"
    :class="thread.resolved ? 'opacity-75' : ''"
  >
    <!-- Header. The disclosure and Resolve are siblings, not nested: one
         control per action, and a button inside a button is neither. -->
    <div class="flex items-center gap-2 border-b bg-muted/40 pr-1.5 text-xs">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/60"
        :aria-expanded="expanded"
        :aria-controls="panelId"
        @click="expanded = !expanded"
      >
        <!-- Rotates rather than swapping glyphs: a swap is a jump cut sitting
             next to a body that opens smoothly, and every other disclosure in
             the app turns the same chevron. -->
        <ChevronRight
          class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150"
          :class="expanded ? 'rotate-90' : ''"
        />
        <!-- The assistant posts under the identity of whoever ran it, so
             without this the finding reads as that person's own remark. -->
        <span
          v-if="thread.source === 'ai'"
          class="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-violet-500/12 px-1.5 py-px font-medium text-violet-700 dark:text-violet-300"
          :title="t('mr.fromAssistantReview')"
        >
          <Bot class="size-3" /> AI
        </span>
        <span
          v-if="thread.resolved"
          class="flex shrink-0 items-center gap-1 whitespace-nowrap text-emerald-600 dark:text-emerald-400"
        >
          <CheckCircle2 class="size-3.5" /> {{ t('mr.resolvedBadge') }}
        </span>
        <span
          v-if="outdated"
          class="flex shrink-0 items-center gap-1 whitespace-nowrap text-amber-600 dark:text-amber-400"
          :title="t('mr.anchorOutdated')"
        >
          <History class="size-3.5" /> {{ t('mr.outdatedBadge') }}
        </span>
        <span
          v-if="anchorLabel"
          class="flex min-w-0 items-center gap-1 font-mono text-muted-foreground"
          :title="anchorLabel"
        >
          <MapPin class="size-3 shrink-0" /><span class="truncate">{{ anchorLabel }}</span>
        </span>
        <span
          v-if="!expanded && opener"
          class="hidden min-w-0 items-center gap-1.5 text-muted-foreground sm:flex"
        >
          <UserAvatar
            :user-id="opener.authorId"
            :name="nameOf(opener.authorId)"
            :ai="thread.source === 'ai'"
            size="sm"
          />
          <span class="truncate">{{ summary }}</span>
        </span>
        <span
          class="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground"
          :title="fullTime(thread.createdAt)"
        >
          <MessagesSquare class="size-3" aria-hidden="true" />
          {{ thread.comments.length }}
          <span class="hidden sm:inline">· {{ timelineTime(thread.createdAt) }}</span>
        </span>
      </button>
      <!-- A plain comment has nothing to resolve, so it is offered nothing. -->
      <Button
        v-if="!readonly && thread.resolvable"
        variant="ghost"
        size="xs"
        class="shrink-0"
        :disabled="busy"
        @click="emit('resolve', !thread.resolved)"
      >
        {{ thread.resolved ? t('mr.reopenThread') : t('mr.resolveThread') }}
      </Button>
    </div>

    <Collapse :open="expanded">
      <div :id="panelId">
        <ol class="kn-thread px-3 py-3">
          <li
            v-for="(comment, i) in thread.comments"
            :key="comment.commentId"
            :ref="(el) => registerItem(comment.commentId, el)"
            class="kn-thread-item"
            :data-reply="i > 0"
            :data-linked="linked === comment.commentId"
            :data-flash="flashed === comment.commentId"
          >
            <div class="kn-thread-rail">
              <!-- The rail's face is the hover target for the whole byline: one
                   affordance per comment, on the thing a reader is already
                   looking at to see who spoke. The name beside it stays plain
                   text so there is no second card on the same person. -->
              <UserChip
                :user-id="comment.authorId"
                :name="nameOf(comment.authorId)"
                :ai="isAgent(comment, i)"
                :agent-name="comment.agentKey ? agentName(comment.agentKey) : undefined"
                :size="i === 0 ? 'md' : 'sm'"
                avatar-only
              />
            </div>

            <div class="kn-comment-surface min-w-0 flex-1">
              <p class="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span class="truncate font-medium text-foreground">
                  {{ authorLabel(comment, i) }}
                </span>
                <!-- An agent replies under the identity of whoever tagged it —
                     it has no account — so the person is named here rather than
                     silently standing in as the author. -->
                <span v-if="comment.agentKey" class="shrink-0 truncate">
                  · {{ t('mention.viaActor', { actor: nameOf(comment.authorId) }) }}
                </span>
                <span class="shrink-0" :title="fullTime(comment.createdAt)">
                  · {{ timelineTime(comment.createdAt) }}
                </span>
                <span
                  v-if="comment.updatedAt"
                  class="shrink-0 italic"
                  :title="`Edited ${fullTime(comment.updatedAt)}`"
                >
                  · edited
                </span>
                <!-- Actions ride the row rather than a menu: three of them, and
                     a discussion is read far more often than it is corrected. -->
                <span
                  v-if="!readonly && !thread.resolved && editing !== comment.commentId"
                  class="kn-comment-actions ml-auto flex shrink-0 items-center gap-0.5"
                >
                  <button
                    type="button"
                    class="rounded p-1 hover:bg-accent hover:text-foreground"
                    :title="`Reply to ${nameOf(comment.authorId)}`"
                    :aria-label="`Reply to ${nameOf(comment.authorId)}`"
                    @click="focusReply(comment.commentId)"
                  >
                    <Reply class="size-3.5" />
                  </button>
                  <button
                    v-if="isMine(comment.authorId)"
                    type="button"
                    class="rounded p-1 hover:bg-accent hover:text-foreground"
                    :title="t('mr.editComment')"
                    :aria-label="t('mr.editComment')"
                    @click="startEdit(comment.commentId)"
                  >
                    <Pencil class="size-3.5" />
                  </button>
                  <button
                    v-if="isMine(comment.authorId)"
                    type="button"
                    class="rounded p-1 hover:bg-destructive/10 hover:text-destructive"
                    :title="t('mr.deleteComment')"
                    :aria-label="t('mr.deleteComment')"
                    @click="deleting = comment.commentId"
                  >
                    <Trash2 class="size-3.5" />
                  </button>
                </span>
              </p>

              <!-- What this reply is a reply to. -->
              <button
                v-if="parentOf(comment)"
                type="button"
                class="kn-reply-ref"
                :title="`Go to ${nameOf(parentOf(comment)!.authorId)}’s comment`"
                @click="jumpTo(parentOf(comment)!.commentId)"
                @mouseenter="linked = parentOf(comment)!.commentId"
                @mouseleave="linked = null"
                @focus="linked = parentOf(comment)!.commentId"
                @blur="linked = null"
              >
                <CornerUpLeft class="size-3 shrink-0" aria-hidden="true" />
                <span class="kn-reply-ref-author">{{ nameOf(parentOf(comment)!.authorId) }}</span>
                <span class="kn-reply-ref-quote">{{ excerpt(parentOf(comment)!.body, 90) }}</span>
              </button>

              <CommentComposer
                v-if="editing === comment.commentId"
                auto-expand
                cancellable
                :initial-body="editingBody"
                :placeholder="t('mr.editYourComment')"
                :submit-label="t('common.save')"
                :busy="busy"
                :resolve-document-id="resolveDocumentId"
                @submit="submitEdit"
                @cancel="editing = null"
              />
              <!-- Posted before the answer exists, so there is nothing to
                   render yet. Saying which agent is working beats an empty
                   card, which reads as a comment somebody failed to write. -->
              <p
                v-else-if="comment.pending"
                class="flex items-center gap-1.5 text-sm text-muted-foreground italic"
              >
                <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
                {{ t('mention.thinking', { agent: agentName(comment.agentKey ?? '') }) }}
              </p>
              <MarkdownView v-else :markdown="comment.body" />
            </div>
          </li>
        </ol>

        <div v-if="!readonly && !thread.resolved" class="border-t bg-muted/20 px-3 py-2">
          <!-- Aim shown before sending, and droppable: a reply attributed to the
               wrong comment is worse than one attributed to none. -->
          <div
            v-if="replyTarget"
            class="mb-1.5 flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
          >
            <CornerUpLeft class="size-3 shrink-0" aria-hidden="true" />
            <span class="shrink-0">{{ t('mr.replyingTo') }}</span>
            <span class="shrink-0 font-medium text-foreground">
              {{ nameOf(replyTarget.authorId) }}
            </span>
            <span class="min-w-0 flex-1 truncate opacity-85">{{ excerpt(replyTarget.body, 70) }}</span>
            <button
              type="button"
              class="shrink-0 rounded p-0.5 hover:bg-accent hover:text-foreground"
              :title="t('mr.replyToThread')"
              :aria-label="t('mr.replyToThread')"
              @click="replyTo = null"
            >
              <X class="size-3" />
            </button>
          </div>
          <CommentComposer
            ref="replyBox"
            :placeholder="replyTarget ? `Reply to ${nameOf(replyTarget.authorId)}…` : 'Reply…'"
            :submit-label="t('mr.reply')"
            :busy="busy"
            :resolve-document-id="resolveDocumentId"
            @submit="submitReply"
            @cancel="replyTo = null"
          />
        </div>
      </div>
    </Collapse>

    <AlertDialog :open="deleting !== null" @update:open="(o: boolean) => !o && (deleting = null)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('mr.deleteCommentTitle') }}</AlertDialogTitle>
          <AlertDialogDescription>
            <template v-if="thread.comments.length === 1">
              {{ t('mr.deleteLastComment') }}
            </template>
            <template v-else>
              {{ t('mr.deleteOneComment') }}
            </template>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel @click="deleting = null">{{ t('mr.keepIt') }}</AlertDialogCancel>
          <AlertDialogAction
            class="bg-destructive text-white hover:bg-destructive/90"
            @click="confirmDelete"
          >
            {{ t('common.delete') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </article>
</template>
