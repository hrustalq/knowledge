<script setup lang="ts">
/**
 * The password gate in front of a protected share (docs/features/43). The
 * unlock sets an httpOnly cookie on this origin, and the page reloads so the
 * server renders the body with it — the password never reaches page state.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Lock } from 'lucide-vue-next'
import { isApiErrorPayload } from '@knowledge/contracts'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'

const props = defineProps<{ token: string; apiBase: string }>()

const { t, locale } = useI18n()
const password = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

async function unlock() {
  if (!password.value || busy.value) return
  busy.value = true
  error.value = null
  try {
    const res = await fetch(`${props.apiBase}/v1/public/shares/${encodeURIComponent(props.token)}/unlock`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': locale.value },
      body: JSON.stringify({ password: password.value }),
    })
    if (res.ok) {
      window.location.reload()
      return
    }
    const body: unknown = await res.json().catch(() => null)
    error.value = isApiErrorPayload(body) ? body.message : t('shareReader.unlockFailed')
  } catch {
    error.value = t('shareReader.unlockFailed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="mx-auto mt-24 w-full max-w-sm space-y-4 px-6" @submit.prevent="unlock">
    <div class="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <Lock class="size-5" aria-hidden="true" />
    </div>
    <div class="space-y-1">
      <h1 class="text-lg font-semibold">{{ t('shareReader.lockedTitle') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('shareReader.lockedBody') }}</p>
    </div>
    <label class="block space-y-1.5">
      <span class="text-sm font-medium">{{ t('shareReader.password') }}</span>
      <Input
        v-model="password"
        type="password"
        autocomplete="current-password"
        required
        :aria-invalid="error ? 'true' : undefined"
        aria-describedby="share-gate-error"
      />
    </label>
    <p v-if="error" id="share-gate-error" class="text-sm text-destructive" role="alert">{{ error }}</p>
    <Button type="submit" class="w-full" :disabled="busy || !password">
      {{ busy ? t('shareReader.unlocking') : t('shareReader.unlock') }}
    </Button>
  </form>
</template>
