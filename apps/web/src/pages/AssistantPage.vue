<script setup lang="ts">
// Standalone chat pane — same chat + documents-sidebar layout used inline on
// document pages, but as its own workspace-level thread (no grounding doc).
import { onMounted } from 'vue'
import { useAssistantStore } from '@/stores/assistant'
import ChatPane from '@/components/knowledge/ChatPane.vue'
import DocumentsSidebar from '@/components/knowledge/DocumentsSidebar.vue'
import ThreadHistoryList from '@/components/knowledge/ThreadHistoryList.vue'

const assistant = useAssistantStore()

onMounted(() => {
  if (!assistant.activeThread) void assistant.openOrCreateThread()
})
</script>

<template>
  <div class="grid h-[calc(100vh-8.5rem)] grid-cols-1 overflow-hidden rounded-lg border md:grid-cols-[14rem_1fr_18rem]">
    <ThreadHistoryList class="hidden md:flex" />
    <ChatPane />
    <DocumentsSidebar class="hidden md:flex" />
  </div>
</template>
