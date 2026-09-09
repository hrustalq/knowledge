<script setup lang="ts">
// The conversation column: header, transcript, composer. It owns the turn —
// the rail beside it only ever switches which thread is open, and the
// documents pane only reads what the turn produced.
import { useI18n } from 'vue-i18n'
import { computed, nextTick, ref } from 'vue'
import { toast } from 'vue-sonner'
import { MoreHorizontal, PanelLeft, Pencil, Plus, Trash2 } from 'lucide-vue-next'
import type {
  AssistantChatAttachment,
  AssistantChatMode,
  AssistantMessageInfo,
  AssistantThreadSummary,
} from '@knowledge/contracts'
import { useAssistantStore } from '@/stores/assistant'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import ChatTranscript from './ChatTranscript.vue'
import ChatComposer from './ChatComposer.vue'
import { assistantMode } from './use-mode'
import { threadLabel } from './thread-label'

const { t } = useI18n()

const props = defineProps<{ documentId?: string }>()
// Rename/delete are confirmed by the page, which owns one set of dialogs
// shared with the rail's row menu.
const emit = defineEmits<{
  rename: [AssistantThreadSummary]
  delete: [AssistantThreadSummary]
  /** Small screens only: open the chat rail, which lives in a sheet there. */
  browse: []
}>()

const assistant = useAssistantStore()
const auth = useAuthStore()
const composerEl = ref<InstanceType<typeof ChatComposer> | null>(null)
const transcriptEl = ref<InstanceType<typeof ChatTranscript> | null>(null)

const title = computed(() => (assistant.activeThread ? threadLabel(assistant.activeThread) : t('chat.newChat')))

const placeholder = computed(() =>
  props.documentId
    ? 'Ask about this page, or ask for a change to it…'
    : t('chat.askPlaceholderWorkspace'),
)

async function handleSend(payload: {
  content: string
  mode: AssistantChatMode
  attachments: AssistantChatAttachment[]
  documentRefs: string[]
  skillIds: string[]
  agentKey: string
}) {
  transcriptEl.value?.scrollToEnd()
  await assistant.sendMessage(payload.content, props.documentId, {
    mode: payload.mode,
    attachments: payload.attachments,
    documentRefs: payload.documentRefs,
    skillIds: payload.skillIds,
    agentKey: payload.agentKey,
  })
  void nextTick(() => composerEl.value?.focus())
}

/** A filled-in form goes back as an ordinary turn — the composed text is the message. */
async function handlePromptAnswer(answer: string) {
  transcriptEl.value?.scrollToEnd()
  await assistant.sendMessage(answer, props.documentId, { mode: assistantMode.value })
  void nextTick(() => composerEl.value?.focus())
}

/**
 * Accepting a mode-switch prompt flips the chat to Agent and immediately
 * re-sends what the assistant said it would do. The user agreed to a specific
 * action, so making them retype it — or even press send again — would be
 * asking twice for one decision.
 */
async function handleModeSwitch(intent: string) {
  assistantMode.value = 'agent'
  transcriptEl.value?.scrollToEnd()
  await assistant.sendMessage(intent, props.documentId, { mode: 'agent' })
  void nextTick(() => composerEl.value?.focus())
}

/**
 * Rewinding is confirmed here rather than in the page, so the ChatPane mounted
 * in the editor's rail gets the same dialog without a second copy of it. It is
 * confirmed at all because the turns it drops do not come back.
 */
const resetting = ref<AssistantMessageInfo | null>(null)
const rewinding = ref(false)

/** How many turns the pending reset would take with it — the same cut the store makes. */
const resetCount = computed(() => {
  const target = resetting.value
  if (!target) return 0
  const at = assistant.messages.findIndex((m) => m.id === target.id)
  if (at < 0) return 1
  // A reply is re-asked, so the cut starts at the question above it, not at the reply.
  const from =
    target.role === 'user'
      ? at
      : assistant.messages
          .slice(0, at)
          .map((m) => m.role)
          .lastIndexOf('user')
  return from < 0 ? 1 : assistant.messages.length - from
})

