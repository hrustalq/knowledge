<script setup lang="ts">
/** The models a settings select offers, under who serves them. See `groupModels`. */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AiModelSummary } from '@knowledge/contracts'
import { SelectGroup, SelectItem, SelectLabel } from '@knowledge/ui/select'
import { groupModels } from '@/modules/assistant/model/provider-rows'

const props = defineProps<{ models: AiModelSummary[]; selected?: string | null }>()

const { t } = useI18n()
const groups = computed(() => groupModels(props.models, props.selected))
</script>

<template>
  <SelectGroup v-for="group in groups" :key="group.providerName ?? ''">
    <SelectLabel>{{ group.providerName ?? t('ai.default') }}</SelectLabel>
    <SelectItem v-for="m in group.models" :key="m.id" :value="m.id" :disabled="!m.available">
      {{ m.available ? m.code : t('ai.models.codeOff', { code: m.code }) }}
    </SelectItem>
  </SelectGroup>
</template>
