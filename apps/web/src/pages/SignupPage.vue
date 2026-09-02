<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

const auth = useAuthStore()
const router = useRouter()

const email = ref('')
const displayName = ref('')
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
  <div class="mx-auto mt-16 max-w-sm">
    <Card>
      <CardHeader>
        <CardTitle>Create account</CardTitle>
        <CardDescription>Sign up — you'll join the default workspace as a viewer</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="space-y-3" @submit.prevent="submit">
          <div class="space-y-1">
            <label class="text-sm font-medium" for="name">Display name</label>
            <Input id="name" v-model="displayName" required autocomplete="name" placeholder="Ada Lovelace" />
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="email">Email</label>
            <Input id="email" v-model="email" type="email" required autocomplete="email" placeholder="you@example.com" />
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="password">Password</label>
            <Input id="password" v-model="password" type="password" required minlength="8" autocomplete="new-password" />
            <p class="text-xs text-muted-foreground">At least 8 characters</p>
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="confirm">Confirm password</label>
            <Input id="confirm" v-model="confirm" type="password" required autocomplete="new-password" />
          </div>
          <Button class="w-full" type="submit" :disabled="busy">{{ busy ? 'Creating…' : 'Sign up' }}</Button>
        </form>
        <p class="mt-4 text-sm text-muted-foreground">
          Already have an account?
          <RouterLink class="hover:text-foreground hover:underline" to="/login">Log in</RouterLink>
        </p>
      </CardContent>
    </Card>
  </div>
</template>