async function confirmReset() {
  const target = resetting.value
  if (!target || rewinding.value) return
  rewinding.value = true
  try {
    const { restored } = await assistant.resetFrom(target, {
      documentId: props.documentId,
      mode: assistantMode.value,
    })
    resetting.value = null
    // A user message comes back to the composer: you rewound to just before
    // saying it, which is exactly where it was about to be typed.
    if (restored !== null) {
      void nextTick(() => composerEl.value?.setDraft(restored))
    } else {
      void nextTick(() => composerEl.value?.focus())
    }
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    rewinding.value = false
  }
}

async function handleEdit(payload: { message: AssistantMessageInfo; content: string }) {
  transcriptEl.value?.scrollToEnd()
  try {
    await assistant.editMessage(payload.message.id, payload.content, {
      documentId: props.documentId,
      mode: assistantMode.value,
    })
  } catch (e) {
    toast.error((e as Error).message)
  }
  void nextTick(() => composerEl.value?.focus())
}

async function startNewThread() {
  try {
    await assistant.newThread(props.documentId)
    void nextTick(() => composerEl.value?.focus())
  } catch (e) {
    toast.error((e as Error).message)
  }
}
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col">
    <header class="flex h-14 shrink-0 items-center gap-2 border-b px-4 lg:px-8">
      <!-- The rail is a sheet below lg, so the way back to the chat list has
           to live in the header there. -->
      <Button
        variant="ghost"
        size="icon-sm"
        class="-ml-1 shrink-0 lg:hidden"
        :aria-label="t('chat.browseChats')"
        @click="emit('browse')"
      >
        <PanelLeft class="size-4" />
      </Button>

      <div class="min-w-0 flex-1">
        <h1 class="truncate text-sm font-semibold">{{ title }}</h1>
        <p class="truncate text-[11px] text-muted-foreground">
          {{ t('chat.headerHint') }}
        </p>
      </div>

      <Button variant="ghost" size="sm" class="shrink-0" :disabled="assistant.sending" @click="startNewThread">
        <Plus class="size-3.5" />
        <span class="hidden sm:inline">{{ t('chat.newChat') }}</span>
      </Button>

      <DropdownMenu v-if="assistant.activeThread">
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-sm" class="shrink-0" :aria-label="t('chat.chatActions')">
            <MoreHorizontal class="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-40">
          <DropdownMenuItem @select="emit('rename', assistant.activeThread!)">
            <Pencil class="size-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" @select="emit('delete', assistant.activeThread!)">
            <Trash2 class="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>

    <ChatTranscript
      ref="transcriptEl"
      :messages="assistant.messages"
      :live="assistant.live"
      :loading="assistant.messagesLoading"
      :error="assistant.error"
      :thread-id="assistant.activeThread?.id ?? null"
      @answer="handlePromptAnswer"
      @switch-mode="handleModeSwitch"
      @reset="resetting = $event"
      @edit="handleEdit"
    />

    <ChatComposer
      ref="composerEl"
      :sending="assistant.sending"
      :placeholder="placeholder"
      :history="assistant.sentHistory"
      :can-edit="auth.canEdit"
      @send="handleSend"
      @stop="assistant.stopStreaming()"
    />
  </section>

  <Dialog :open="resetting !== null" @update:open="(open: boolean) => { if (!open) resetting = null }">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>
          {{ resetting?.role === 'user' ? 'Reset to before this message?' : 'Ask this question again?' }}
        </DialogTitle>
        <DialogDescription>
          <template v-if="resetting?.role === 'user'">
            {{ t('count.messages', { n: resetCount }, resetCount) }} {{ t('chat.willBeRemovedFrom') }}
            text comes back to the composer. This cannot be undone.
          </template>
          <template v-else>
            {{ t('count.messages', { n: resetCount }, resetCount) }} {{ t('chat.willBeRemovedAnd') }}
            asked again. This cannot be undone, and the new turn runs in {{ assistantMode }} mode without any
            files the original carried.
          </template>
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" @click="resetting = null">{{ t('common.cancel') }}</Button>
        <Button variant="destructive" :disabled="rewinding" @click="confirmReset">
          {{ rewinding ? 'Rewinding…' : resetting?.role === 'user' ? 'Reset' : 'Ask again' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
