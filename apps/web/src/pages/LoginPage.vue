<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

const { t } = useI18n()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const email = ref('')
const password = ref('')
const busy = ref(false)

async function submit() {
  busy.value = true
  try {
    await auth.login(email.value, password.value)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/documents'
    await router.push(redirect)
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
        <CardTitle>{{ t('auth.logIn') }}</CardTitle>
        <CardDescription>{{ t('auth.logInSubtitle') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="space-y-3" @submit.prevent="submit">
          <div class="space-y-1">
            <label class="text-sm font-medium" for="email">{{ t('auth.email') }}</label>
            <Input id="email" v-model="email" type="email" required autocomplete="email" placeholder="you@example.com" />
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="password">{{ t('auth.password') }}</label>
            <Input id="password" v-model="password" type="password" required autocomplete="current-password" />
          </div>
          <Button class="w-full" type="submit" :disabled="busy">{{ busy ? t('auth.signingIn') : t('auth.logIn') }}</Button>
        </form>
        <div class="mt-4 flex justify-between text-sm text-muted-foreground">
          <RouterLink class="hover:text-foreground hover:underline" to="/forgot-password">{{ t('auth.forgotPassword') }}</RouterLink>
          <RouterLink class="hover:text-foreground hover:underline" to="/signup">{{ t('auth.createAccount') }}</RouterLink>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
