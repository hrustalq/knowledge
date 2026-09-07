<script setup lang="ts">
// Workspace-level assistant: chats rail → conversation → pages touched.
//
// Three flush panes with their top borders on one line, built like the
// settings and projects rails — but as a `meta.fill` route (see App.vue),
// because a conversation owns the viewport rather than flowing down it. The
// transcript is the only thing that scrolls; the composer and both rails stay
// put. That is why this page takes its height from the column (`h-full`)
// instead of bleeding out of the page padding: every `flex-1` below here
// needs a definite number to resolve against.
//
// Rename and delete live here, once, for both the rail's row menu and the
// chat header — the same wording either way.
import { onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import type { AssistantThreadSummary } from '@knowledge/contracts'
import { useAssistantStore } from '@/stores/assistant'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import ChatRail from '@/components/assistant/ChatRail.vue'
import ChatPane from '@/components/assistant/ChatPane.vue'
import ThreadDocuments from '@/components/assistant/ThreadDocuments.vue'
import { threadLabel } from '@/components/assistant/thread-label'

const assistant = useAssistantStore()

/** Small screens only: the rail lives in a sheet rather than beside the chat. */
const railOpen = ref(false)

onMounted(() => {
  if (!assistant.activeThread) void assistant.openOrCreateThread()
})

const renaming = ref<AssistantThreadSummary | null>(null)
const renameDraft = ref('')
const busy = ref(false)

function openRename(thread: AssistantThreadSummary) {
  renaming.value = thread
  // Seeded with what the row currently reads, so renaming an auto-named chat
  // starts from that name instead of an empty field.
  renameDraft.value = thread.title ?? threadLabel(thread)
}

async function confirmRename() {
  const thread = renaming.value
  if (!thread || busy.value) return
  busy.value = true
  try {
    await assistant.renameThread(thread.id, renameDraft.value)
    renaming.value = null
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = false
  }
}

const deleting = ref<AssistantThreadSummary | null>(null)

async function confirmDelete() {
  const thread = deleting.value
  if (!thread || busy.value) return
  busy.value = true
  try {
    await assistant.deleteThread(thread.id)
    deleting.value = null
    toast.success('Chat deleted')
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <!-- Below lg the rail would eat a phone screen, so it moves into a sheet
         opened from the chat header instead of stacking above the transcript. -->
    <ChatRail class="hidden lg:flex" @rename="openRename" @delete="deleting = $event" />

    <ChatPane @rename="openRename" @delete="deleting = $event" @browse="railOpen = true" />

    <ThreadDocuments class="hidden xl:flex" />
  </div>

  <Sheet v-model:open="railOpen">
    <SheetContent side="left" class="w-72 p-0">
      <SheetHeader class="sr-only">
        <SheetTitle>Chats</SheetTitle>
      </SheetHeader>
      <ChatRail
        class="flex w-full border-r-0"
        @rename="openRename"
        @delete="deleting = $event"
        @opened="railOpen = false"
      />
    </SheetContent>
  </Sheet>

  <Dialog :open="renaming !== null" @update:open="(open: boolean) => { if (!open) renaming = null }">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Rename chat</DialogTitle>
        <DialogDescription>
          Changes the label in the chat list. Clear it to go back to the name taken from the first message.
        </DialogDescription>
      </DialogHeader>
      <Input v-model="renameDraft" placeholder="Chat name" autofocus @keyup.enter="confirmRename" />
      <DialogFooter>
        <Button variant="ghost" @click="renaming = null">Cancel</Button>
        <Button :disabled="busy" @click="confirmRename">{{ busy ? 'Saving…' : 'Save' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog :open="deleting !== null" @update:open="(open: boolean) => { if (!open) deleting = null }">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Delete this chat?</DialogTitle>
        <DialogDescription>
          “{{ deleting ? threadLabel(deleting) : '' }}” and its whole message history will be removed, and this
          cannot be undone. Pages the assistant created and merge requests it opened are not affected.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" @click="deleting = null">Cancel</Button>
        <Button variant="destructive" :disabled="busy" @click="confirmDelete">
          {{ busy ? 'Deleting…' : 'Delete chat' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
