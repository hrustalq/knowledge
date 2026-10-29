<script setup lang="ts">
// One turn in the transcript.
//
// The two roles are shaped differently on purpose. A user turn is a short
// utterance, so it gets the familiar right-aligned bubble that makes
// authorship obvious at a glance. An assistant turn is a small document —
// headings, code, tables, an embedded graph — so it is set as prose in the
// page with a marker in the left gutter instead. Wrapping that in a tinted
// bubble would fight every block inside it, and a knowledge base's answers
// deserve to look like the knowledge base.
import { useI18n } from 'vue-i18n'
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { BookmarkCheck, BookmarkPlus, Check, CircleHelp, Copy, CornerDownRight, Pencil, RotateCcw, Sparkles, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import type { AssistantFlowAnswer, AssistantMessageInfo, AssistantUiBlock, CaptureResult } from '@knowledge/contracts'
import { assistantSourceHref, assistantSourceKey, isChatSource, isPageSource, isWebSource } from '@knowledge/contracts'
import { Button } from '@/shared/ui/button'
import { MarkdownView } from '@/entities/document'
import GenerativeUiBlock from '@/modules/documents/components/GenerativeUiBlock.vue'
import AssistantPrompt from './AssistantPrompt.vue'
import AnswerConfidence from './AnswerConfidence.vue'
import AnswerFeedback from './AnswerFeedback.vue'
import SourceChip from './SourceChip.vue'
import { toolVocabulary } from '../model/tool-vocabulary'
import {
  citeOfEvent,
  decorateCitations,
  highlightCite,
  markUnsupported,
  sourceByCite,
  sourceHref,
  unsupportedMarkers,
} from '@/modules/assistant/model/citations'
import { api } from '@/shared/api/client'
import { errorMessage } from '@/shared/api/errors'
import { answerText, type AnswerTurn, type FlowStep } from '@/modules/assistant/model/flow-steps'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()

const props = defineProps<{
  message: AssistantMessageInfo
  /** Streaming text for the in-flight reply; the message body is used when absent. */
  streamingText?: string
  /** Blocks resolved mid-turn, before the persisted message exists. */
  streamingBlocks?: AssistantUiBlock[]
  /** True only for the newest message with nothing in flight — an older prompt is a record, not a question. */
  promptActive?: boolean
  /** The user turn that answered this message's prompt, when it has one. */
  promptAnswer?: string
  /** Set when the prompt is a step of a question flow (#425). */
  flowStep?: FlowStep
  /** Set when this user turn answers a flow step: the question it answered. */
  answerTurn?: AnswerTurn
  /** The reply to a flow's last answer — what the flow did, not an answer to rate. */
  concludesFlow?: boolean
  /** For a reply: the question it answered, carried into a report filed from its thumbs (docs/features/38). */
  question?: string
  /** False while a turn is in flight: rewinding under a running stream is not offered. */
  actionable?: boolean
}>()

const emit = defineEmits<{
  answer: [text: string, answer?: AssistantFlowAnswer]
  switchMode: [string]
  /** Rewind to just before this message. Confirmed by whoever owns the dialog. */
  reset: [AssistantMessageInfo]
  /** Rewind past this message and send it again, changed. */
  edit: [{ message: AssistantMessageInfo; content: string }]
}>()

const body = computed(() => props.streamingText ?? props.message.content)
const blocks = computed(() => props.streamingBlocks ?? props.message.uiBlocks)
const isUser = computed(() => props.message.role === 'user')

// Sentence-level citations (docs/features/38). The rendered answer carries
// `[S2]` markers; after each render they become superscript buttons, and the
// chip and the markers that name one source light up together — from either
// end. Clicking a marker opens the page at the cited section.
const router = useRouter()
const knownCites = computed(() => new Set(props.message.sources.map((s) => s.cite).filter((c): c is string => !!c)))
const activeCite = ref<string | null>(null)
let answerRoot: HTMLElement | null = null

// Sentences the decision model found unsupported (#530). The marks can land
// after the text — the check runs once the answer is shown — so they are
// re-applied when they change, not only on render.
const unsupported = computed(() =>
  props.streamingText === undefined ? unsupportedMarkers(props.message.content, props.message.citations) : new Set<number>(),
)
const unsupportedSentences = computed(() => (props.message.citations ?? []).filter((c) => c.support === 'unsupported').length)
watch(unsupported, (markers) => markUnsupported(answerRoot, markers, t('assistant.unsupportedCite')))

function onRendered(root: HTMLElement) {
  answerRoot = root
  decorateCitations(root, knownCites.value)
  markUnsupported(root, unsupported.value, t('assistant.unsupportedCite'))
  if (root.dataset.knCitesBound) return
  root.dataset.knCitesBound = '1'
  const enter = (e: Event) => {
    const label = citeOfEvent(e)
    if (label) activeCite.value = label
  }
  const leave = (e: Event) => {
    if (citeOfEvent(e)) activeCite.value = null
  }
  root.addEventListener('mouseover', enter)
  root.addEventListener('mouseout', leave)
  root.addEventListener('focusin', enter)
  root.addEventListener('focusout', leave)
  root.addEventListener('click', (e) => {
    const label = citeOfEvent(e)
    if (!label) return
    const source = sourceByCite(props.message.sources, label)
    if (!source) return
    e.preventDefault()
    if (isWebSource(source) || (isChatSource(source) && source.url)) window.open(assistantSourceHref(source, ''), '_blank', 'noopener,noreferrer')
    else void router.push(isPageSource(source) ? sourceHref(source) : assistantSourceHref(source, ''))
  })
}

watch(activeCite, (label) => highlightCite(answerRoot, label))

/**
 * Actions need a message the server knows about. The optimistic bubble carries
 * a `pending-…` id until the first frame replaces it, and rewinding to an id
 * the server never issued would 404.
 */
const canAct = computed(
  () => props.actionable !== false && props.streamingText === undefined && !props.message.id.startsWith('pending-'),
)

/** A turn that only asks (#425): the form is the whole point of it. */
const asks = computed(() => props.message.role === 'assistant' && props.message.prompt?.kind === 'form')

/**
 * A question-and-answer turn: one that asks, or the one reporting what the
 * flow did. Neither is an answer to rate, copy or score, so thumbs, confidence
 * and the reply actions stay off — they would ask the reader to judge a
 * question, or grade "no sources" on a turn that never searched for any.
 */
const qa = computed(() => asks.value || props.concludesFlow === true)

/** A flow answer in words, read from the question's options rather than parsed out of the text. */
const answerWords = computed(() => {
  const a = props.message.answer
  if (!a) return ''
  return answerText(props.answerTurn?.prompt?.fields[0], a.value, {
    skipped: t('chat.flowSkipped'),
    none: t('chat.flowNone'),
  })
})

/**
 * A finished tool call in words — on a turn that asked, a flow tool asked
 * rather than did, and a failed one says so instead of claiming it did.
 */
function toolDone(tool: string, ok: boolean): string {
  const v = toolVocabulary(tool)
  if (!ok && v.failed) return t(v.failed)
  return t(asks.value && v.asked ? v.asked : v.done)
}

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

async function copy() {
  try {
    await navigator.clipboard.writeText(props.message.content)
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = false), 1500)
  } catch {
    // Denied permission or an insecure origin: the button simply does nothing
    // rather than throwing a toast at someone who can still select the text.
  }
}

