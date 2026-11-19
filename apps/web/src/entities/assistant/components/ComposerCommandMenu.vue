<script setup lang="ts">
// The composer's `/` menu (#1249). It reads the draft and offers the commands
// this person may run here, then the values of one that takes a value; it never
// changes state itself. The composer applies what it emits, through the same
// refs and store actions the pickers use, so a command and a picker cannot
// disagree. Names and descriptions come from the catalogue the bots' menu reads.
//
// The lists share their queries with the pickers (same options, same cache), so
// mounting this costs no request the toolbar has not already made.
import { useI18n } from 'vue-i18n'
import { computed, nextTick, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import {
  CHAT_COMMANDS,
  isLocale,
  isPageSource,
  type ChatCommandName,
  type ListAiAgentChoicesResponse,
  type ListAiModelChoicesResponse,
  type ListAiSkillsResponse,
} from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { useDocumentsStore } from '@/stores/documents'
import { useAssistantStore } from '../model/assistant.store'
import { MODE_AGENT_KEYS } from '../model/use-mode'
import { ARG_COMMANDS, COMPOSER_COMMANDS, slashState } from '../model/slash-commands'

export interface CommandRun {
  command: ChatCommandName
  /** The picked value: a model id (null = workspace default), agent key, skill id, page id or reply id. */
  value?: string | null
  /** A page's title, for its chip. */
  label?: string
}

interface Option {
  key: string
  label: string
  hint?: string | null
  /** Replaces the draft instead of running: `/model ` opens the model list. */
  complete?: string
  run?: CommandRun
}

const props = defineProps<{ draft: string; canEdit: boolean; sending: boolean }>()
const emit = defineEmits<{ run: [CommandRun]; complete: [text: string] }>()

const { t, locale } = useI18n()
const assistant = useAssistantStore()
const documents = useDocumentsStore()

const workspaceId = getWorkspaceId()
const modelsQuery = useQuery(apiQueryOptions('/v1/ai/models/choices', { query: { workspaceId } }))
const agentsQuery = useQuery(apiQueryOptions('/v1/ai/agents/choices', { query: { workspaceId } }))
const skillsQuery = useQuery(apiQueryOptions('/v1/ai/skills', { query: { workspaceId } }))

const modelData = computed(() => modelsQuery.data.value as ListAiModelChoicesResponse | undefined)
const models = computed(() => modelData.value?.models ?? [])
const customAgents = computed(() =>
  ((agentsQuery.data.value as ListAiAgentChoicesResponse | undefined)?.agents ?? []).filter((a) => !MODE_AGENT_KEYS.has(a.key)),
)
const skills = computed(() => ((skillsQuery.data.value as ListAiSkillsResponse | undefined)?.skills ?? []).filter((s) => s.enabled))
const latestReply = computed(() => assistant.messages.filter((m) => m.role === 'assistant').at(-1) ?? null)

/** Each command is offered exactly when its picker or button would be. */
const offered = computed(() =>
  COMPOSER_COMMANDS.filter((command) => {
    switch (command) {
      case 'new':
        return !props.sending
      case 'agent':
        return props.canEdit
      case 'model':
        return models.value.length > 0 && !!assistant.activeThread
      case 'agent-key':
        return customAgents.value.length > 0
      case 'skill':
        return skills.value.length > 0
      case 'capture': {
        const reply = latestReply.value
        return props.canEdit && !!reply && reply.sources.some(isPageSource) && !assistant.capturedReplies[reply.id]
      }
      default:
        return true
    }
  }),
)

// Esc closes the menu for this draft; typing opens it again.
const dismissed = ref(false)
watch(
  () => props.draft,
  () => {
    dismissed.value = false
  },
)
const state = computed(() => (dismissed.value ? null : slashState(props.draft, offered.value)))

const describe = (command: ChatCommandName) => CHAT_COMMANDS[command].description[isLocale(locale.value) ? locale.value : 'en']

// The page list loads when it is asked for, as the document picker's does.
watch(
  () => state.value?.step === 'arg' && state.value.command === 'page',
  (pages) => {
    if (pages && !documents.loaded) void documents.fetchList()
  },
)

const MAX_PAGES = 8

const options = computed<Option[]>(() => {
  const s = state.value
  if (!s) return []
  if (s.step === 'command') {
    return s.matches.map((command) => ({
      key: command,
      label: `/${command}`,
      hint: describe(command),
      // /help lists everything: the menu is the help.
      ...(ARG_COMMANDS.has(command)
        ? { complete: `/${command} ` }
        : command === 'help'
          ? { complete: '/' }
          : { run: { command, ...(command === 'capture' ? { value: latestReply.value?.id ?? null } : {}) } }),
    }))
  }
  const { command, query } = s
  const all: Option[] =
    command === 'model'
      ? [
          { key: 'default', label: t('chat.workspaceDefault'), hint: modelData.value?.defaultModel, run: { command, value: null } },
          ...models.value.map((m) => ({ key: m.id, label: m.code, hint: m.providerName, run: { command, value: m.id } })),
        ]
      : command === 'agent-key'
        ? [
            { key: 'default', label: t('chat.agent.default'), hint: t('chat.agent.defaultHint'), run: { command, value: '' } },
            { key: 'auto', label: t('chat.agent.auto'), hint: t('chat.agent.autoHint'), run: { command, value: 'auto' } },
            ...customAgents.value.map((a) => ({ key: a.key, label: a.name, hint: a.description, run: { command, value: a.key } })),
          ]
        : command === 'skill'
          ? skills.value.map((sk) => ({ key: sk.id, label: sk.name, hint: sk.description, run: { command, value: sk.id } }))
          : documents.items.map((d) => ({ key: d.documentId, label: d.title, run: { command, value: d.documentId, label: d.title } }))
  const needle = query.trim().toLowerCase()
  const matching = all.filter((o) => o.label.toLowerCase().includes(needle))
  return command === 'page' ? matching.slice(0, MAX_PAGES) : matching
})

const loading = computed(() => state.value?.step === 'arg' && state.value.command === 'page' && !documents.loaded)

const active = ref(0)
watch(options, () => {
  active.value = 0
})
watch(active, (i) => {
  void nextTick(() => document.getElementById(`chat-slash-${i}`)?.scrollIntoView({ block: 'nearest' }))
})

function choose(i: number) {
  const option = options.value[i]
  if (!option) return
  if (option.complete !== undefined) emit('complete', option.complete)
  else if (option.run) emit('run', option.run)
}

/** The composer's keydown, first: true when the menu took the key. */
function handleKey(e: KeyboardEvent): boolean {
  if (!state.value) return false
  const n = options.value.length
  switch (e.key) {
    case 'ArrowDown':
      if (n) active.value = (active.value + 1) % n
      break
    case 'ArrowUp':
      if (n) active.value = (active.value - 1 + n) % n
      break
    case 'Enter':
      if (e.shiftKey || e.metaKey || e.ctrlKey) return false
      choose(active.value)
      break
    case 'Tab':
      if (e.shiftKey) return false
      choose(active.value)
      break
    case 'Escape':
      // Not the composer's window-wide Escape, which clears the draft.
      e.stopPropagation()
      dismissed.value = true
      break
    default:
      return false
  }
  e.preventDefault()
  return true
}

const open = computed(() => state.value !== null)
const activeId = computed(() => (open.value && options.value.length ? `chat-slash-${active.value}` : undefined))

defineExpose({ open, activeId, handleKey })
</script>

<template>
  <div
    v-if="state"
    class="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md"
  >
    <p class="truncate border-b px-3 py-1.5 text-caption text-muted-foreground">
      <template v-if="state.step === 'arg'">
        <span class="font-mono text-foreground">/{{ state.command }}</span> · {{ describe(state.command) }}
      </template>
      <template v-else>{{ t('chat.slash.label') }}</template>
    </p>
    <ul id="chat-slash-menu" role="listbox" :aria-label="t('chat.slash.label')" class="max-h-64 overflow-y-auto p-1">
      <!-- mousedown.prevent: a tap keeps the caret in the textarea. -->
      <li
        v-for="(o, i) in options"
        :id="`chat-slash-${i}`"
        :key="o.key"
        role="option"
        :aria-selected="i === active"
        class="flex min-h-9 cursor-pointer items-baseline gap-3 rounded-sm px-2 py-1.5 text-sm"
        :class="i === active ? 'bg-accent text-accent-foreground' : ''"
        @mousedown.prevent
        @mousemove="active = i"
        @click="choose(i)"
      >
        <span class="min-w-0 shrink-0 truncate" :class="state.step === 'command' ? 'font-mono text-xs' : 'max-w-[60%]'">{{ o.label }}</span>
        <span v-if="o.hint" class="min-w-0 truncate text-caption text-muted-foreground">{{ o.hint }}</span>
      </li>
      <li v-if="!options.length" class="px-2 py-1.5 text-sm text-muted-foreground">
        {{ loading ? t('chat.slash.loading') : t('chat.slash.noMatch') }}
      </li>
    </ul>
    <p class="hidden border-t px-3 py-1 text-caption text-muted-foreground @lg:block">{{ t('chat.slash.keys') }}</p>
  </div>
</template>
