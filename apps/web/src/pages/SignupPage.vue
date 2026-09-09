<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

const auth = useAuthStore()
const router = useRouter()

const email = ref('')
const displayName = ref('')
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
    await auth.signup(email.value, displayName.value, password.value)
    await router.push('/documents')
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
        <CardTitle>{{ t('auth.createAccount') }}</CardTitle>
        <CardDescription>{{ t('auth.signUpJoinHint') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="space-y-3" @submit.prevent="submit">
          <div class="space-y-1">
            <label class="text-sm font-medium" for="name">{{ t('auth.displayName') }}</label>
            <Input id="name" v-model="displayName" required autocomplete="name" :placeholder="t('auth.namePlaceholder')" />
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="email">{{ t('auth.email') }}</label>
            <Input id="email" v-model="email" type="email" required autocomplete="email" placeholder="you@example.com" />
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="password">{{ t('auth.password') }}</label>
            <Input id="password" v-model="password" type="password" required minlength="8" autocomplete="new-password" />
            <p class="text-xs text-muted-foreground">{{ t('auth.atLeast8') }}</p>
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="confirm">{{ t('auth.confirmPassword') }}</label>
            <Input id="confirm" v-model="confirm" type="password" required autocomplete="new-password" />
          </div>
          <Button class="w-full" type="submit" :disabled="busy">{{ busy ? t('auth.creating') : t('auth.signUp') }}</Button>
        </form>
        <p class="mt-4 text-sm text-muted-foreground">
          {{ t('auth.alreadyHaveAccount') }}
          <RouterLink class="hover:text-foreground hover:underline" to="/login">{{ t('auth.logIn') }}</RouterLink>
        </p>
      </CardContent>
    </Card>
  </div>
</template>