// "Save to knowledge base" (issue #73): the reply goes back as an answer
// capture — its question, the pages it cited, a merge request someone reviews.
// Offered only when the reply cites a page of this base: an answer is written
// back with the pages it stands on (the API refuses one without), and a web
// citation is not a page anyone here can review. Editors only — it opens a
// merge request in the reader's name.
const auth = useAuthStore()
const canSave = computed(() => auth.canEdit && props.message.sources.some(isPageSource))
const saving = ref(false)
const saved = ref<CaptureResult | null>(null)

async function saveToBase() {
  if (saving.value || saved.value) return
  saving.value = true
  try {
    const result = await api.post('/v1/assistant/messages/{id}/capture', {
      path: { id: props.message.id },
      body: {},
    })
    saved.value = result
    if (result.state === 'duplicate' && result.targetDocumentId) {
      const page = result.targetDocumentId
      toast.info(t('assistant.saveToKb.duplicate'), {
        action: { label: t('assistant.saveToKb.openPage'), onClick: () => void router.push(`/documents/${page}`) },
      })
    } else if (result.mergeRequestId) {
      const mr = result.mergeRequestId
      toast.success(result.outcome === 'amend-page' ? t('assistant.saveToKb.amended') : t('assistant.saveToKb.proposed'), {
        action: { label: t('assistant.saveToKb.openMergeRequest'), onClick: () => void router.push(`/merge-requests/${mr}`) },
      })
    } else {
      toast.success(t('assistant.saveToKb.staged'))
    }
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}

// Editing happens in place — the bubble becomes its own textarea. Sending the
// text back to the composer instead would move it away from the turn it is
// about, and the transcript is where the mistake is visible.
const editing = ref(false)
const draft = ref('')
const editEl = ref<HTMLTextAreaElement | null>(null)

function startEdit() {
  draft.value = props.message.content
  editing.value = true
  void nextTick(() => {
    editEl.value?.focus()
    editEl.value?.setSelectionRange(draft.value.length, draft.value.length)
  })
}

function saveEdit() {
  const content = draft.value.trim()
  if (!content || content === props.message.content) {
    editing.value = false
    return
  }
  editing.value = false
  emit('edit', { message: props.message, content })
}
</script>

<template>
  <!-- An answer to a flow step: the user's turn, but an answer, not a chat
       message — drawn in the question card's material, the value in words.
       No copy, edit or rewind: "Change" on the step is how it is re-answered. -->
  <article v-if="isUser && message.answer" class="kn-msg flex justify-end pl-10">
    <p
      class="flex max-w-[42rem] items-start gap-2 rounded-xl border border-primary/25 bg-primary/[0.04] px-3 py-1.5 text-ui"
      :class="answerTurn?.superseded ? 'text-muted-foreground' : ''"
    >
      <CornerDownRight class="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
      <span class="min-w-0 break-words" :class="answerTurn?.superseded ? 'line-through' : ''">
        <span v-if="answerTurn?.prompt" class="sr-only">{{ answerTurn.prompt.question }}</span>
        {{ answerWords }}
      </span>
    </p>
  </article>

  <article v-else-if="isUser" class="kn-msg flex flex-col items-end pl-10">
    <!-- Editing in place: the bubble is replaced by a box the same width, so
         the turn does not move while it is being rewritten. -->
    <div v-if="editing" class="w-full max-w-[42rem] space-y-2">
      <textarea
        ref="editEl"
        v-model="draft"
        rows="3"
        :aria-label="t('chat.editMessage')"
        class="w-full resize-y rounded-2xl border bg-background px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-ring focus:ring-3 focus:ring-ring"
        @keydown.esc.prevent="editing = false"
        @keydown.enter.meta.prevent="saveEdit"
        @keydown.enter.ctrl.prevent="saveEdit"
      />
      <div class="flex items-center justify-end gap-2">
        <p class="mr-auto text-caption text-muted-foreground">{{ t('chat.savingRestarts') }}</p>
        <Button variant="ghost" size="sm" @click="editing = false">{{ t('common.cancel') }}</Button>
        <Button size="sm" :disabled="!draft.trim()" @click="saveEdit">{{ t('common.save') }}</Button>
      </div>
    </div>

    <template v-else>
      <div
        class="max-w-[42rem] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground shadow-sm shadow-primary/20"
      >
        {{ message.content }}
      </div>

      <div v-if="canAct" class="kn-msg-actions mt-1 flex items-center gap-0.5">
        <button type="button" class="kn-msg-action" :aria-label="copied ? t('common.copied') : t('chat.copyMessage')" @click="copy">
          <Check v-if="copied" class="size-3.5 text-panel-tip" />
          <Copy v-else class="size-3.5" />
        </button>
        <button type="button" class="kn-msg-action" :aria-label="t('chat.editMessage')" :title="t('chat.edit')" @click="startEdit">
          <Pencil class="size-3.5" />
        </button>
        <button
          type="button"
          class="kn-msg-action"
          :aria-label="t('chat.resetConversationTo')"
          :title="t('chat.resetToHere')"
          @click="emit('reset', message)"
        >
          <RotateCcw class="size-3.5" />
        </button>
      </div>
    </template>
  </article>

  <article v-else class="kn-msg flex gap-3">
    <span
      class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15"
      aria-hidden="true"
    >
      <Sparkles class="size-3.5" />
    </span>

    <div class="min-w-0 flex-1 space-y-3">
      <MarkdownView
        v-if="body"
        :markdown="body"
        class="max-w-[72ch]"
        :streaming="streamingText !== undefined"
        @rendered="onRendered"
      />

      <GenerativeUiBlock v-for="(block, i) in blocks" :key="i" :block="block" />

      <AssistantPrompt
        v-if="message.prompt"
        :prompt="message.prompt"
        :active="promptActive === true"
        :answer="promptAnswer"
        :flow-step="flowStep"
        class="max-w-[42rem]"
        @answer="(text, answer) => emit('answer', text, answer)"
        @switch-mode="emit('switchMode', $event)"
      />

      <!-- What it used, and what it read: the receipts for the answer above. -->
      <footer
        v-if="message.toolCalls.length > 0 || message.sources.length > 0 || ((message.confidence || unsupportedSentences > 0) && !qa)"
        class="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1"
      >
        <!-- First, because it is the one receipt that is about the answer as a
             whole; everything after it is about one step or one page. -->
        <AnswerConfidence v-if="message.confidence && !qa" :confidence="message.confidence" />
        <span
          v-if="unsupportedSentences > 0 && !qa"
          class="inline-flex items-center gap-1 text-caption text-panel-caution-ink"
          :title="t('assistant.unsupportedCite')"
        >
          <CircleHelp class="size-3" aria-hidden="true" />
          {{ t('assistant.unsupportedSentences', { n: unsupportedSentences }, unsupportedSentences) }}
        </span>
        <span
          v-for="(tc, i) in message.toolCalls"
          :key="`t-${i}`"
          :title="tc.arguments"
          class="inline-flex items-center gap-1 text-caption"
          :class="tc.ok ? 'text-muted-foreground' : 'text-destructive'"
        >
          <component :is="toolVocabulary(tc.tool).icon" class="size-3" />
          {{ toolDone(tc.tool, tc.ok) }}
          <Check v-if="tc.ok" class="size-2.5" />
          <X v-else class="size-2.5" />
        </span>

        <div v-if="message.sources.length > 0" class="flex flex-wrap gap-1.5">
          <!-- Keyed by identity, not by document id: a web citation has none,
               and two of them would share one `undefined` key. -->
          <SourceChip
            v-for="s in message.sources"
            :key="assistantSourceKey(s)"
            :source="s"
            :active="!!s.cite && activeCite === s.cite"
            @hover="activeCite = $event ? s.cite ?? null : null"
          />
        </div>
      </footer>

      <!-- The thumbs stay visible (docs/features/38): a vote is the one thing
           the reader is asked for, so it does not hide behind a hover the way
           copy and reset do. No edit here: rewriting a reply would leave the
           transcript claiming the model said something it did not. Reset asks
           the question again. -->
      <div v-if="canAct && !qa" class="flex items-center gap-2">
        <AnswerFeedback
          :target="{ kind: 'message', messageId: message.id }"
          :initial="message.feedback"
          :sources="message.sources"
          :query="question"
        />
        <div class="kn-msg-actions flex items-center gap-0.5">
          <button type="button" class="kn-msg-action" :aria-label="copied ? t('common.copied') : t('chat.copyReply')" @click="copy">
            <Check v-if="copied" class="size-3.5 text-panel-tip" />
            <Copy v-else class="size-3.5" />
          </button>
          <button
            v-if="canSave"
            type="button"
            class="kn-msg-action"
            :aria-label="saved ? t('assistant.saveToKb.done') : t('assistant.saveToKb.label')"
            :title="saved ? t('assistant.saveToKb.done') : t('assistant.saveToKb.label')"
            :disabled="saving || !!saved"
            :aria-busy="saving"
            @click="saveToBase"
          >
            <BookmarkCheck v-if="saved" class="size-3.5 text-primary" />
            <BookmarkPlus v-else class="size-3.5" :class="saving && 'animate-pulse'" />
          </button>
          <button
            type="button"
            class="kn-msg-action"
            :aria-label="t('chat.discardReply')"
            :title="t('chat.askAgain')"
            @click="emit('reset', message)"
          >
            <RotateCcw class="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  </article>
</template>

<style src="@/assets/styles/citations.css"></style>

<style scoped>
/*
 * Revealed on hover, but only where hovering is a thing. Tailwind's
 * `group-hover:` would leave these unreachable on a touch screen — and the
 * chat is used on one — so this follows `.kn-comment-actions` (styles/
 * editor.css) and lets them stand permanently visible without a pointer.
 */
.kn-msg-actions {
  transition: opacity 120ms ease-out;
}
@media (hover: hover) {
  .kn-msg-actions {
    opacity: 0;
  }
  .kn-msg:hover .kn-msg-actions,
  .kn-msg-actions:focus-within {
    opacity: 1;
  }
}

.kn-msg-action {
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
.kn-msg-action:hover {
  background: var(--accent);
  color: var(--foreground);
}
.kn-msg-action:disabled {
  cursor: default;
}
.kn-msg-action:disabled:hover {
  background: transparent;
}
.kn-msg-action:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
</style>
