<script setup lang="ts">
// Composer widgets row (upload / voice / mode) plus keyboard affordances,
// built entirely on @vueuse/core — already a project dependency, so no new
// package was added for this. Kept as its own component so ChatPane.vue
// stays a plain message list/log.
import { computed, nextTick, ref, watch } from 'vue'
import { onKeyStroke, useDropZone, useFileDialog, useSpeechRecognition } from '@vueuse/core'
import { FileText, Mic, MicOff, Paperclip, SendHorizontal, X } from 'lucide-vue-next'
import type { AssistantChatAttachment, AssistantChatMode } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import DocumentPickerWidget, { type AppliedDocRef } from '@/components/knowledge/DocumentPickerWidget.vue'

const props = defineProps<{
  sending: boolean
  placeholder: string
  /** Oldest-first log of this thread's own sent messages, for ArrowUp/Down recall. */
  history: string[]
}>()

const emit = defineEmits<{
  (
    e: 'send',
    payload: { content: string; mode: AssistantChatMode; attachments: AssistantChatAttachment[]; documentRefs: string[] },
  ): void
}>()

defineExpose({ focus: () => inputEl.value?.focus() })

const MODE_KEY = 'kn_assistant_mode'
const draft = ref('')
const attachments = ref<AssistantChatAttachment[]>([])
const appliedDocs = ref<AppliedDocRef[]>([])
const inputEl = ref<HTMLTextAreaElement | null>(null)
const dropZoneEl = ref<HTMLElement | null>(null)

const mode = ref<AssistantChatMode>('ask')
try {
  const stored = localStorage.getItem(MODE_KEY)
  if (stored === 'ask' || stored === 'agent') mode.value = stored
} catch {
  /* storage unavailable (private mode) — default to 'ask' */
}
watch(mode, (m) => {
  try {
    localStorage.setItem(MODE_KEY, m)
  } catch {
    /* ignore */
  }
})

// --- Upload widget: file picker + drag-drop onto the composer, both funnel
// into the same handler. Content is read client-side and sent as ephemeral
// per-turn context (never persisted into thread history) — see
// AssistantService.postMessage's <attachment> block on the API side.
const MAX_ATTACHMENTS = 3
const MAX_ATTACHMENT_CHARS = 20_000

async function addFiles(files: File[] | FileList | null) {
  if (!files) return
  for (const file of Array.from(files)) {
    if (attachments.value.length >= MAX_ATTACHMENTS) break
    try {
      const content = (await file.text()).slice(0, MAX_ATTACHMENT_CHARS)
      attachments.value.push({ filename: file.name.slice(0, 200), content })
    } catch {
      // Unreadable (e.g. binary) — skip silently rather than failing the whole drop.
    }
  }
}

function removeAttachment(index: number) {
  attachments.value.splice(index, 1)
}

function removeAppliedDoc(index: number) {
  appliedDocs.value.splice(index, 1)
}

const { open: openFileDialog, onChange: onFileDialogChange } = useFileDialog({
  multiple: true,
  accept: '.md,.txt,.json,.csv,.log,.yml,.yaml,text/*',
})
onFileDialogChange((files) => void addFiles(files))
useDropZone(dropZoneEl, { onDrop: (files) => void addFiles(files), multiple: true })

// --- Voice widget: native SpeechRecognition via VueUse, inserted at the
// composer's caret rather than appended, so dictation slots into a
// partially-typed message. Toggle disabled entirely when unsupported
// (Firefox etc.) instead of throwing at runtime.
const {
  isSupported: voiceSupported,
  isListening,
  result: voiceResult,
  toggle: toggleVoice,
} = useSpeechRecognition({ continuous: false, interimResults: false })

watch(voiceResult, (text) => {
  if (!text) return
  insertAtCaret(text)
})

function insertAtCaret(text: string) {
  const el = inputEl.value
  if (!el) {
    draft.value = draft.value ? `${draft.value} ${text}` : text
    return
  }
  const start = el.selectionStart ?? draft.value.length
  const end = el.selectionEnd ?? draft.value.length
  draft.value = draft.value.slice(0, start) + text + draft.value.slice(end)
  void nextTick(() => {
    el.focus()
    el.selectionStart = el.selectionEnd = start + text.length
  })
}

// --- ArrowUp/Down history recall (shell-style): only kicks in while the
// caret sits at the very start of an empty-ish draft, so it never fights
// with normal multi-line cursor movement once you've started typing.
const recallIndex = ref<number | null>(null)
const recallDraft = ref('')

