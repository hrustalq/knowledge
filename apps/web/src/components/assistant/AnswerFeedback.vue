<script setup lang="ts">
// Thumbs under an answer (docs/features/38, phase 2).
//
// Two buttons, always visible: a vote is the one thing a reader is asked to
// do here, so it does not hide behind a hover. Thumbs-up sends at once.
// Thumbs-down opens a small form for the reason, because a down-vote with no
// reason is a number nobody can act on — the API refuses it, and so does the
// Send button. Pressing the active thumb takes the vote back.
//
// Two targets, one component: a persisted reply (voted through the feedback
// store, so the thumbs survive a reload) or a one-shot `/ask` answer the API
// never stored (voted as what the reader saw, kept locally).
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ThumbsDown, ThumbsUp } from 'lucide-vue-next'
import type { AnswerFeedbackReason, AnswerVote, AssistantSource } from '@knowledge/contracts'
import { ANSWER_FEEDBACK_REASONS } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { getWorkspaceId } from '@/lib/api'
import { useFeedbackStore } from '@/stores/feedback'
import { hasDraftBridge } from '@/stores/assistant'
import {
  canSend,
  reportKindFor,
  reportablePages,
  thumbAction,
  voteSurface,
  type FeedbackTarget,
  type VoteDraft,
} from '@/lib/answer-feedback'

const props = defineProps<{
  target: FeedbackTarget
  /** For a message target: the vote the thread read came with. */
  initial?: AnswerVote | null
  /** For a message target: the reply's sources, so a wrong/outdated vote can report the pages it cited. */
  sources?: readonly AssistantSource[]
  /** For a message target: the question the reply answered, carried into the report. */
  query?: string
}>()

const { t } = useI18n()
const store = useFeedbackStore()

// The /ask widget keeps its vote here; a message's vote lives in the store.
const local = ref<AnswerVote | null>(null)
const current = computed<AnswerVote | null>(() =>
  props.target.kind === 'message'
    ? store.voteFor({ id: props.target.messageId, feedback: props.initial })
    : local.value,
)
const busy = computed(() => (props.target.kind === 'message' ? store.busy[props.target.messageId] === true : sending.value))

const open = ref(false)
const sending = ref(false)
const error = ref<string | null>(null)
const reason = ref<AnswerFeedbackReason | null>(null)
const comment = ref('')
const thanked = ref(false)
let thankTimer: ReturnType<typeof setTimeout> | null = null

// A `wrong` / `outdated` vote names its pages (docs/features/38, phase 3):
// the cited workspace pages can be reported in the same gesture, ticked by
// default because that is what the vote means. Hidden when the reason is
// about the answer rather than the pages, or when nothing was cited.
const reportPages = ref(true)
const pages = computed(() =>
  reportablePages(props.target.kind === 'ask' ? props.target.sources : (props.sources ?? [])),
)
const reportKind = computed(() => reportKindFor(reason.value))
const canReport = computed(() => reportKind.value !== null && pages.value.length > 0)
const reported = ref<{ reported: number; failed: number } | null>(null)

watch(open, (isOpen) => {
  if (!isOpen) return
  // Reopening on an existing down-vote starts from what was said last time.
  reason.value = current.value?.rating === 'down' ? current.value.reason : null
  comment.value = current.value?.rating === 'down' ? (current.value.comment ?? '') : ''
  reportPages.value = true
  reported.value = null
  error.value = null
})

function thank() {
  thanked.value = true
  if (thankTimer) clearTimeout(thankTimer)
  thankTimer = setTimeout(() => (thanked.value = false), 2000)
}

async function submit(draft: VoteDraft) {
  if (busy.value || !canSend(draft.rating, draft.reason)) return
  error.value = null
  try {
    if (props.target.kind === 'message') {
      await store.vote(props.target.messageId, draft, voteSurface(hasDraftBridge()))
    } else {
      sending.value = true
      local.value = await store.voteOnAsk(props.target, draft)
    }
    open.value = false
    thank()
    // After the vote has landed: a report per cited page, best-effort. The
    // vote is the thing that must not be lost; a report that fails is said.
    const kind = reportKindFor(draft.reason)
    if (draft.rating === 'down' && kind && reportPages.value && pages.value.length > 0) {
      reported.value = await store.reportCitedPages(pages.value, {
        workspaceId: props.target.kind === 'ask' ? props.target.workspaceId : getWorkspaceId(),
        kind,
        query: props.target.kind === 'ask' ? props.target.query : (props.query ?? ''),
        comment: draft.comment,
        surface: props.target.kind === 'ask' ? 'ask' : voteSurface(hasDraftBridge()),
      })
    }
  } catch {
    error.value = t('assistant.feedback.failed')
  } finally {
    sending.value = false
  }
}

async function retract() {
  if (busy.value) return
  error.value = null
  try {
    if (props.target.kind === 'message') await store.retract(props.target.messageId, current.value)
    // An /ask vote cannot be taken back: the API never pointed it at anything
    // it could find again. The thumb simply clears.
    else local.value = null
    open.value = false
  } catch {
    error.value = t('assistant.feedback.failed')
  }
}

