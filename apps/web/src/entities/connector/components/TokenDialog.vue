<script setup lang="ts">
/**
 * Paste a new token (#564, #857): the Connections tab's Replace and the
 * Connected accounts page's Rotate are one form. The caller words it and
 * submits it; the provider's refusal stays by the field, because it is about
 * what was pasted.
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import { Button } from '@knowledge/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@knowledge/ui/dialog'
import { Input } from '@knowledge/ui/input'

const props = defineProps<{
  open: boolean
  title: string
  description: string
  submitLabel: string
  /** The last four of the token being replaced, as the field's placeholder. */
  hint?: string | null
  pending: boolean
  error: string | null
}>()
const emit = defineEmits<{ 'update:open': [boolean]; submit: [string] }>()

const { t } = useI18n()
const secret = ref('')
watch(
  () => props.open,
  (open) => {
    if (open) secret.value = ''
  },
)
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ description }}</DialogDescription>
      </DialogHeader>
      <form class="space-y-3" @submit.prevent="secret.trim() && emit('submit', secret.trim())">
        <label class="block space-y-1.5">
          <span class="text-sm font-medium">{{ t('connectors.connections.newToken') }}</span>
          <Input
            v-model="secret"
            type="password"
            autocomplete="off"
            :placeholder="hint ? t('connectors.credentialKeep', { hint }) : ''"
            :aria-invalid="error ? 'true' : undefined"
            aria-describedby="token-dialog-error"
          />
        </label>
        <p v-if="error" id="token-dialog-error" class="text-destructive text-xs" role="alert">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" @click="emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="!secret.trim() || pending">
            <Loader2 v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
            {{ submitLabel }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
