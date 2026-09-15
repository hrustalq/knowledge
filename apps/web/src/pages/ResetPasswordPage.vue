<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

const route = useRoute()
const router = useRouter()

const token = computed(() => (typeof route.query.token === 'string' ? route.query.token : ''))
const password = ref('')
const confirm = ref('')
const busy = ref(false)

async function submit() {
  if (password.value !== confirm.value) {
    toast.error(t('auth.passwordsDoNotMatch'))
    return
  }
  busy.value = true
  try {
    await apiFetch('/v1/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: token.value, password: password.value }),
    })
    toast.success(t('auth.passwordUpdated'))
    await router.push('/login')
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="w-full max-w-[25rem]">
    <Card class="border-0 bg-transparent shadow-none sm:border sm:bg-card sm:shadow-sm">
      <CardHeader class="text-center">
        <h1 data-slot="card-title" class="leading-none font-semibold">{{ t('auth.chooseNewPassword') }}</h1>
        <CardDescription>{{ t('auth.resetSignsOutEverywhere') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <p v-if="!token" class="text-sm text-muted-foreground">
          <i18n-t keypath="auth.missingResetToken" tag="span" scope="global">
            <template #link>
              <RouterLink class="underline" to="/forgot-password">{{ t('auth.requestNewOne') }}</RouterLink>
            </template>
          </i18n-t>
        </p>
        <form v-else class="space-y-3" @submit.prevent="submit">
          <div class="space-y-1">
            <div class="flex items-baseline justify-between gap-3">
              <label class="text-sm font-medium" for="password">{{ t('auth.newPassword') }}</label>
              <span id="password-hint" class="text-xs text-muted-foreground">{{ t('auth.atLeast8') }}</span>
            </div>
            <Input id="password" v-model="password" type="password" required minlength="8" autocomplete="new-password" aria-describedby="password-hint" />
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="confirm">{{ t('auth.confirmPassword') }}</label>
            <Input id="confirm" v-model="confirm" type="password" required autocomplete="new-password" />
          </div>
          <Button class="w-full" type="submit" :disabled="busy">{{ busy ? t('common.saving') : t('auth.resetSubmit') }}</Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
