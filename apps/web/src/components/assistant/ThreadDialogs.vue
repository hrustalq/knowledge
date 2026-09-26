<script setup lang="ts">
// Rename and delete for a chat, confirmed — one set of dialogs for every place
// that offers the two actions: the assistant page's rail and header, and the
// editor's assistant panel. Lifted out of AssistantPage when the panel became a
// second host, so the wording cannot drift between them.
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
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
import { threadLabel } from './thread-label'

const { t } = useI18n()
const assistant = useAssistantStore()

const renaming = ref<AssistantThreadSummary | null>(null)
const renameDraft = ref('')
const deleting = ref<AssistantThreadSummary | null>(null)
const busy = ref(false)

function rename(thread: AssistantThreadSummary) {
  renaming.value = thread
  // Seeded with what the row currently reads, so renaming an auto-named chat
  // starts from that name instead of an empty field.
  renameDraft.value = thread.title ?? threadLabel(thread)
}

function remove(thread: AssistantThreadSummary) {
  deleting.value = thread
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

async function confirmDelete() {
  const thread = deleting.value
  if (!thread || busy.value) return
  busy.value = true
  try {
    await assistant.deleteThread(thread.id)
    deleting.value = null
    toast.success(t('chat.deleted'))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = false
  }
}

defineExpose({ rename, remove })
</script>

<template>
  <Dialog :open="renaming !== null" @update:open="(open: boolean) => { if (!open) renaming = null }">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t('chat.renameChat') }}</DialogTitle>
        <DialogDescription>
          {{ t('chat.renameHint') }}
        </DialogDescription>
      </DialogHeader>
      <Input v-model="renameDraft" :placeholder="t('chat.chatName')" autofocus @keyup.enter="confirmRename" />
      <DialogFooter>
        <Button variant="ghost" @click="renaming = null">{{ t('common.cancel') }}</Button>
        <Button :disabled="busy" @click="confirmRename">{{ busy ? 'Saving…' : 'Save' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog :open="deleting !== null" @update:open="(open: boolean) => { if (!open) deleting = null }">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t('chat.deleteChat') }}</DialogTitle>
        <DialogDescription>
          {{ t('chat.deleteChatBody', { name: deleting ? threadLabel(deleting) : '' }) }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" @click="deleting = null">{{ t('common.cancel') }}</Button>
        <Button variant="destructive" :disabled="busy" @click="confirmDelete">
          {{ busy ? 'Deleting…' : 'Delete chat' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
