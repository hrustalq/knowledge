<script setup lang="ts">
/**
 * Deleting a memory bank (#994): everything an agent kept there goes, and no
 * merge request brings it back. The bank id is typed, as a workspace's name
 * is, and checked again by the server (`?confirm=`).
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MemoryBankSummary } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { errorMessage } from '@/shared/api/errors'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@knowledge/ui/alert-dialog'
import { Input } from '@knowledge/ui/input'

const { t } = useI18n()
const props = defineProps<{ open: boolean; bank: MemoryBankSummary }>()
const emit = defineEmits<{ 'update:open': [boolean]; deleted: [MemoryBankSummary] }>()

const typed = ref('')
const working = ref(false)
const failed = ref<string | null>(null)
watch(
  () => props.open,
  () => {
    typed.value = ''
    failed.value = null
  },
)
const ready = computed(() => typed.value === props.bank.bankId && !working.value)

async function confirm() {
  if (!ready.value) return
  working.value = true
  failed.value = null
  try {
    await api.delete('/v1/memory/banks/{id}', { path: { id: props.bank.id }, query: { confirm: typed.value } })
    emit('deleted', props.bank)
    emit('update:open', false)
  } catch (e) {
    failed.value = errorMessage(e, t)
  } finally {
    working.value = false
  }
}
</script>

<template>
  <AlertDialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
    <AlertDialogContent class="max-w-lg">
      <AlertDialogHeader>
        <AlertDialogTitle class="break-words">{{ t('memory.delete.title', { bank: bank.bankId }) }}</AlertDialogTitle>
        <AlertDialogDescription>{{ t('memory.delete.body', { facts: t('memory.bank.factsN', { n: bank.facts }, bank.facts), observations: t('memory.bank.observationsN', { n: bank.observations }, bank.observations) }) }}</AlertDialogDescription>
      </AlertDialogHeader>
      <label class="block space-y-1">
        <span class="text-xs break-words text-muted-foreground">{{ t('memory.delete.typeId', { bank: bank.bankId }) }}</span>
        <Input v-model="typed" :placeholder="bank.bankId" autocomplete="off" spellcheck="false" class="font-mono" @keydown.enter.prevent="confirm" />
      </label>
      <p v-if="failed" class="text-sm text-destructive" role="alert">{{ failed }}</p>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="working">{{ t('common.cancel') }}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" :disabled="!ready" @click.prevent="confirm">
          {{ working ? t('memory.delete.deleting') : t('memory.delete.confirm') }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
