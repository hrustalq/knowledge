<script setup lang="ts">
/**
 * The dialog behind `confirm()`. Mounted once, in app/App.vue; see
 * use-confirm.ts for why there is only one.
 *
 * The last options are kept after it closes so the closing animation does not
 * play over an empty box.
 */
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog'
import { pendingConfirm, settleConfirm, type ConfirmOptions } from './use-confirm'

const { t } = useI18n()
const shown = shallowRef<ConfirmOptions | null>(null)
watch(pendingConfirm, (next) => {
  if (next) shown.value = next
})

const open = computed({
  get: () => pendingConfirm.value !== null,
  // Escape, the overlay and Cancel all arrive here as a close: each is a "no".
  // So does the action — reka may close before our @click runs — which is why the
  // "no" waits a microtask: the action's "yes" settles first, and wins.
  set: (value) => {
    if (!value) queueMicrotask(() => settleConfirm(false))
  },
})
</script>

<template>
  <AlertDialog v-model:open="open">
    <AlertDialogContent v-if="shown">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ shown.title }}</AlertDialogTitle>
        <AlertDialogDescription v-if="shown.description">{{ shown.description }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ shown.cancel ?? t('common.cancel') }}</AlertDialogCancel>
        <AlertDialogAction :variant="shown.destructive ? 'destructive' : 'default'" @click="settleConfirm(true)">
          {{ shown.action }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
