<script setup lang="ts">
// The editor's assistant (docs/features/34): the assistant page's chat, pinned
// to the page being written and able to write into it.
//
// Same composer, same modes, same threads — ChatPane, mounted `embedded` — so
// nothing the assistant page can do is missing here and nothing here can drift
// from it. What the panel adds is the editor's side: the draft goes with every
// turn (stores/assistant's draft bridge, wired by EditorPage), and whatever
// the assistant writes into the page is summarized in the dock above the
// composer, where the author accepts or discards it without hunting.
//
// It takes the navigation rail's place on the left edge (AppShell yields the
// rail while this is open): the page stays the widest thing on screen, and the
// conversation sits where navigation was — beside what it is changing.
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref, watch } from 'vue'
import { History, PanelLeftClose, Sparkles, SquarePen } from 'lucide-vue-next'
import { useAssistantStore } from '@/stores/assistant'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import ChatPane from '@/components/assistant/ChatPane.vue'
import ChatRail from '@/components/assistant/ChatRail.vue'
import ThreadDialogs from '@/components/assistant/ThreadDialogs.vue'
import { threadLabel } from '@/components/assistant/thread-label'

const { t } = useI18n()

const props = defineProps<{
  documentId: string | null
  /** Suggestions written into the page and not yet decided on. */
  pending: { count: number; streaming: boolean }
  /** The draft has no body yet — the starters change from "improve" to "draft". */
  blank: boolean
  /** The platform's modifier, for the shortcut hints. */
  mod: string
}>()

const emit = defineEmits<{
  close: []
  accept: []
  discard: []
  reveal: []
}>()

const assistant = useAssistantStore()
const dialogs = ref<InstanceType<typeof ThreadDialogs> | null>(null)
const pane = ref<InstanceType<typeof ChatPane> | null>(null)

/** The chat, or the list of chats — one column, so browsing replaces rather than squeezes. */
const view = ref<'chat' | 'threads'>('chat')

const subtitle = computed(() => (assistant.activeThread ? threadLabel(assistant.activeThread) : t('editorAi.newChat')))

onMounted(() => void assistant.openForDocument(props.documentId))
// A page saved for the first time gets its id mid-session; the chat it was
// having is the chat about it, so nothing reopens.
watch(
  () => props.documentId,
  (id, was) => {
    if (was !== null) void assistant.openForDocument(id)
  },
)

function newChat() {
  assistant.startBlank()
  view.value = 'chat'
  pane.value?.focus()
}

const starters = computed(() =>
  props.blank
    ? [t('editorAi.starter.outline'), t('editorAi.starter.draftFromTitle'), t('editorAi.starter.template')]
    : [t('editorAi.starter.tighten'), t('editorAi.starter.gaps'), t('editorAi.starter.summary')],
)

defineExpose({ focus: () => pane.value?.focus() })
</script>

<template>
  <aside class="kn-ai-panel" :aria-label="t('editorAi.title')">
    <TooltipProvider :delay-duration="400">
      <header class="kn-ai-panel-head">
        <span class="kn-ai-glyph" aria-hidden="true"><Sparkles class="size-3.5" /></span>
        <div class="min-w-0 flex-1">
          <h2 class="text-sm leading-tight font-semibold">{{ t('editorAi.title') }}</h2>
          <p class="truncate text-[11px] leading-tight text-muted-foreground">
            {{ view === 'threads' ? t('editorAi.allChats') : subtitle }}
          </p>
        </div>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="t('editorAi.history')"
              :aria-pressed="view === 'threads'"
              :class="view === 'threads' ? 'bg-accent text-accent-foreground' : ''"
              @click="view = view === 'threads' ? 'chat' : 'threads'"
            >
              <History class="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('editorAi.history') }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="t('editorAi.newChat')"
              :disabled="assistant.sending"
              @click="newChat"
            >
              <SquarePen class="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('editorAi.newChat') }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon-sm" :aria-label="t('editorAi.close')" @click="emit('close')">
              <PanelLeftClose class="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {{ t('editorAi.close') }} <kbd class="kn-ai-kbd">{{ mod }}J</kbd>
          </TooltipContent>
        </Tooltip>
      </header>
    </TooltipProvider>

    <ChatRail
      v-if="view === 'threads'"
      :document-id="documentId ?? undefined"
      class="kn-ai-threads"
      @rename="dialogs?.rename($event)"
      @delete="dialogs?.remove($event)"
      @opened="view = 'chat'"
    />

    <ChatPane v-else ref="pane" embedded :document-id="documentId ?? undefined">
      <template #empty="{ prefill }">
        <div class="kn-ai-empty">
          <h3 class="font-display text-base font-semibold tracking-tight">
            {{ blank ? t('editorAi.emptyTitleBlank') : t('editorAi.emptyTitle') }}
          </h3>
          <p class="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{{ t('editorAi.emptyBody') }}</p>
          <ul class="mt-4 space-y-1" :aria-label="t('editorAi.startersLabel')">
            <li v-for="starter in starters" :key="starter">
              <button type="button" class="kn-ai-starter" @click="prefill(starter)">{{ starter }}</button>
            </li>
          </ul>
        </div>
      </template>

      <template #dock>
        <Transition name="kn-ai-dock">
          <div v-if="pending.count > 0" class="kn-ai-dock" :data-streaming="pending.streaming || undefined">
            <span class="kn-ai-dock-dot" aria-hidden="true" />
            <button type="button" class="kn-ai-dock-label" @click="emit('reveal')">
              <span aria-live="polite">
                {{
                  pending.streaming
                    ? t('editorAi.writing')
                    : t('editorAi.pending', { n: pending.count }, pending.count)
                }}
              </span>
            </button>
            <template v-if="!pending.streaming">
              <Button variant="ghost" size="xs" @click="emit('discard')">{{ t('editorAi.discardAll') }}</Button>
              <Button size="xs" class="kn-ai-accept-all" @click="emit('accept')">
                {{ t('editorAi.acceptAll') }}
                <kbd class="kn-ai-kbd">{{ mod }}↵</kbd>
              </Button>
            </template>
          </div>
        </Transition>
      </template>
    </ChatPane>

    <ThreadDialogs ref="dialogs" />
  </aside>
</template>
