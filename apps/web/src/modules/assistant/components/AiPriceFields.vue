<script setup lang="ts">
/** What one model costs per 1M tokens, in a currency, over the list price. */
import { useI18n } from 'vue-i18n'
import { COST_CURRENCIES, type CostCurrency } from '@knowledge/contracts'
import { Input } from '@knowledge/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@knowledge/ui/select'
import { formatPrice } from '@/shared/utils/format'
import type { PriceFields } from '@/modules/assistant/model/use-price-fields'

const props = defineProps<{ price: PriceFields }>()

const { t } = useI18n()
const form = props.price.form
const SIDES = [
  { key: 'prompt', label: 'ai.prompt' },
  { key: 'cachedPrompt', label: 'ai.providerDialog.priceCached' },
  { key: 'completion', label: 'ai.completion' },
] as const
</script>

<template>
  <fieldset class="space-y-2">
    <legend class="text-muted-foreground mb-1.5 text-xs font-medium">{{ t('ai.providerDialog.price') }}</legend>
    <div class="grid grid-cols-2 items-end gap-3 sm:grid-cols-4">
      <label class="block space-y-1">
        <span class="text-xs">{{ t('ai.providerDialog.priceCurrency') }}</span>
        <Select :model-value="price.currency.value" @update:model-value="form.currency = $event as CostCurrency">
          <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="c in COST_CURRENCIES" :key="c" :value="c">{{ c }}</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <label v-for="side in SIDES" :key="side.key" class="block space-y-1">
        <span class="text-xs">{{ t(side.label) }}</span>
        <Input
          v-model="form[side.key]"
          inputmode="decimal"
          :placeholder="price.placeholder(side.key)"
          :aria-invalid="price.parsed.value[side.key] === undefined || undefined"
        />
      </label>
    </div>
    <p v-if="!price.valid.value" class="text-destructive text-xs">{{ t('ai.providerDialog.priceInvalid') }}</p>
    <p v-else-if="!price.willBePriced.value" class="text-muted-foreground text-xs">
      {{ t('ai.providerDialog.priceMissing') }}
    </p>
    <p v-else-if="price.listPrice.value" class="text-muted-foreground text-xs tabular-nums">
      {{
        t('ai.providerDialog.priceListed', {
          model: price.model(),
          prompt: formatPrice(price.listPrice.value.prompt, price.listPrice.value.currency),
          completion: formatPrice(price.listPrice.value.completion, price.listPrice.value.currency),
        })
      }}
    </p>
    <p v-if="price.kind() === 'gen-api'" class="text-muted-foreground text-xs">{{ t('ai.providerDialog.priceGenApi') }}</p>
  </fieldset>
</template>
