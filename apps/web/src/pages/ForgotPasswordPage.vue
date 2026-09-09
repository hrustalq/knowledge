<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'
import type { ForgotPasswordResponse } from '@knowledge/contracts'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

const email = ref('')
const busy = ref(false)
const sent = ref(false)
/** Dev convenience: the API echoes the token back when NODE_ENV != production. */
const debugToken = ref<string | null>(null)

async function submit() {
  busy.value = true
  try {
    const res = await apiFetch<ForgotPasswordResponse>('/v1/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: email.value }),
    })
    sent.value = true
    debugToken.value = res.debugToken ?? null
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto my-auto mt-16 max-w-sm">
    <Card>
      <CardHeader>
        <CardTitle>{{ t('auth.resetTitle') }}</CardTitle>
        <CardDescription>{{ t('auth.forgotIssueHint') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="sent" class="space-y-3 text-sm">
          <p>
            <i18n-t keypath="auth.resetIssued" tag="span" scope="global">
              <template #email><span class="font-medium">{{ email }}</span></template>
            </i18n-t>
          </p>
          <p v-if="debugToken" class="rounded-md border bg-muted/50 p-2 break-all">
            {{ t('auth.devModeToken') }}
            <RouterLink class="underline" :to="`/reset-password?token=${debugToken}`">{{ t('auth.useItNow') }}</RouterLink>
          </p>
          <RouterLink class="block text-muted-foreground hover:text-foreground hover:underline" to="/login">
            {{ t('auth.backToLogin') }}
          </RouterLink>
        </div>
        <form v-else class="space-y-3" @submit.prevent="submit">
          <div class="space-y-1">
            <label class="text-sm font-medium" for="email">{{ t('auth.email') }}</label>
            <Input id="email" v-model="email" type="email" required autocomplete="email" placeholder="you@example.com" />
          </div>
          <Button class="w-full" type="submit" :disabled="busy">{{ busy ? t('auth.sending') : t('auth.forgotSubmit') }}</Button>
          <RouterLink class="block text-center text-sm text-muted-foreground hover:text-foreground hover:underline" to="/login">
            {{ t('auth.backToLogin') }}
          </RouterLink>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
