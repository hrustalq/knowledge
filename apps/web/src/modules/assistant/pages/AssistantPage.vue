<script setup lang="ts">
// Workspace-level assistant: chats rail → conversation → pages touched.
//
// Three flush panes with their top borders on one line, built like the
// settings and projects rails — but as a `meta.fill` route (see app/App.vue),
// because a conversation owns the viewport rather than flowing down it. The
// transcript is the only thing that scrolls; the composer and both rails stay
// put. That is why this page takes its height from the column (`h-full`)
// instead of bleeding out of the page padding: every `flex-1` below here
// needs a definite number to resolve against.
//
// Rename and delete are confirmed by ThreadDialogs, shared with the editor's
// assistant panel — the same wording from the rail's row menu, the chat header
// or the panel.
import { useI18n } from 'vue-i18n'
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useAssistantStore } from '@/entities/assistant'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@knowledge/ui/sheet'
import { PageLayout } from '@knowledge/ui/layout'
import { ChatRail } from '@/entities/assistant'
import { ChatPane } from '@/entities/assistant'
import ThreadDocuments from '@/modules/assistant/components/ThreadDocuments.vue'
import { ThreadDialogs } from '@/entities/assistant'

const { t } = useI18n()

const assistant = useAssistantStore()
const route = useRoute()

/** Small screens only: the rail lives in a sheet rather than beside the chat. */
const railOpen = ref(false)

const dialogs = ref<InstanceType<typeof ThreadDialogs> | null>(null)

/** Focus stays put on touch, where the first field would raise the keyboard. */
function onSheetAutoFocus(event: Event) {
  if (matchMedia('(pointer: coarse)').matches) event.preventDefault()
}

// `?thread=` is an opening instruction (a chat bot's "open the full answer"
// link, issue #71), not two-way state: the rail drives selection afterwards.
const linked = typeof route.query.thread === 'string' ? route.query.thread : null
// Set during setup, so the server render and the first paint already show a
// chat loading instead of an empty "New chat" that is about to be replaced (#931).
if (!assistant.activeThread) assistant.resuming = true
onMounted(() => {
  // A linked chat opens by id, which loads no roster: ask for it too, or the
  // rail waits on skeletons for good.
  if (linked) {
    void assistant.openThread(linked)
    if (!assistant.threadsLoaded) void assistant.fetchThreads()
  }
  else if (!assistant.activeThread) void assistant.openLatest()
})
</script>

<template>
  <!--
    `canvas`: a conversation owns the viewport rather than flowing down it, so
    the transcript is the only thing that scrolls while the composer and both
    rails stay put. Declaring it here is what pairs the page with `meta.fill` on
    its route — PageLayout warns in dev if the two ever disagree, which is the
    failure that leaves every `flex-1` below resolving against nothing.

    The chat rail stays a plain flex child rather than becoming a PageSubRail:
    below the shell's hinge it moves into a sheet instead of collapsing in
    place, which is a different affordance, not a narrower one.
  -->
  <PageLayout variant="canvas">
    <div class="flex min-h-0 flex-1 overflow-hidden">
      <!-- Below lg the rail would eat a phone screen, so it moves into a sheet
           opened from the chat header instead of stacking above the transcript. -->
      <ChatRail class="hidden lg:flex" @rename="dialogs?.rename($event)" @delete="dialogs?.remove($event)" />

      <ChatPane @rename="dialogs?.rename($event)" @delete="dialogs?.remove($event)" @browse="railOpen = true" />

      <ThreadDocuments class="hidden xl:flex" />
    </div>
  </PageLayout>

  <Sheet v-model:open="railOpen">
    <!-- On touch, opening the list must not raise the keyboard over it: the
         search field is the first focusable thing in the sheet (#1066). The
         rail's header steps clear of the sheet's close, which sat on the
         field's right end. -->
    <SheetContent side="left" class="w-72 p-0" @open-auto-focus="onSheetAutoFocus">
      <SheetHeader class="sr-only">
        <SheetTitle>{{ t('chat.chats') }}</SheetTitle>
      </SheetHeader>
      <ChatRail
        in-sheet
        class="flex w-full border-r-0"
        @rename="dialogs?.rename($event)"
        @delete="dialogs?.remove($event)"
        @opened="railOpen = false"
      />
    </SheetContent>
  </Sheet>

  <ThreadDialogs ref="dialogs" />
</template>
