<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
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
  <div class="w-full max-w-[25rem]">
    <!-- Below `sm` the card stops being a card: no border, no shadow, no
         surface of its own, so the form runs the full width of the phone
         instead of sitting inside a 384px box with a frame drawn around it.
         Nothing is floating above the page down there — it *is* the page. -->
    <Card class="border-0 bg-transparent shadow-none sm:border sm:bg-card sm:shadow-sm">
      <CardHeader class="text-center">
        <h1 data-slot="card-title" class="leading-none font-semibold">{{ t('auth.logIn') }}</h1>
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
        <!-- `min-h-11` is the touch target, and the negative inline margin
             keeps it from pushing the two links away from the form's edges. -->
        <div class="mt-1 flex items-center justify-between text-sm text-muted-foreground">
          <RouterLink class="-mx-2 inline-flex min-h-11 items-center px-2 hover:text-foreground hover:underline" to="/forgot-password">{{ t('auth.forgotPassword') }}</RouterLink>
          <RouterLink class="-mx-2 inline-flex min-h-11 items-center px-2 hover:text-foreground hover:underline" to="/signup">{{ t('auth.createAccount') }}</RouterLink>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
