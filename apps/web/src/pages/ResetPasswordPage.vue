<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

const route = useRoute()
const router = useRouter()

const token = computed(() => (typeof route.query.token === 'string' ? route.query.token : ''))
const password = ref('')
const confirm = ref('')
const busy = ref(false)

async function submit() {
  if (password.value !== confirm.value) {
    toast.error('Passwords do not match')
    return
  }
  busy.value = true
  try {
    await apiFetch('/v1/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: token.value, password: password.value }),
    })
    toast.success('Password updated — log in with your new password')
    await router.push('/login')
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto mt-16 max-w-sm">
    <Card>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>Sessions on all devices will be signed out</CardDescription>
      </CardHeader>
      <CardContent>
        <p v-if="!token" class="text-sm text-muted-foreground">
          Missing reset token — follow the link from your reset email, or
          <RouterLink class="underline" to="/forgot-password">request a new one</RouterLink>.
        </p>
        <form v-else class="space-y-3" @submit.prevent="submit">
          <div class="space-y-1">
            <label class="text-sm font-medium" for="password">New password</label>
            <Input id="password" v-model="password" type="password" required minlength="8" autocomplete="new-password" />
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="confirm">Confirm password</label>
            <Input id="confirm" v-model="confirm" type="password" required autocomplete="new-password" />
          </div>
          <Button class="w-full" type="submit" :disabled="busy">{{ busy ? 'Saving…' : 'Set new password' }}</Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
