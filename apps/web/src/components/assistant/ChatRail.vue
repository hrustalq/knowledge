<script setup lang="ts">
// The chat roster — the same rail construction the projects settings page
// uses: filter at the top, a virtualized list in the middle, the create
// action pinned to the foot behind its own divider.
//
// Rows are a fixed two lines, so this uses VueUse's fixed-height virtualizer
// (as the project rail does) rather than the measuring one the transcript
// needs. Search runs server-side over titles *and* message bodies, because
// almost no one renames a chat and a title-only filter would find nothing.
import { computed, ref, watch } from 'vue'
import { refDebounced, useInfiniteScroll, useVirtualList } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { MoreHorizontal, Pencil, Plus, Search, Trash2, X } from 'lucide-vue-next'
import type { AssistantThreadSummary } from '@knowledge/contracts'
import { relativeTime } from '@/lib/api'
import { useAssistantStore } from '@/stores/assistant'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { threadLabel } from './thread-label'

const props = defineProps<{ documentId?: string }>()

const assistant = useAssistantStore()

/** Row height must match the markup below — the virtualizer positions by it. */
const ROW_HEIGHT = 52

const query = ref(assistant.search)
const debouncedQuery = refDebounced(query, 250)
watch(debouncedQuery, (q) => void assistant.setSearch(q))

const threads = computed<AssistantThreadSummary[]>(() => assistant.threads)
const { list, containerProps, wrapperProps } = useVirtualList(threads, {
  itemHeight: ROW_HEIGHT,
  overscan: 8,
})

useInfiniteScroll(containerProps.ref, async () => { await assistant.loadMoreThreads() }, {
  distance: ROW_HEIGHT * 4,
  canLoadMore: () => assistant.nextCursor !== null && !assistant.threadsLoading,
})

async function startNewThread() {
  try {
    await assistant.newThread(props.documentId)
    emit('opened')
  } catch (e) {
    toast.error((e as Error).message)
  }
}

// Rename and delete are confirmed in dialogs the page owns, because the chat
// header offers the same two actions on the open thread — one implementation,
// one set of wording, whichever control you reached for. `opened` lets the
// small-screen sheet close itself once a chat has been picked.
const emit = defineEmits<{
  rename: [AssistantThreadSummary]
  delete: [AssistantThreadSummary]
  opened: []
}>()

function open(threadId: string) {
  void assistant.openThread(threadId)
  emit('opened')
}
</script>

<template>
  <div class="flex h-full w-64 shrink-0 flex-col border-r bg-background">
    <!-- h-14 so this divider lands on the same line as the chat header's and
         the documents pane's. Three panes, one horizontal rule across them. -->
    <div class="relative flex h-14 shrink-0 items-center border-b px-2">
      <Search class="pointer-events-none absolute left-4 size-3.5 text-muted-foreground" />
      <Input
        v-model="query"
        placeholder="Search chats…"
        aria-label="Search chats"
        class="h-8 pr-7 pl-8 text-sm"
      />
      <button
        v-if="query"
        type="button"
        aria-label="Clear search"
        class="absolute right-4 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        @click="query = ''"
      >
        <X class="size-3.5" />
      </button>
    </div>

    <div v-if="!assistant.threadsLoaded" class="space-y-1.5 p-2">
      <Skeleton v-for="i in 6" :key="i" class="h-11 w-full" />
    </div>

    <p v-else-if="threads.length === 0" class="p-3 text-xs leading-relaxed text-muted-foreground">
      {{ query ? `No chats match “${query}”.` : 'No chats yet — start one below.' }}
    </p>

    <!-- Virtualized roster: the only part of the rail that scrolls. -->
    <div v-else v-bind="containerProps" class="quiet-scroll min-h-0 flex-1">
      <ul v-bind="wrapperProps">
        <li v-for="{ data: t } in list" :key="t.id">
          <!-- Square and full-bleed, like the settings and projects rails:
               a rounded card inside a rail reads as a floating object in a
               list of them, and 16rem is too narrow to spend on the inset. -->
          <div
            class="group/row relative flex items-center border-l-2 transition-colors"
            :class="
              t.id === assistant.activeThread?.id
                ? 'border-primary bg-primary/10'
                : 'border-transparent hover:bg-accent'
            "
            :style="{ height: `${ROW_HEIGHT}px` }"
          >
            <button
              type="button"
              class="flex h-full min-w-0 flex-1 flex-col justify-center gap-0.5 px-2.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              :aria-current="t.id === assistant.activeThread?.id ? 'true' : undefined"
              @click="open(t.id)"
            >
              <span
                class="truncate text-sm leading-tight"
                :class="t.id === assistant.activeThread?.id ? 'font-medium text-primary' : 'text-foreground/90'"
              >
                {{ threadLabel(t) }}
              </span>
              <span class="truncate text-[11px] text-muted-foreground">{{ relativeTime(t.updatedAt) }}</span>
            </button>

            <!-- Row actions stay hidden until the row is hovered or the menu
                 has focus, so a list of chats reads as a list of chats. -->
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="mr-1 shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                  :aria-label="`Actions for ${threadLabel(t)}`"
                >
                  <MoreHorizontal class="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="w-40">
                <DropdownMenuItem @select="emit('rename', t)">
                  <Pencil class="size-3.5" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" @select="emit('delete', t)">
                  <Trash2 class="size-3.5" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </li>
      </ul>
    </div>

    <div v-if="assistant.threadsLoading && assistant.threadsLoaded" class="px-3 pb-1 text-[11px] text-muted-foreground">
      Loading more…
    </div>

    <!-- Create sits at the foot of the rail, below its own divider. -->
    <div class="mt-auto shrink-0 border-t p-2">
      <Button variant="outline" size="sm" class="w-full justify-start" @click="startNewThread">
        <Plus class="size-4" />
        New chat
      </Button>
    </div>
  </div>
</template>
