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
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { Check, Sparkles, X } from 'lucide-vue-next'
import type { AssistantMessageInfo, AssistantUiBlock } from '@knowledge/contracts'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import GenerativeUiBlock from '@/components/knowledge/GenerativeUiBlock.vue'
import AssistantPrompt from './AssistantPrompt.vue'
import { toolVocabulary } from './tool-vocabulary'

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
}>()

const emit = defineEmits<{ answer: [string]; switchMode: [string] }>()

const body = computed(() => props.streamingText ?? props.message.content)
const blocks = computed(() => props.streamingBlocks ?? props.message.uiBlocks)
const isUser = computed(() => props.message.role === 'user')
</script>

<template>
  <article v-if="isUser" class="flex justify-end pl-10">
    <div
      class="max-w-[42rem] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground shadow-sm shadow-primary/20"
    >
      {{ message.content }}
    </div>
  </article>

  <article v-else class="flex gap-3">
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
          {{ toolVocabulary(tc.tool).done }}
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
    </div>
  </article>
</template>
