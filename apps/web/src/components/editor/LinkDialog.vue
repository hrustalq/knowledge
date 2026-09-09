<script setup lang="ts">
/**
 * Link editor. Replaces `window.prompt`, which cannot show the current URL as
 * editable text, cannot offer "remove link", is unstyled, and blocks the whole
 * tab while it is open.
 */
import { nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const { t } = useI18n()
const props = defineProps<{ open: boolean; initialUrl: string; hasLink: boolean }>()
const emit = defineEmits<{
  'update:open': [boolean]
  apply: [string]
  remove: []
}>()

const url = ref(props.initialUrl)
const inputEl = ref<InstanceType<typeof Input> | null>(null)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    url.value = props.initialUrl || 'https://'
    void nextTick(() => {
      const el = (inputEl.value as unknown as { $el?: HTMLInputElement })?.$el
      el?.focus()
      // Select the whole value: the common case is replacing it, not appending.
      el?.select()
    })
  },
)

function apply() {
  const value = url.value.trim()
  if (!value || value === 'https://') return
  emit('apply', value)
  emit('update:open', false)
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ hasLink ? t('editor.linkEdit') : t('editor.linkAdd') }}</DialogTitle>
        <DialogDescription>
          <i18n-t keypath="editor.linkDescription" tag="span" scope="global">
            <template #at><strong>@</strong></template>
          </i18n-t>
        </DialogDescription>
      </DialogHeader>

      <form class="space-y-2" @submit.prevent="apply">
        <Label for="kn-link-url" class="kn-field-label">URL</Label>
        <Input
          id="kn-link-url"
          ref="inputEl"
          v-model="url"
          type="url"
          placeholder="https://example.com/page"
          autocomplete="off"
          spellcheck="false"
        />
      </form>

      <DialogFooter class="gap-2 sm:justify-between">
        <Button v-if="hasLink" variant="ghost" class="text-destructive" @click="emit('remove'); emit('update:open', false)">
          {{ t('editor.linkRemove') }}
        </Button>
        <span v-else />
        <div class="flex gap-2">
          <Button variant="outline" @click="emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button :disabled="!url.trim() || url.trim() === 'https://'" @click="apply">
            {{ hasLink ? t('editor.linkUpdate') : t('editor.linkAdd') }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
