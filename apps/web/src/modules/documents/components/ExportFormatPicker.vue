<script setup lang="ts">
/**
 * The export format choice (docs/features/45): one card per format, PDF shown
 * disabled with the reason where the deployment cannot make one. Store-free,
 * so the app's ExportDialog and the share reader's download (#161) render the
 * same control; each catalogue words `export.pdfUnavailable` for its reader.
 */
import { useI18n } from 'vue-i18n'
import { EXPORT_FORMATS, type ExportFormat } from '@knowledge/contracts'
import { exportFormatAvailable } from '@/core/export-formats'
import { Label } from '@/shared/ui/label'
import { RadioGroup, RadioGroupItem } from '@/shared/ui/radio-group'

defineProps<{ formats?: Record<ExportFormat, boolean> | null }>()
const format = defineModel<ExportFormat>({ required: true })

const { t } = useI18n()
</script>

<template>
  <fieldset class="space-y-2">
    <legend id="kn-export-format-label" class="mb-1 text-sm font-medium">{{ t('export.formatLabel') }}</legend>
    <RadioGroup v-model="format" class="gap-2" aria-labelledby="kn-export-format-label">
      <Label
        v-for="f in EXPORT_FORMATS"
        :key="f"
        :for="`kn-export-${f}`"
        class="has-[[data-state=checked]]:border-primary flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
      >
        <RadioGroupItem :id="`kn-export-${f}`" :value="f" :disabled="!exportFormatAvailable(formats, f)" class="mt-0.5" />
        <span class="min-w-0">
          <span class="block text-sm font-medium">{{ t(`export.format.${f}`) }}</span>
          <span class="text-muted-foreground block text-xs">
            {{ exportFormatAvailable(formats, f) ? t(`export.formatHint.${f}`) : t('export.pdfUnavailable') }}
          </span>
        </span>
      </Label>
    </RadioGroup>
  </fieldset>
</template>
