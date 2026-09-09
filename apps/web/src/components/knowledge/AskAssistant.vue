<script setup lang="ts">
// Ask-AI chat about the current page — answers grounded in the page content
// and related pages (POST /v1/assistant/ask).
//
// Quick actions sit above the composer. Most are prompt shortcuts: the three
// questions people actually open this widget to ask, one click instead of one
// sentence. "Build glossary" is different — it is not a question at all. It
// runs the term extractor over this page (POST /v1/glossary/suggest) and puts
// the proposals in the transcript, where each one can be accepted into the
// project's vocabulary without leaving the page being read. Nothing the model
// proposes is saved until it is accepted here, which is the same rule the
// glossary page enforces.
import { useI18n } from 'vue-i18n'
import { computed, nextTick, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { BookMarked, Check, Send, Sparkles, X } from 'lucide-vue-next'
import type {
  AssistantAskResponse,
  AssistantAskSource,
  GlossaryTerm,
  GlossaryTermSuggestion,
  SuggestGlossaryTermsResponse,
} from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useGlossaryStore } from '@/stores/glossary'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { nativeEl } from '@/lib/utils'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'

const { t } = useI18n()

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: AssistantAskSource[]
  /** Glossary proposals rendered as an interactive card rather than as prose. */
  glossary?: GlossaryTermSuggestion[]
  /** Terms already accepted from this card, so the button can settle. */
  accepted?: string[]
  projectId?: string | null
}

const props = defineProps<{ documentId: string; title: string }>()

const auth = useAuthStore()
const glossaryStore = useGlossaryStore()

const open = ref(false)
const question = ref('')
const messages = ref<ChatMessage[]>([])
const busy = ref(false)
const error = ref<string | null>(null)
const listEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const setInputEl = (c: unknown) => {
  inputEl.value = nativeEl<HTMLInputElement>(c)
}

/**
 * Prompt shortcuts — offered while the conversation is still empty. Computed
 * rather than a const so switching language re-labels them; the prompt text is
 * translated too, so a Russian user asks in Russian.
 */
const PROMPTS = computed(() => [
  { label: t('assistant.promptSummarize'), prompt: t('assistant.promptSummarizeBody') },
  { label: t('assistant.promptMissing'), prompt: t('assistant.promptMissingBody') },
  { label: t('assistant.promptRelated'), prompt: t('assistant.promptRelatedBody') },
])

const canBuildGlossary = computed(() => auth.canEdit)

// A different page is a different conversation.
watch(
  () => props.documentId,
  () => {
    messages.value = []
    error.value = null
  },
)

function toggle() {
  open.value = !open.value
  if (open.value) void nextTick(() => inputEl.value?.focus())
}

async function scrollToEnd() {
  await nextTick()
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight })
}

function ask(prompt: string) {
  question.value = prompt
  void send()
}

async function send() {
  const q = question.value.trim()
  if (!q || busy.value) return
  question.value = ''
  const history = messages.value
    .filter((m) => !m.glossary)
    .slice(-8)
    .map(({ role, content }) => ({ role, content }))
  messages.value.push({ role: 'user', content: q })
  busy.value = true
  error.value = null
  void scrollToEnd()
  try {
    const res = await apiFetch<AssistantAskResponse>('/v1/assistant/ask', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: getWorkspaceId(),
        documentId: props.documentId,
        question: q,
        ...(history.length > 0 ? { history } : {}),
      }),
    })
    messages.value.push({
      role: 'assistant',
      content: res.answer,
      ...(res.enabled && res.sources.length > 0 ? { sources: res.sources } : {}),
    })
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
    void scrollToEnd()
    void nextTick(() => inputEl.value?.focus())
  }
}

/** Quick action: extract vocabulary from the page currently being read. */
async function buildGlossary() {
  if (busy.value) return
  messages.value.push({ role: 'user', content: t('assistant.buildGlossaryPrompt') })
  busy.value = true
  error.value = null
  void scrollToEnd()
  try {
    const res = await apiFetch<SuggestGlossaryTermsResponse>('/v1/glossary/suggest', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: getWorkspaceId(), documentId: props.documentId }),
    })
    messages.value.push({
      role: 'assistant',
      content: !res.enabled
        ? t('assistant.disabledForWorkspace')
        : res.suggestions.length === 0
          ? t('assistant.glossaryNothingToAdd')
          : t('assistant.termsWorthDefining', { terms: t('count.terms', { n: res.suggestions.length }, res.suggestions.length) }),
      glossary: res.suggestions,
      accepted: [],
      projectId: res.projectId,
    })
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
    void scrollToEnd()
  }
}

