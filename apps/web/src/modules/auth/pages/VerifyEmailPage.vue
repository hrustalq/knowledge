<script setup lang="ts">
/**
 * /verify-email (docs/features/41) — two jobs on one card.
 *
 * With `?token=` it is where the mailed link lands: redeem it, then offer the
 * way on. Without one it is the waiting room for a signed-in, unconfirmed
 * account — the router sends everybody here while AUTH_REQUIRE_VERIFIED_EMAIL
 * is on, so it must work with nothing but /me, resend and sign-out.
 */
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { api } from '@/shared/api/queries'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '@/shared/ui/card'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const token = computed(() => (typeof route.query.token === 'string' ? route.query.token : ''))
/** Only meaningful with a token; the redeem runs after hydration, never during SSR. */
const state = ref<'checking' | 'done' | 'failed'>('checking')
const busy = ref(false)
const debugToken = ref<string | null>(null)

onMounted(async () => {
  if (!token.value) return
  try {
    await api.post('/v1/auth/verify-email', { body: { token: token.value } })
    state.value = 'done'
    if (auth.authenticated) await auth.reload()
  } catch {
    state.value = 'failed'
  }
})

async function resend() {
  busy.value = true
  try {
    const res = await api.post('/v1/auth/resend-verification')
    if (res.alreadyVerified) {
      toast.success(t('auth.verifyAlready'))
      await auth.reload()
    } else {
      toast.success(t('auth.verifyResent'))
      debugToken.value = res.debugToken ?? null
    }
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = false
  }
}

async function signOut() {
  await auth.logout()
  await router.push('/login')
}
</script>

<template>
  <div class="w-full max-w-[25rem]">
    <Card class="border-0 bg-transparent shadow-none sm:border sm:bg-card sm:shadow-sm">
      <CardHeader class="text-center">
        <h1 data-slot="card-title" class="leading-none font-semibold">{{ t('auth.verifyTitle') }}</h1>
        <CardDescription v-if="!token && auth.me?.emailVerificationRequired && !auth.me.emailVerified">
          {{ t('auth.verifyRequiredHint') }}
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4 text-sm">
        <template v-if="token">
          <p v-if="state === 'checking'" class="text-muted-foreground" aria-live="polite">{{ t('auth.verifyChecking') }}</p>
          <p v-else-if="state === 'done'" aria-live="polite">{{ t('auth.verifyDone') }}</p>
          <p v-else class="text-destructive" aria-live="polite">{{ t('auth.verifyFailed') }}</p>
          <Button v-if="state !== 'checking'" class="w-full" as-child>
            <RouterLink :to="auth.authenticated ? '/documents' : '/login'">
              {{ auth.authenticated ? t('auth.verifyContinue') : t('auth.backToLogin') }}
            </RouterLink>
          </Button>
          <Button v-if="state === 'failed' && auth.authenticated && !auth.me?.emailVerified" class="w-full" variant="outline" :disabled="busy" @click="resend">
            {{ busy ? t('auth.sending') : t('auth.verifyResend') }}
          </Button>
        </template>

        <template v-else-if="auth.authenticated && auth.me && !auth.me.emailVerified">
          <p>{{ t('auth.verifyPending', { email: auth.me.email }) }}</p>
          <Button class="w-full" :disabled="busy" @click="resend">
            {{ busy ? t('auth.sending') : t('auth.verifyResend') }}
          </Button>
          <p v-if="debugToken" class="text-xs text-muted-foreground">
            {{ t('auth.devModeToken') }}
            <RouterLink class="underline" :to="{ path: '/verify-email', query: { token: debugToken } }">{{ t('auth.useItNow') }}</RouterLink>
          </p>
          <Button class="w-full" variant="ghost" @click="signOut">{{ t('auth.verifySignOut') }}</Button>
        </template>

        <template v-else-if="auth.authenticated">
          <p>{{ t('auth.verifyAlready') }}</p>
          <Button class="w-full" as-child>
            <RouterLink to="/documents">{{ t('auth.verifyContinue') }}</RouterLink>
          </Button>
        </template>

        <template v-else>
          <p class="text-muted-foreground">{{ t('auth.verifyFailed') }}</p>
          <Button class="w-full" as-child>
            <RouterLink to="/login">{{ t('auth.backToLogin') }}</RouterLink>
          </Button>
        </template>
      </CardContent>
    </Card>
  </div>
</template>
