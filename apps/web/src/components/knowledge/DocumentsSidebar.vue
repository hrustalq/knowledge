<script setup lang="ts">
// Sidebar half of the assistant pane — live materialized "documents touched"
// list for the active thread, derived from each message's structured
// `sources` (never parsed out of the chat text). Includes anything read,
// created, or proposed as an update during the conversation.
import { FileText } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { useAssistantStore } from '@/stores/assistant'

const assistant = useAssistantStore()
</script>

<template>
  <aside class="flex h-full min-h-0 flex-col border-l">
    <header class="border-b px-4 py-3">
      <p class="text-sm font-semibold">Documents in this thread</p>
      <p class="text-[11px] text-muted-foreground">Pages the assistant read, created, or drafted updates for.</p>
    </header>

    <div class="flex-1 overflow-y-auto p-3">
      <p v-if="assistant.documentsTouched.length === 0" class="px-1 text-sm text-muted-foreground">
        Nothing yet — ask a question or request a page and it'll show up here.
      </p>
      <ul v-else class="space-y-1">
        <li v-for="doc in assistant.documentsTouched" :key="doc.documentId">
          <RouterLink
            :to="`/documents/${doc.documentId}`"
            :title="doc.snippet"
            class="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
          >
            <FileText class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 truncate">{{ doc.title }}</span>
          </RouterLink>
        </li>
      </ul>
    </div>
  </aside>
</template>
