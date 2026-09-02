<script setup lang="ts">
// Thread switcher for the assistant pane — left rail listing every thread in
// this workspace, most recently active first (already the API's sort order).
// Clicking (or arrow-key + Enter) opens it; content itself is fetched lazily
// by the store, this component only ever reads AssistantThreadSummary.
import { onMounted, ref } from 'vue'
import { onKeyStroke } from '@vueuse/core'
import { MessageSquarePlus, MessageSquareText } from 'lucide-vue-next'
import { useAssistantStore } from '@/stores/assistant'
import { Button } from '@/components/ui/button'

const props = defineProps<{ documentId?: string }>()

const assistant = useAssistantStore()
const listEl = ref<HTMLElement | null>(null)
/** Keyboard-focused row, independent of which thread is actually open — lets
 * ArrowUp/ArrowDown browse the list without opening a thread on every step. */
const focusedIndex = ref(0)

onMounted(() => {
  if (!assistant.threadsLoaded) void assistant.fetchThreads()
})

function relativeTime(iso: string): string {
  const diffMs = Date.parse(iso) - Date.now()
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const abs = Math.abs(diffMs)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (abs < minute) return rtf.format(0, 'second')
  if (abs < hour) return rtf.format(Math.round(diffMs / minute), 'minute')
  if (abs < day) return rtf.format(Math.round(diffMs / hour), 'hour')
  if (abs < 30 * day) return rtf.format(Math.round(diffMs / day), 'day')
  return new Date(iso).toLocaleDateString()
}

function open(threadId: string, index: number) {
  focusedIndex.value = index
  if (assistant.activeThread?.id !== threadId) void assistant.openThread(threadId)
}

async function startNewThread() {
  await assistant.newThread(props.documentId)
  focusedIndex.value = 0
}

// Scoped to this list only (target: listEl) so it never steals ArrowUp/Down
// from the composer's own history-recall handler elsewhere in the pane.
onKeyStroke(
  ['ArrowDown', 'ArrowUp'],
  (e) => {
    if (assistant.threads.length === 0) return
    e.preventDefault()
    const delta = e.key === 'ArrowDown' ? 1 : -1
    focusedIndex.value = Math.min(Math.max(focusedIndex.value + delta, 0), assistant.threads.length - 1)
  },
  { target: listEl },
)
onKeyStroke(
  'Enter',
  (e) => {
    const thread = assistant.threads[focusedIndex.value]
    if (!thread) return
    e.preventDefault()
    open(thread.id, focusedIndex.value)
  },
  { target: listEl },
)
</script>

<template>
  <aside class="flex h-full min-h-0 flex-col border-r">
    <header class="flex items-center justify-between gap-2 border-b px-3 py-3">
      <p class="text-sm font-semibold">Chats</p>
      <Button variant="ghost" size="icon-sm" aria-label="New chat" @click="startNewThread">
        <MessageSquarePlus class="size-4" />
      </Button>
    </header>

    <div ref="listEl" tabindex="0" class="flex-1 overflow-y-auto p-2 outline-none focus-visible:ring-1 focus-visible:ring-ring">
      <p v-if="assistant.threadsLoaded && assistant.threads.length === 0" class="px-2 py-1 text-xs text-muted-foreground">
        No chats yet — start one below.
      </p>
      <ul class="space-y-0.5">
        <li v-for="(t, i) in assistant.threads" :key="t.id">
          <button
            type="button"
            :class="[
              'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
              t.id === assistant.activeThread?.id ? 'bg-accent' : 'hover:bg-accent/60',
              i === focusedIndex ? 'ring-1 ring-ring' : '',
            ]"
            @click="open(t.id, i)"
          >
            <MessageSquareText class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{{ t.title ?? t.lastMessagePreview ?? 'New chat' }}</span>
              <span class="block truncate text-[11px] text-muted-foreground">{{ relativeTime(t.updatedAt) }}</span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  </aside>
</template>
