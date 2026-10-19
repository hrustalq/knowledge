<script setup lang="ts">
/**
 * /auth/sso/complete (#75): where the identity provider's round trip ends.
 *
 * The API's callback sends the browser here with a single-use code in the
 * fragment. The fragment never reaches a server, so this runs after hydration
 * only: read the code, wipe it from the address bar (and so from history),
 * trade it for a session in a POST body, and go where the sign-in started.
 * A refused code goes to /login?error= like every other SSO failure (#291).
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { ApiError } from '@/lib/api'
import { fragmentCode, ownPath, ssoErrorOf } from '@/lib/sso'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

const { t } = useI18n()
const auth = useAuthStore()
const router = useRouter()

const failed = ref(false)

onMounted(async () => {
  const code = fragmentCode(window.location.hash)
  history.replaceState(history.state, '', window.location.pathname)
  if (!code) {
    failed.value = true
    return
  }
  let returnTo: string
  try {
    returnTo = await auth.exchangeSsoCode(code)
  } catch (e) {
    // A refused code (unknown, expired, already spent) ends on /login with the
    // category the API names, like every other SSO failure.
    const error = (e instanceof ApiError ? ssoErrorOf(e.details?.loginError) : null) ?? 'failed'
    await router.replace(`/login?error=${error}`)
    return
  }
  await router.replace(ownPath(returnTo))
})
</script>

<template>
  <div class="w-full max-w-[25rem]">
    <Card class="border-0 bg-transparent shadow-none sm:border sm:bg-card sm:shadow-sm">
      <CardHeader class="text-center">
        <h1 data-slot="card-title" class="leading-none font-semibold">{{ t('auth.logIn') }}</h1>
      </CardHeader>
      <CardContent class="space-y-4 text-sm">
        <p v-if="!failed" class="text-center text-muted-foreground" aria-live="polite">{{ t('auth.sso.completing') }}</p>
        <template v-else>
          <p class="text-destructive" aria-live="polite">{{ t('auth.sso.completeFailed') }}</p>
          <Button class="w-full" as-child>
            <RouterLink to="/login">{{ t('auth.backToLogin') }}</RouterLink>
          </Button>
        </template>
      </CardContent>
    </Card>
  </div>
</template>
