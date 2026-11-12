<script setup lang="ts">
/** What one model costs. Its code is what its provider calls it, so it is not editable: a new code is a new model. */
import { watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { AiModelSummary } from '@knowledge/contracts'
import { useApiMutation } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@knowledge/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@knowledge/ui/dialog'
import { usePriceFields } from '@/modules/assistant/model/use-price-fields'
import AiPriceFields from './AiPriceFields.vue'

const props = defineProps<{ model: AiModelSummary | null }>()
const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const update = useApiMutation('patch', '/v1/ai/models/{id}', { invalidates: () => [['/v1/ai/models']] })
const price = usePriceFields(
  () => props.model?.code ?? '',
  () => props.model?.kind ?? 'openai-compatible',
)

watch(open, (isOpen) => {
  if (isOpen && props.model) price.load(props.model)
})

async function submit() {
  if (!price.valid.value || !props.model) return
  try {
    await update.mutateAsync({ path: { id: props.model.id }, body: price.prices.value })
    toast.success(t('ai.models.saved'))
    open.value = false
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle class="break-all font-mono text-base">{{ model?.code }}</DialogTitle>
        <DialogDescription>{{ t('ai.models.editDesc') }}</DialogDescription>
      </DialogHeader>
      <form id="model-form" @submit.prevent="submit">
        <AiPriceFields :price="price" />
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" @click="open = false">{{ t('common.cancel') }}</Button>
        <Button type="submit" form="model-form" size="sm" :disabled="update.isPending.value || !price.valid.value">{{ t('common.save') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
