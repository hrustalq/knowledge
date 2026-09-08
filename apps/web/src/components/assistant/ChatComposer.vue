<script setup lang="ts">
// The input dock: one bordered surface holding the context chips, the field,
// and the controls, rather than three loose rows stacked under a divider.
// Everything you attach to a turn lives inside the same box you type into, so
// what is about to be sent is one object on screen instead of three.
//
// Widgets are all @vueuse/core (already a dependency): file dialog + drop
// zone for attachments, SpeechRecognition for dictation, key handlers for
// shell-style history recall.
import { computed, nextTick, ref, watch } from 'vue'
import { onKeyStroke, useDropZone, useFileDialog, useSpeechRecognition, useTextareaAutosize } from '@vueuse/core'
import { CornerDownLeft, FileText, Mic, MicOff, Paperclip, SendHorizontal, Square, Upload, X } from 'lucide-vue-next'
import type { AssistantChatAttachment, AssistantChatMode } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { nativeEl } from '@/lib/utils'
import DocumentPickerWidget, { type AppliedDocRef } from '@/components/knowledge/DocumentPickerWidget.vue'
import SkillPicker from './SkillPicker.vue'
import ModelPicker from './ModelPicker.vue'
import { assistantMode } from './use-mode'

const props = defineProps<{
  sending: boolean
  placeholder: string
  /** Oldest-first log of this thread's own sent messages, for ArrowUp/Down recall. */
  history: string[]
  /** Editors can run Agent mode; everyone else is read-only and the toggle says so. */
  canEdit: boolean
}>()

const emit = defineEmits<{
  (
    e: 'send',
    payload: {
      content: string
      mode: AssistantChatMode
      attachments: AssistantChatAttachment[]
      documentRefs: string[]
      skillIds: string[]
    },
  ): void
  (e: 'stop'): void
}>()

defineExpose({ focus: () => inputEl.value?.focus() })

const attachments = ref<AssistantChatAttachment[]>([])
const appliedDocs = ref<AppliedDocRef[]>([])
// Skills explicitly applied to the next turn; trigger matches apply on their own.
const skillIds = ref<string[]>([])
const dropZoneEl = ref<HTMLElement | null>(null)

// Autosize: `rows=1` with a max height only ever produced a one-line box that
// scrolled internally, which hides the start of anything longer than a
// sentence. The field now grows with the draft up to a ceiling.
const { textarea: inputEl, input: draft } = useTextareaAutosize({ styleProp: 'height' })
// useTextareaAutosize measures the element itself, so unwrap it from the
// Textarea component instance rather than binding the instance.
const setInputEl = (c: unknown) => {
  inputEl.value = nativeEl<HTMLTextAreaElement>(c) ?? undefined
}

// Shared with the transcript's mode-switch prompt, which can flip it too —
// see use-mode.ts. Still persisted under the same key it always was.
const mode = assistantMode
// A viewer cannot use the write tools, so parking the chat in Agent mode only
// produces refusals from the API. Fall back to Ask rather than let it lie.
watch(
  () => props.canEdit,
  (can) => {
    if (!can) mode.value = 'ask'
  },
  { immediate: true },
)

// --- Attachments: file picker + drag-drop onto the composer, both funnel
// into the same handler. Content is read client-side and sent as ephemeral
// per-turn context (never persisted into thread history) — see
// AssistantService.prepareTurn's <attachment> block on the API side.
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
const { isOverDropZone } = useDropZone(dropZoneEl, { onDrop: (files) => void addFiles(files), multiple: true })

// --- Voice: native SpeechRecognition via VueUse, inserted at the caret
// rather than appended, so dictation slots into a partially-typed message.
// Hidden entirely when unsupported (Firefox etc.) instead of failing on click.
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
  // Enter sends; Shift+Enter and the platform modifier both open a new line,
  // because muscle memory for "submit this box" differs between the two and
  // losing a half-written question to the wrong one is unforgivable.
  if (e.key !== 'Enter') return
  if (e.shiftKey || e.metaKey || e.ctrlKey) return
  e.preventDefault()
  send()
}

const canSend = computed(
  () => !props.sending && (draft.value.trim().length > 0 || attachments.value.length > 0),
)
const contextCount = computed(() => attachments.value.length + appliedDocs.value.length)

function send() {
  const content = draft.value.trim()
  if (!content || props.sending) return
  emit('send', {
    content,
    mode: mode.value,
    attachments: attachments.value,
    documentRefs: appliedDocs.value.map((d) => d.documentId),
    skillIds: skillIds.value,
  })
  draft.value = ''
  attachments.value = []
  appliedDocs.value = []
  skillIds.value = []
  recallIndex.value = null
  void nextTick(() => inputEl.value?.focus())
}
</script>