function pressUp() {
  const action = thumbAction(current.value, 'up')
  if (action === 'retract') void retract()
  else void submit({ rating: 'up', reason: null, comment: '' })
}

function pressDown() {
  const action = thumbAction(current.value, 'down')
  if (action === 'retract') void retract()
  else open.value = true
}
</script>

<template>
  <div class="kn-feedback flex items-center gap-0.5" :aria-busy="busy">
    <button
      type="button"
      class="kn-thumb"
      :class="{ 'kn-thumb-active': current?.rating === 'up' }"
      :aria-pressed="current?.rating === 'up'"
      :aria-label="current?.rating === 'up' ? t('assistant.feedback.retract') : t('assistant.feedback.up')"
      :title="t('assistant.feedback.up')"
      :disabled="busy"
      @click="pressUp"
    >
      <ThumbsUp class="size-3.5" />
    </button>

    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <button
          type="button"
          class="kn-thumb"
          :class="{ 'kn-thumb-active kn-thumb-down': current?.rating === 'down' }"
          :aria-pressed="current?.rating === 'down'"
          :aria-label="current?.rating === 'down' ? t('assistant.feedback.retract') : t('assistant.feedback.down')"
          :title="t('assistant.feedback.down')"
          :disabled="busy"
          @click.prevent="pressDown"
        >
          <ThumbsDown class="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent class="w-80 space-y-3 text-sm" align="start" :side-offset="6">
        <p class="font-medium">{{ t('assistant.feedback.reasonTitle') }}</p>
        <div class="flex flex-wrap gap-1.5" role="radiogroup" :aria-label="t('assistant.feedback.reasonTitle')">
          <button
            v-for="r in ANSWER_FEEDBACK_REASONS"
            :key="r"
            type="button"
            role="radio"
            :aria-checked="reason === r"
            class="rounded-full border px-2.5 py-0.5 text-xs transition-colors"
            :class="reason === r ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:border-primary hover:text-primary'"
            @click="reason = r"
          >
            {{ t(`assistant.feedback.reason.${r}`) }}
          </button>
        </div>
        <label class="block space-y-1">
          <span class="text-xs text-muted-foreground">{{ t('assistant.feedback.comment') }}</span>
          <textarea
            v-model="comment"
            rows="3"
            maxlength="2000"
            :placeholder="t('assistant.feedback.commentPlaceholder')"
            class="w-full resize-y rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-ring focus:ring-3 focus:ring-ring/25"
            @keydown.enter.meta.prevent="submit({ rating: 'down', reason, comment })"
            @keydown.enter.ctrl.prevent="submit({ rating: 'down', reason, comment })"
          />
        </label>
        <label v-if="canReport" class="flex items-start gap-2">
          <Checkbox :model-value="reportPages" class="mt-0.5" @update:model-value="reportPages = !!$event" />
          <span class="text-xs">
            {{ t('assistant.feedback.reportPages', { n: pages.length }, pages.length) }}
            <span class="block text-muted-foreground">{{ t('assistant.feedback.reportPagesHint') }}</span>
          </span>
        </label>
        <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
        <div class="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" @click="open = false">{{ t('common.cancel') }}</Button>
          <Button size="sm" :disabled="busy || !canSend('down', reason)" @click="submit({ rating: 'down', reason, comment })">
            {{ t('assistant.feedback.send') }}
          </Button>
        </div>
      </PopoverContent>
    </Popover>

    <span v-if="thanked" class="ml-1 text-[11px] text-muted-foreground" role="status">
      {{ reported && reported.reported > 0 ? t('assistant.feedback.reported', { n: reported.reported }, reported.reported) : t('assistant.feedback.thanks') }}
      <template v-if="reported && reported.failed > 0"> {{ t('assistant.feedback.reportFailed', { n: reported.failed }, reported.failed) }}</template>
    </span>
    <span v-else-if="error && !open" class="ml-1 text-[11px] text-destructive" role="alert">{{ error }}</span>
  </div>
</template>

<style scoped>
.kn-thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 0.375rem;
  color: var(--muted-foreground);
  transition:
    background-color 120ms ease-out,
    color 120ms ease-out;
}
.kn-thumb:hover:not(:disabled) {
  background: var(--accent);
  color: var(--foreground);
}
.kn-thumb:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
.kn-thumb:disabled {
  opacity: 0.6;
}
.kn-thumb-active {
  color: var(--primary);
  background: color-mix(in oklab, var(--primary) 10%, transparent);
}
/* A standing down-vote is drawn in the destructive hue, so the row reads at a
   glance; the glyph only — the pill stays quiet like the confidence badge. */
.kn-thumb-down {
  color: var(--destructive);
  background: color-mix(in oklab, var(--destructive) 10%, transparent);
}
</style>
