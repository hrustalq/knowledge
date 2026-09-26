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
// Rename and delete are confirmed by ThreadDialogs, shared with the editor's
// assistant panel — the same wording from the rail's row menu, the chat header
// or the panel.
import { useI18n } from 'vue-i18n'
import { onMounted, ref } from 'vue'
import { useAssistantStore } from '@/stores/assistant'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { PageLayout } from '@/components/layout/page'
import ChatRail from '@/components/assistant/ChatRail.vue'
import ChatPane from '@/components/assistant/ChatPane.vue'
import ThreadDocuments from '@/components/assistant/ThreadDocuments.vue'
import ThreadDialogs from '@/components/assistant/ThreadDialogs.vue'

const { t } = useI18n()

const assistant = useAssistantStore()

/** Small screens only: the rail lives in a sheet rather than beside the chat. */
const railOpen = ref(false)

const dialogs = ref<InstanceType<typeof ThreadDialogs> | null>(null)

onMounted(() => {
  if (!assistant.activeThread) void assistant.openOrCreateThread()
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
    <SheetContent side="left" class="w-72 p-0">
      <SheetHeader class="sr-only">
        <SheetTitle>{{ t('chat.chats') }}</SheetTitle>
      </SheetHeader>
      <ChatRail
        class="flex w-full border-r-0"
        @rename="dialogs?.rename($event)"
        @delete="dialogs?.remove($event)"
        @opened="railOpen = false"
      />
    </SheetContent>
  </Sheet>

  <ThreadDialogs ref="dialogs" />
</template>
