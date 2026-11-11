<script setup lang="ts">
/**
 * What a person can do to one of their memos (#875): rename it, delete it.
 * One menu for the list row and the memo's own page, so the two cannot drift.
 * It sits beside the row's link, never inside it.
 */
import { nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { MoreVertical, Pencil, Tags, Trash2 } from 'lucide-vue-next'
import { request } from '@/shared/api/client'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@knowledge/ui/button'
import { confirm } from '@knowledge/ui/confirm'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@knowledge/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@knowledge/ui/dropdown-menu'
import { Input } from '@knowledge/ui/input'
import { Label } from '@knowledge/ui/label'

const props = defineProps<{ memoId: string; title: string; tags: readonly string[] }>()
const emit = defineEmits<{ deleted: [] }>()

const { t } = useI18n()
const queryClient = useQueryClient()
const acting = ref(false)
const renaming = ref(false)
const draft = ref('')
/** Tags as one line of text (#879): what a person types is cleaned by the API the same way a model's are. */
const tagging = ref(false)
const tagDraft = ref('')

/** The list and every open memo: both carry the title. */
const reload = () => queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/v1/memos') })

async function act(run: () => Promise<unknown>): Promise<boolean> {
  if (acting.value) return false
  acting.value = true
  try {
    await run()
    return true
  } catch (e) {
    toast.error(errorMessage(e, t))
    return false
  } finally {
    acting.value = false
  }
}

function startRename() {
  draft.value = props.title
  // After the menu has closed and handed focus back, or the dialog loses it at once.
  void nextTick(() => (renaming.value = true))
}

function startTags() {
  tagDraft.value = props.tags.join(', ')
  void nextTick(() => (tagging.value = true))
}

async function saveTags() {
  const tags = tagDraft.value.split(',').map((tag) => tag.trim()).filter(Boolean)
  const ok = await act(() => request('patch', '/v1/memos/{id}', { path: { id: props.memoId }, body: { tags } }))
  if (!ok) return
  tagging.value = false
  await reload()
}

async function rename() {
  const title = draft.value.trim()
  if (!title || title === props.title) {
    renaming.value = false
    return
  }
  const ok = await act(() => request('patch', '/v1/memos/{id}', { path: { id: props.memoId }, body: { title } }))
  if (!ok) return
  renaming.value = false
  await reload()
}

async function remove() {
  const ok = await confirm({
    title: t('memos.detail.deleteTitle'),
    description: t('memos.detail.deleteBody'),
    action: t('memos.detail.delete'),
    destructive: true,
  })
  if (!ok) return
  if (!(await act(() => request('delete', '/v1/memos/{id}', { path: { id: props.memoId } })))) return
  emit('deleted')
  // The list only: the memo's own query would refetch into a 404 on the page being left.
  await queryClient.invalidateQueries({ queryKey: ['/v1/memos'] })
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="icon-sm" class="text-muted-foreground shrink-0" :disabled="acting" :aria-label="t('memos.actions.for', { title })">
        <MoreVertical class="size-4" aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-44">
      <DropdownMenuItem @select="startRename">
        <Pencil class="size-3.5" aria-hidden="true" />{{ t('memos.actions.rename') }}
      </DropdownMenuItem>
      <DropdownMenuItem @select="startTags">
        <Tags class="size-3.5" aria-hidden="true" />{{ t('memos.actions.tags') }}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" @select="remove">
        <Trash2 class="size-3.5" aria-hidden="true" />{{ t('memos.detail.delete') }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>

  <Dialog v-model:open="renaming">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t('memos.actions.renameTitle') }}</DialogTitle>
      </DialogHeader>
      <form class="space-y-4" @submit.prevent="rename">
        <div class="space-y-1.5">
          <Label :for="`memo-title-${memoId}`">{{ t('memos.actions.titleLabel') }}</Label>
          <Input :id="`memo-title-${memoId}`" v-model="draft" maxlength="300" required autocomplete="off" />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" @click="renaming = false">{{ t('memos.plaud.cancel') }}</Button>
          <Button type="submit" :disabled="acting || !draft.trim()">{{ t('memos.actions.save') }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="tagging">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t('memos.actions.tagsTitle') }}</DialogTitle>
      </DialogHeader>
      <form class="space-y-4" @submit.prevent="saveTags">
        <div class="space-y-1.5">
          <Label :for="`memo-tags-${memoId}`">{{ t('memos.review.tags') }}</Label>
          <Input :id="`memo-tags-${memoId}`" v-model="tagDraft" autocomplete="off" />
          <p class="text-muted-foreground text-xs">{{ t('memos.review.tagsHint') }}</p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" @click="tagging = false">{{ t('memos.plaud.cancel') }}</Button>
          <Button type="submit" :disabled="acting">{{ t('memos.actions.save') }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
