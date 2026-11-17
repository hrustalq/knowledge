<script setup lang="ts">
/** What one model costs. Its code is what its provider calls it, so it is not editable: a new code is a new model. */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { MODEL_TIERS, type AiModelSummary, type ModelTier } from '@knowledge/contracts'
import { useApiMutation } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@knowledge/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@knowledge/ui/select'
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

// The class of model (#1121): an agent asking for a minimum tier only runs on one at or above it.
const tier = ref<ModelTier | 'none'>('none')

watch(open, (isOpen) => {
  if (!isOpen || !props.model) return
  price.load(props.model)
  tier.value = props.model.tier ?? 'none'
})

async function submit() {
  if (!price.valid.value || !props.model) return
  try {
    await update.mutateAsync({ path: { id: props.model.id }, body: { ...price.prices.value, tier: tier.value === 'none' ? null : tier.value } })
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
        <label class="mt-4 block space-y-1">
          <span class="text-xs">{{ t('ai.models.tier.label') }}</span>
          <Select v-model="tier">
            <SelectTrigger class="w-full sm:w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{{ t('ai.models.tier.none') }}</SelectItem>
              <SelectItem v-for="option in MODEL_TIERS" :key="option" :value="option">{{ t(`ai.models.tier.${option}`) }}</SelectItem>
            </SelectContent>
          </Select>
          <span class="text-muted-foreground block text-xs">{{ t('ai.models.tier.hint') }}</span>
        </label>
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" @click="open = false">{{ t('common.cancel') }}</Button>
        <Button type="submit" form="model-form" size="sm" :disabled="update.isPending.value || !price.valid.value">{{ t('common.save') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
