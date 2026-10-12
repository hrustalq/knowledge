<script setup lang="ts">
/**
 * The nudge for an unconfirmed address while confirming is optional
 * (docs/features/41). Strict mode never reaches the shell — the router holds
 * the account on /verify-email — so this only ever asks, never blocks.
 * Dismissal lasts the page load: the next visit asks again, which is the point.
 */
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { MailWarning, X } from 'lucide-vue-next'
import type { ResendVerificationResponse } from '@knowledge/contracts'
import { apiFetch } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'

defineProps<{ email: string }>()
const emit = defineEmits<{ dismiss: [] }>()

const { t } = useI18n()
const auth = useAuthStore()
const busy = ref(false)

async function resend() {
  busy.value = true
  try {
    const res = await apiFetch<ResendVerificationResponse>('/v1/auth/resend-verification', { method: 'POST' })
    if (res.alreadyVerified) await auth.reload()
    toast.success(res.alreadyVerified ? t('auth.verifyAlready') : t('auth.verifyResent'))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    role="status"
    class="flex h-10 shrink-0 items-center gap-3 border-b bg-muted/60 px-4 text-sm lg:px-8"
  >
    <MailWarning class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <span class="min-w-0 flex-1 truncate">{{ t('auth.verifyBanner', { email }) }}</span>
    <Button size="sm" variant="ghost" class="h-7 shrink-0" :disabled="busy" @click="resend">
      {{ busy ? t('auth.sending') : t('auth.verifyResend') }}
    </Button>
    <Button
      size="icon"
      variant="ghost"
      class="size-7 shrink-0"
      :aria-label="t('auth.verifyBannerDismiss')"
      @click="emit('dismiss')"
    >
      <X class="size-4" />
    </Button>
  </div>
</template>
