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
import { computed, nextTick, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { Check, Copy, Pencil, RotateCcw, Sparkles, X } from 'lucide-vue-next'
import type { AssistantMessageInfo, AssistantUiBlock } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import GenerativeUiBlock from '@/components/knowledge/GenerativeUiBlock.vue'
import AssistantPrompt from './AssistantPrompt.vue'
import { toolVocabulary } from './tool-vocabulary'

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
  /** False while a turn is in flight: rewinding under a running stream is not offered. */
  actionable?: boolean
}>()

const emit = defineEmits<{
  answer: [string]
  switchMode: [string]
  /** Rewind to just before this message. Confirmed by whoever owns the dialog. */
  reset: [AssistantMessageInfo]
  /** Rewind past this message and send it again, changed. */
  edit: [{ message: AssistantMessageInfo; content: string }]
}>()

const body = computed(() => props.streamingText ?? props.message.content)
const blocks = computed(() => props.streamingBlocks ?? props.message.uiBlocks)
const isUser = computed(() => props.message.role === 'user')

/**
 * Actions need a message the server knows about. The optimistic bubble carries
 * a `pending-…` id until the first frame replaces it, and rewinding to an id
 * the server never issued would 404.
 */
const canAct = computed(
  () => props.actionable !== false && props.streamingText === undefined && !props.message.id.startsWith('pending-'),
)

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
  <article v-if="isUser" class="kn-msg flex flex-col items-end pl-10">
    <!-- Editing in place: the bubble is replaced by a box the same width, so
         the turn does not move while it is being rewritten. -->
    <div v-if="editing" class="w-full max-w-[42rem] space-y-2">
      <textarea
        ref="editEl"
        v-model="draft"
        rows="3"
        class="w-full resize-y rounded-2xl border bg-background px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-ring focus:ring-3 focus:ring-ring/25"
        @keydown.esc.prevent="editing = false"
        @keydown.enter.meta.prevent="saveEdit"
        @keydown.enter.ctrl.prevent="saveEdit"
      />
      <div class="flex items-center justify-end gap-2">
        <p class="mr-auto text-[11px] text-muted-foreground">{{ t('chat.savingRestarts') }}</p>
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
        <button type="button" class="kn-msg-action" :aria-label="copied ? 'Copied' : 'Copy message'" @click="copy">
          <Check v-if="copied" class="size-3.5 text-emerald-500" />
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
      <MarkdownView v-if="body" :markdown="body" class="max-w-[72ch]" :streaming="streamingText !== undefined" />

      <GenerativeUiBlock v-for="(block, i) in blocks" :key="i" :block="block" />

      <AssistantPrompt
        v-if="message.prompt"
        :prompt="message.prompt"
        :active="promptActive === true"
        :answer="promptAnswer"
        class="max-w-[42rem]"
        @answer="emit('answer', $event)"
        @switch-mode="emit('switchMode', $event)"
      />

      <!-- What it used, and what it read: the receipts for the answer above. -->
      <footer
        v-if="message.toolCalls.length > 0 || message.sources.length > 0"
        class="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1"
      >
        <span
          v-for="(tc, i) in message.toolCalls"
          :key="`t-${i}`"
          :title="tc.arguments"
          class="inline-flex items-center gap-1 text-[11px]"
          :class="tc.ok ? 'text-muted-foreground' : 'text-destructive'"
        >
          <component :is="toolVocabulary(tc.tool).icon" class="size-3" />
          {{ t(toolVocabulary(tc.tool).done) }}
          <Check v-if="tc.ok" class="size-2.5" />
          <X v-else class="size-2.5" />
        </span>

        <div v-if="message.sources.length > 0" class="flex flex-wrap gap-1.5">
          <RouterLink
            v-for="s in message.sources"
            :key="s.documentId"
            :to="`/documents/${s.documentId}`"
            :title="s.snippet"
            class="max-w-[16rem] truncate rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:bg-primary/5 hover:text-primary"
          >
            {{ s.title }}
          </RouterLink>
        </div>
      </footer>

      <!-- No edit here: rewriting a reply would leave the transcript claiming
           the model said something it did not. Reset asks the question again. -->
      <div v-if="canAct" class="kn-msg-actions flex items-center gap-0.5">
        <button type="button" class="kn-msg-action" :aria-label="copied ? 'Copied' : 'Copy reply'" @click="copy">
          <Check v-if="copied" class="size-3.5 text-emerald-500" />
          <Copy v-else class="size-3.5" />
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
  </article>
</template>

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
.kn-msg-action:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
</style>