function canRecall(): boolean {
  const el = inputEl.value
  if (!el) return draft.value.length === 0
  return el.selectionStart === el.selectionEnd && el.selectionStart === 0 && el.selectionEnd === draft.value.length
}

onKeyStroke(
  'ArrowUp',
  (e) => {
    if (props.history.length === 0 || !canRecall()) return
    e.preventDefault()
    if (recallIndex.value === null) recallDraft.value = draft.value
    const next = recallIndex.value === null ? props.history.length - 1 : Math.max(recallIndex.value - 1, 0)
    recallIndex.value = next
    draft.value = props.history[next] ?? ''
  },
  { target: inputEl },
)
onKeyStroke(
  'ArrowDown',
  (e) => {
    if (recallIndex.value === null) return
    e.preventDefault()
    const next = recallIndex.value + 1
    if (next >= props.history.length) {
      recallIndex.value = null
      draft.value = recallDraft.value
    } else {
      recallIndex.value = next
      draft.value = props.history[next] ?? ''
    }
  },
  { target: inputEl },
)
onKeyStroke('Escape', () => {
  recallIndex.value = null
  draft.value = ''
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

const canSend = computed(() => !props.sending && (draft.value.trim().length > 0 || attachments.value.length > 0))

function send() {
  const content = draft.value.trim()
  if (!content || props.sending) return
  emit('send', {
    content,
    mode: mode.value,
    attachments: attachments.value,
    documentRefs: appliedDocs.value.map((d) => d.documentId),
  })
  draft.value = ''
  attachments.value = []
  appliedDocs.value = []
  recallIndex.value = null
  void nextTick(() => inputEl.value?.focus())
}
</script>

<template>
  <div ref="dropZoneEl" class="border-t">
    <div v-if="attachments.length > 0 || appliedDocs.length > 0" class="flex flex-wrap gap-1.5 px-3 pt-2">
      <span
        v-for="(d, i) in appliedDocs"
        :key="`doc-${d.documentId}`"
        class="inline-flex items-center gap-1 rounded-full border bg-primary/10 px-2 py-0.5 text-[11px]"
      >
        <FileText class="size-3" />
        {{ d.title }}
        <button type="button" aria-label="Remove applied document" class="text-muted-foreground hover:text-foreground" @click="removeAppliedDoc(i)">
          <X class="size-3" />
        </button>
      </span>
      <span
        v-for="(a, i) in attachments"
        :key="`${a.filename}-${i}`"
        class="inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2 py-0.5 text-[11px]"
      >
        <Paperclip class="size-3" />
        {{ a.filename }}
        <button type="button" aria-label="Remove attachment" class="text-muted-foreground hover:text-foreground" @click="removeAttachment(i)">
          <X class="size-3" />
        </button>
      </span>
    </div>

    <form class="flex items-end gap-2 p-3" @submit.prevent="send">
      <textarea
        ref="inputEl"
        v-model="draft"
        :disabled="sending"
        :placeholder="placeholder"
        rows="1"
        class="min-h-9 max-h-32 min-w-0 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-ring"
        @keydown="onKeydown"
      />
      <Button type="submit" size="icon-sm" :disabled="!canSend" aria-label="Send">
        <SendHorizontal class="size-4" />
      </Button>
    </form>

    <div class="flex items-center justify-between gap-2 px-3 pb-2.5">
      <div class="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" type="button" aria-label="Attach a file" @click="openFileDialog()">
          <Paperclip class="size-4" />
        </Button>
        <DocumentPickerWidget v-model="appliedDocs" />
        <Button
          v-if="voiceSupported"
          variant="ghost"
          size="icon-sm"
          type="button"
          :class="isListening ? 'text-primary' : ''"
          :aria-label="isListening ? 'Stop dictation' : 'Start dictation'"
          @click="toggleVoice()"
        >
          <Mic v-if="!isListening" class="size-4" />
          <MicOff v-else class="size-4 animate-pulse" />
        </Button>
      </div>

      <div class="inline-flex rounded-full border p-0.5 text-[11px]">
        <button
          type="button"
          :class="['rounded-full px-2.5 py-1 transition-colors', mode === 'ask' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground']"
          @click="mode = 'ask'"
        >
          Ask
        </button>
        <button
          type="button"
          :class="['rounded-full px-2.5 py-1 transition-colors', mode === 'agent' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground']"
          @click="mode = 'agent'"
        >
          Agent
        </button>
      </div>
    </div>
  </div>
</template>
