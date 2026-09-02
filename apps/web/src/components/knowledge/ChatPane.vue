<script setup lang="ts">
// Chat half of the assistant pane — append-only intent log. The sidebar
// (DocumentsSidebar.vue) renders the live document state driven by the same
// thread's structured tool-call events; this component never parses chat
// text to figure out what changed.
import { computed, nextTick, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { CheckCircle2, FilePlus2, LayoutTemplate, Loader2, Search, Sparkles, SquarePen, XCircle } from 'lucide-vue-next'
import type { Component } from 'vue'
import type { AssistantChatAttachment, AssistantChatMode } from '@knowledge/contracts'
import { useAssistantStore } from '@/stores/assistant'
import { Button } from '@/components/ui/button'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import ChatComposer from '@/components/knowledge/ChatComposer.vue'
import GenerativeUiBlock from '@/components/knowledge/GenerativeUiBlock.vue'

const props = defineProps<{ documentId?: string }>()

const assistant = useAssistantStore()
const listEl = ref<HTMLElement | null>(null)
const composerEl = ref<InstanceType<typeof ChatComposer> | null>(null)

const toolIcon: Record<string, Component> = {
  search_knowledge: Search,
  read_document: Search,
  explore_document_graph: Search,
  render_component: LayoutTemplate,
  create_document: FilePlus2,
  propose_update: SquarePen,
}

function toolLabel(tool: string): string {
  return tool.replace(/_/g, ' ')
}

async function scrollToEnd() {
  await nextTick()
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' })
}

watch(() => assistant.activeThread?.id, () => void scrollToEnd())

async function handleSend(payload: {
  content: string
  mode: AssistantChatMode
  attachments: AssistantChatAttachment[]
  documentRefs: string[]
}) {
  await assistant.sendMessage(payload.content, props.documentId, {
    mode: payload.mode,
    attachments: payload.attachments,
    documentRefs: payload.documentRefs,
  })
  await scrollToEnd()
  void nextTick(() => composerEl.value?.focus())
}

async function startNewThread() {
  await assistant.newThread(props.documentId)
  void nextTick(() => composerEl.value?.focus())
}

const placeholder = computed(() =>
  props.documentId ? 'Ask about this page, or ask me to update or create pages…' : 'Ask anything, or ask me to create or update pages…',
)
</script>

<template>
  <section class="flex h-full min-h-0 flex-col">
    <header class="flex items-center gap-2 border-b px-4 py-3">
      <Sparkles class="size-4 shrink-0 text-primary" />
      <div class="min-w-0 flex-1 leading-tight">
        <p class="text-sm font-semibold">{{ assistant.activeThread?.title ?? 'Assistant' }}</p>
        <p class="text-[11px] text-muted-foreground">Writes always go through a new page or a merge request for review.</p>
      </div>
      <Button variant="ghost" size="sm" :disabled="assistant.sending" @click="startNewThread">
        <SquarePen class="size-3.5" />
        New chat
      </Button>
    </header>

    <div ref="listEl" class="flex-1 space-y-4 overflow-y-auto px-4 py-4">
      <p v-if="assistant.messages.length === 0" class="text-sm text-muted-foreground">
        Ask a question, request a summary, or ask me to draft a new page or update an existing one — updates open
        as a merge request for you to review before they go live.
      </p>

      <div v-for="m in assistant.messages" :key="m.id" :class="m.role === 'user' ? 'flex justify-end' : ''">
        <div
          v-if="m.role === 'user'"
          class="max-w-[85%] rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground"
        >
          {{ m.content }}
        </div>
        <div v-else class="max-w-[92%] space-y-2 rounded-lg rounded-bl-sm bg-muted/60 px-3 py-2 text-sm">
          <MarkdownView :markdown="m.content" />

          <GenerativeUiBlock v-for="(block, i) in m.uiBlocks" :key="i" :block="block" />

          <div v-if="m.toolCalls.length > 0" class="flex flex-wrap gap-1 border-t pt-2">
            <span
              v-for="(tc, i) in m.toolCalls"
              :key="i"
              :title="tc.arguments"
              :class="[
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                tc.ok ? 'text-muted-foreground' : 'border-destructive/40 text-destructive',
              ]"
            >
              <component :is="toolIcon[tc.tool] ?? Search" class="size-3" />
              {{ toolLabel(tc.tool) }}
              <CheckCircle2 v-if="tc.ok" class="size-3" />
              <XCircle v-else class="size-3" />
            </span>
          </div>

          <div v-if="m.sources.length > 0" class="flex flex-wrap gap-1 border-t pt-2">
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

      <div v-if="assistant.sending" class="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 class="size-3.5 animate-spin" />
        Thinking…
      </div>
      <p v-if="assistant.error" class="text-sm text-destructive">{{ assistant.error }}</p>
    </div>

    <ChatComposer
      ref="composerEl"
      :sending="assistant.sending"
      :placeholder="placeholder"
      :history="assistant.sentHistory"
      @send="handleSend"
    />
  </section>
</template>
