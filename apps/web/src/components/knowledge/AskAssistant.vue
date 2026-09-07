<script setup lang="ts">
// Ask-AI chat about the current page — answers grounded in the page content
// and related pages (POST /v1/assistant/ask).
import { nextTick, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { Send, Sparkles, X } from 'lucide-vue-next'
import type { AssistantAskResponse, AssistantAskSource } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { nativeEl } from '@/lib/utils'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: AssistantAskSource[]
}

const props = defineProps<{ documentId: string; title: string }>()

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

async function send() {
  const q = question.value.trim()
  if (!q || busy.value) return
  question.value = ''
  const history = messages.value.slice(-8).map(({ role, content }) => ({ role, content }))
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
</script>

<template>
  <!-- Launcher -->
  <Button v-if="!open" class="fixed bottom-5 right-5 z-40 shadow-lg" @click="toggle">
    <Sparkles class="size-4" />
    Ask AI
  </Button>

  <!-- Chat window -->
  <section
    v-else
    aria-label="Ask AI about this page"
    class="fixed bottom-5 right-5 z-40 flex h-[32rem] max-h-[calc(100vh-6rem)] w-96 max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl"
  >
    <header class="flex items-center gap-2 border-b px-3 py-2.5">
      <Sparkles class="size-4 shrink-0 text-primary" />
      <div class="min-w-0 flex-1 leading-tight">
        <p class="text-sm font-semibold">Ask AI</p>
        <p class="truncate text-[11px] text-muted-foreground">about “{{ title }}” and related pages</p>
      </div>
      <Button variant="ghost" size="icon-xs" aria-label="Close chat" @click="open = false">
        <X class="size-3.5" />
      </Button>
    </header>

    <div ref="listEl" class="flex-1 space-y-3 overflow-y-auto p-3">
      <p v-if="messages.length === 0" class="text-sm text-muted-foreground">
        Ask anything about this page — answers are grounded in its content and related pages from the
        knowledge graph.
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
      <p v-if="busy" class="text-sm text-muted-foreground">Thinking…</p>
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
    </div>

    <form class="flex items-center gap-2 border-t p-2.5" @submit.prevent="send">
      <Input
        :ref="setInputEl"
        v-model="question"
        :disabled="busy"
        placeholder="Ask about this page…"
        class="min-w-0 flex-1"
      />
      <Button type="submit" size="icon-sm" :disabled="busy || !question.trim()" aria-label="Send">
        <Send class="size-4" />
      </Button>
    </form>
  </section>
</template>
