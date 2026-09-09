<script setup lang="ts">
// The right pane: every page this thread touched, materialized from each
// message's structured `sources` — never parsed out of the chat text. Read,
// created, or drafted-as-a-merge-request all land here.
//
// It fills in mid-turn as well as after it, so the moment the assistant is
// finding things is the moment you can see what it found.
import { useI18n } from 'vue-i18n'
import { FileText } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { useAssistantStore } from '@/stores/assistant'

const { t } = useI18n()

const assistant = useAssistantStore()
</script>

<template>
  <aside class="flex h-full w-72 shrink-0 flex-col border-l bg-background">
    <!-- h-14 to land on the same divider line as the rail and the chat header. -->
    <header class="flex h-14 shrink-0 flex-col justify-center border-b px-4">
      <h2 class="text-sm font-semibold">{{ t('chat.pagesInChat') }}</h2>
      <p class="truncate text-[11px] text-muted-foreground">
        {{ t('chat.sourcesHint') }}
      </p>
    </header>

    <div class="quiet-scroll min-h-0 flex-1 overflow-y-auto p-2">
      <p v-if="assistant.documentsTouched.length === 0" class="px-2 py-1 text-xs leading-relaxed text-muted-foreground">
        {{ t('chat.noSourcesYet') }}
      </p>
      <ul v-else class="space-y-0.5">
        <li v-for="doc in assistant.documentsTouched" :key="doc.documentId">
          <RouterLink
            :to="`/documents/${doc.documentId}`"
            :title="doc.snippet"
            class="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
          >
            <FileText class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 leading-snug">{{ doc.title }}</span>
          </RouterLink>
        </li>
      </ul>
    </div>
  </aside>
</template>