<template>
  <!-- shrink-0: the dock is the one thing that must never be compressed or
       pushed out of view by a long transcript — the transcript scrolls, this
       stays. -->
  <div class="shrink-0 border-t bg-background px-4 pt-3 pb-4 lg:px-8">
    <div class="mx-auto w-full max-w-4xl">
      <div
        ref="dropZoneEl"
        class="relative rounded-xl border bg-card shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25"
        :class="isOverDropZone ? 'border-primary ring-3 ring-primary/25' : ''"
      >
        <!-- Drop target feedback covers the dock so the whole box is the target. -->
        <div
          v-if="isOverDropZone"
          class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-xl bg-primary/10 text-sm font-medium text-primary backdrop-blur-[1px]"
        >
          <Upload class="size-4" />
          Drop text files to attach them to this message
        </div>

        <!-- Context chips: what this turn carries besides the words. -->
        <div v-if="contextCount > 0" class="flex flex-wrap gap-1.5 px-3 pt-3">
          <span
            v-for="(d, i) in appliedDocs"
            :key="`doc-${d.documentId}`"
            class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 py-0.5 pr-1 pl-2 text-[11px] text-primary"
          >
            <FileText class="size-3 shrink-0" />
            <span class="truncate">{{ d.title }}</span>
            <button
              type="button"
              :aria-label="`Remove ${d.title}`"
              class="rounded-full p-0.5 transition-colors hover:bg-primary/15"
              @click="removeAppliedDoc(i)"
            >
              <X class="size-3" />
            </button>
          </span>
          <span
            v-for="(a, i) in attachments"
            :key="`${a.filename}-${i}`"
            class="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-muted py-0.5 pr-1 pl-2 text-[11px] text-muted-foreground"
          >
            <Paperclip class="size-3 shrink-0" />
            <span class="truncate">{{ a.filename }}</span>
            <button
              type="button"
              :aria-label="`Remove ${a.filename}`"
              class="rounded-full p-0.5 transition-colors hover:bg-foreground/10 hover:text-foreground"
              @click="removeAttachment(i)"
            >
              <X class="size-3" />
            </button>
          </span>
        </div>

        <form @submit.prevent="send">
          <label class="sr-only" for="chat-input">Message the assistant</label>
          <Textarea
            id="chat-input"
            :ref="setInputEl"
            v-model="draft"
            :placeholder="placeholder"
            rows="1"
            class="max-h-56 min-h-0 w-full resize-none rounded-none border-0 bg-transparent px-3.5 py-3 text-sm leading-relaxed shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
            @keydown="onKeydown"
          />

          <div class="flex items-center gap-1 px-2 pb-2">
            <TooltipProvider :delay-duration="400">
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    :disabled="attachments.length >= MAX_ATTACHMENTS"
                    aria-label="Attach a text file"
                    @click="openFileDialog()"
                  >
                    <Paperclip class="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {{
                    attachments.length >= MAX_ATTACHMENTS
                      ? `${MAX_ATTACHMENTS} files is the limit for one message`
                      : 'Attach a text file to this message'
                  }}
                </TooltipContent>
              </Tooltip>

              <DocumentPickerWidget v-model="appliedDocs" />

              <SkillPicker v-model="skillIds" />

              <ModelPicker />

              <Tooltip v-if="voiceSupported">
                <TooltipTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    :class="isListening ? 'text-primary' : ''"
                    :aria-label="isListening ? 'Stop dictation' : 'Dictate a message'"
                    @click="toggleVoice()"
                  >
                    <Mic v-if="!isListening" class="size-4" />
                    <MicOff v-else class="size-4 animate-pulse" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{{ isListening ? 'Stop dictation' : 'Dictate' }}</TooltipContent>
              </Tooltip>

              <!-- Ask / Agent: the one control that changes what the assistant
                   is allowed to do, so it names the consequence, not itself. -->
              <div
                class="ml-1 inline-flex rounded-full border bg-muted/60 p-0.5 text-[11px]"
                role="radiogroup"
                aria-label="Assistant mode"
              >
                <Tooltip>
                  <TooltipTrigger as-child>
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="mode === 'ask'"
                      class="rounded-full px-2.5 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                      :class="mode === 'ask' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                      @click="mode = 'ask'"
                    >
                      Ask
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Reads the workspace. Never changes anything.</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="mode === 'agent'"
                      :disabled="!canEdit"
                      class="rounded-full px-2.5 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-50"
                      :class="mode === 'agent' ? 'bg-primary font-medium text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                      @click="mode = 'agent'"
                    >
                      Agent
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {{
                      canEdit
                        ? 'Can also write: new pages go live, edits open a merge request.'
                        : 'Needs the editor role in this workspace.'
                    }}
                  </TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>

            <span class="ml-auto hidden items-center gap-1 pr-1 text-[11px] text-muted-foreground sm:inline-flex">
              <CornerDownLeft class="size-3" />
              to send
            </span>

            <!-- Send becomes Stop mid-turn: same position, so interrupting is
                 where your hand already is instead of a second control. -->
            <Button
              v-if="sending"
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="Stop generating"
              @click="emit('stop')"
            >
              <Square class="size-3 fill-current" />
            </Button>
            <Button v-else type="submit" size="icon-sm" :disabled="!canSend" aria-label="Send message">
              <SendHorizontal class="size-4" />
            </Button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