async function acceptTerm(message: ChatMessage, suggestion: GlossaryTermSuggestion) {
  if (!message.projectId) return
  try {
    await apiFetch<GlossaryTerm>('/v1/glossary', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: getWorkspaceId(),
        projectId: message.projectId,
        term: suggestion.term,
        definition: suggestion.definition,
        aliases: suggestion.aliases,
        documentId: props.documentId,
        source: 'ai',
      }),
    })
    message.accepted = [...(message.accepted ?? []), suggestion.term]
    // The page under this widget links glossary terms as it renders, so the
    // roster has to refresh for the word just defined to light up behind it.
    await glossaryStore.refresh()
  } catch (e) {
    error.value = (e as Error).message
  }
}
</script>

<template>
  <!-- Launcher -->
  <Button v-if="!open" class="fixed bottom-5 right-5 z-40 shadow-lg" @click="toggle">
    <Sparkles class="size-4" />
    {{ t('assistant.askAi') }}
  </Button>

  <!-- Chat window -->
  <section
    v-else
    :aria-label="t('assistant.askAiAbout')"
    class="fixed bottom-5 right-5 z-40 flex h-[32rem] max-h-[calc(100vh-6rem)] w-96 max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl"
  >
    <header class="flex items-center gap-2 border-b px-3 py-2.5">
      <Sparkles class="size-4 shrink-0 text-primary" />
      <div class="min-w-0 flex-1 leading-tight">
        <p class="text-sm font-semibold">{{ t('assistant.askAi') }}</p>
        <p class="truncate text-[11px] text-muted-foreground">{{ t('assistant.aboutAndRelated', { title }) }}</p>
      </div>
      <Button variant="ghost" size="icon-xs" :aria-label="t('assistant.closeChat')" @click="open = false">
        <X class="size-3.5" />
      </Button>
    </header>

    <div ref="listEl" class="flex-1 space-y-3 overflow-y-auto p-3">
      <p v-if="messages.length === 0" class="text-sm text-muted-foreground">
        {{ t('assistant.askAnything') }}
      </p>
      <div v-for="(m, i) in messages" :key="i" :class="m.role === 'user' ? 'flex justify-end' : ''">
        <div
          v-if="m.role === 'user'"
          class="max-w-[85%] rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground"
        >
          {{ m.content }}
        </div>
        <div v-else class="max-w-[95%] space-y-2 rounded-lg rounded-bl-sm bg-muted/60 px-3 py-2 text-sm">
          <MarkdownView :markdown="m.content" />

          <!-- Glossary proposals: one accept button each, never a bulk import -->
          <ul v-if="m.glossary?.length" class="space-y-1.5 border-t pt-2">
            <li v-for="s in m.glossary" :key="s.term" class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <p class="flex flex-wrap items-center gap-1.5 font-medium">
                  {{ s.term }}
                  <Badge variant="secondary" class="font-normal">{{ s.occurrences }}×</Badge>
                  <Badge v-if="s.existingTermId" variant="outline">{{ t('assistant.defined') }}</Badge>
                </p>
                <p class="text-muted-foreground text-xs">{{ s.definition }}</p>
              </div>
              <span
                v-if="m.accepted?.includes(s.term)"
                class="flex shrink-0 items-center gap-1 pt-0.5 text-xs text-emerald-600"
              >
                <Check class="size-3.5" /> added
              </span>
              <Button
                v-else-if="canBuildGlossary && !s.existingTermId"
                size="xs"
                variant="outline"
                class="shrink-0"
                @click="acceptTerm(m, s)"
              >
                Add
              </Button>
            </li>
          </ul>

          <div v-if="m.sources?.length" class="flex flex-wrap gap-1 border-t pt-2">
            <RouterLink
              v-for="s in m.sources"
              :key="s.documentId"
              :to="`/documents/${s.documentId}`"
              :title="s.snippet"
              class="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            >
              {{ s.title }}
            </RouterLink>
          </div>
        </div>
      </div>
      <p v-if="busy" class="text-sm text-muted-foreground">{{ t('assistant.thinking') }}</p>
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
    </div>

    <!-- Quick actions: prompt shortcuts while the thread is empty, and the
         glossary builder, which stays available because it is a tool rather
         than an opening line. -->
    <div class="flex flex-wrap gap-1 border-t px-2.5 pt-2">
      <button
        v-for="p in PROMPTS"
        v-show="messages.length === 0"
        :key="p.label"
        type="button"
        :disabled="busy"
        class="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
        @click="ask(p.prompt)"
      >
        {{ p.label }}
      </button>
      <button
        v-if="canBuildGlossary"
        type="button"
        :disabled="busy"
        class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
        :title="t('assistant.buildGlossaryHint')"
        @click="buildGlossary"
      >
        <BookMarked class="size-3" /> {{ t('assistant.buildGlossary') }}
      </button>
    </div>

    <form class="flex items-center gap-2 p-2.5" @submit.prevent="send">
      <Input
        :ref="setInputEl"
        v-model="question"
        :disabled="busy"
        :placeholder="t('assistant.askPlaceholder')"
        class="min-w-0 flex-1"
      />
      <Button type="submit" size="icon-sm" :disabled="busy || !question.trim()" :aria-label="t('assistant.send')">
        <Send class="size-4" />
      </Button>
    </form>
  </section>
</template>
