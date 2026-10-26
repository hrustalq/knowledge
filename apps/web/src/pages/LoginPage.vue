<script setup lang="ts">
/**
 * Sign in. With SSO off this is the email + password form it always was. With
 * SSO on (#75) it is email-first: the address decides whether the next step is
 * a password or the organization's identity provider, and the workspace's
 * provider buttons sit under the form for anyone who would rather click one.
 *
 * The SSO probe runs in the browser only: until it answers, the page renders
 * the plain form, so SSR and the first client render agree.
 *
 * `?reauth=sso|session&workspaceId=` is how a workspace that enforces SSO
 * sends a password session here (#75 phase 4): the notice says why, and the
 * buttons are that workspace's providers rather than the remembered one's.
 *
 * An LDAP provider (#75 phase 7) has no identity provider to redirect to: its
 * button opens a username + password step in this card instead.
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { KeyRound } from 'lucide-vue-next'
import type { SsoLoginProvider, SsoProvidersResponse } from '@knowledge/contracts'
import { useAuthStore } from '@/stores/auth'
import { isApiRequestError } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { ownPath, reauthKindOf, ssoErrorOf, ssoStartUrl } from '@/lib/sso'
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

const redirect = computed(() => ownPath(route.query.redirect))
const callbackError = computed(() => ssoErrorOf(route.query.error))
const reauth = computed(() => reauthKindOf(route.query.reauth))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const providersFor = computed(() =>
  typeof route.query.workspaceId === 'string' && UUID.test(route.query.workspaceId) ? route.query.workspaceId : getWorkspaceId(),
)

/** null until probed, and stays null when SSO is off. */
const sso = ref<SsoProvidersResponse | null>(null)
/**
 * `email`: asking for the address; `password`: the address may use one; `sso`:
 * its domain belongs to a provider; `ldap`: directory credentials for `ldapProvider`.
 */
const step = ref<'email' | 'password' | 'sso' | 'ldap'>('email')
const matched = ref<SsoLoginProvider[]>([])
const passwordAllowed = ref(true)
/** The address's domain is verified and enforced: the password is gone for a reason the person can act on. */
const domainEnforced = ref(false)

onMounted(async () => {
  try {
    sso.value = await auth.ssoProviders(providersFor.value)
  } catch {
    sso.value = null // a failed probe leaves the password form, which still works
  }
})

const emailFirst = computed(() => sso.value !== null)
const showPassword = computed(() => !emailFirst.value || step.value === 'password')

async function submit() {
  busy.value = true
  try {
    if (emailFirst.value && step.value === 'email') {
      const found = await auth.discover(email.value)
      matched.value = found.providers
      passwordAllowed.value = found.passwordAllowed
      domainEnforced.value = found.enforced
      step.value = found.method === 'sso' ? 'sso' : 'password'
      return
    }
    await auth.login(email.value, password.value)
    await router.push(redirect.value)
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = false
  }
}

function changeEmail() {
  step.value = 'email'
  password.value = ''
  matched.value = []
}

const startUrl = (p: SsoLoginProvider) => ssoStartUrl(p.id, redirect.value, p.kind)

const ldapProvider = ref<SsoLoginProvider | null>(null)
const username = ref('')

/** A redirect provider is a link to its start route; an LDAP one opens the credentials step here. */
const providerButton = (p: SsoLoginProvider) =>
  p.kind === 'ldap' ? { as: 'button', type: 'button', onClick: () => openLdap(p) } : { as: 'a', href: startUrl(p) }

function openLdap(p: SsoLoginProvider) {
  ldapProvider.value = p
  username.value = email.value
  password.value = ''
  step.value = 'ldap'
  // The step replaces the button that was focused; keep the keyboard where the typing goes.
  void nextTick(() => document.getElementById(username.value ? 'ldap-password' : 'ldap-username')?.focus())
}

function leaveLdap() {
  password.value = ''
  step.value = matched.value.length ? 'sso' : 'email'
}

async function submitLdap() {
  if (!ldapProvider.value) return
  busy.value = true
  try {
    await auth.ldapLogin(ldapProvider.value.id, username.value, password.value)
    await router.push(redirect.value)
  } catch (e) {
    // A refusal after the directory accepted the password names its reason the way a failed redirect does.
    const reason = isApiRequestError(e) ? ssoErrorOf(e.details?.loginError) : null
    toast.error(reason ? t(`auth.sso.errors.${reason}`) : (e as Error).message)
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
        <p
          v-if="callbackError"
          role="alert"
          class="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {{ t(`auth.sso.errors.${callbackError}`) }}
        </p>
        <p v-else-if="reauth" role="status" class="mb-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          {{ t(`auth.sso.reauth.${reauth}`) }}
        </p>

        <!-- The address belongs to an identity provider. -->
        <div v-if="emailFirst && step === 'sso'" class="space-y-3">
          <p class="text-sm text-muted-foreground">{{ t('auth.sso.domainUsesSso', { email }) }}</p>
          <Button v-for="p in matched" :key="p.id" v-bind="providerButton(p)" class="w-full">
            <KeyRound class="size-4" aria-hidden="true" />
            {{ t('auth.sso.continueWith', { name: p.name }) }}
          </Button>
          <div class="flex items-center justify-between text-sm text-muted-foreground">
            <button type="button" class="-mx-2 inline-flex min-h-11 items-center px-2 hover:text-foreground hover:underline" @click="changeEmail">
              {{ t('auth.sso.changeEmail') }}
            </button>
            <button
              v-if="passwordAllowed"
              type="button"
              class="-mx-2 inline-flex min-h-11 items-center px-2 hover:text-foreground hover:underline"
              @click="step = 'password'"
            >
              {{ t('auth.sso.usePassword') }}
            </button>
          </div>
        </div>

        <!-- A directory provider: its own username and password, checked by the API against the directory. -->
        <form v-else-if="step === 'ldap' && ldapProvider" class="space-y-3" @submit.prevent="submitLdap">
          <div class="space-y-1">
            <h2 class="text-sm font-medium">{{ t('auth.sso.ldapTitle', { name: ldapProvider.name }) }}</h2>
            <p class="text-sm text-muted-foreground">{{ t('auth.sso.ldapHint') }}</p>
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="ldap-username">{{ t('auth.sso.username') }}</label>
            <Input id="ldap-username" v-model="username" required maxlength="256" autocomplete="username" autocapitalize="none" spellcheck="false" />
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="ldap-password">{{ t('auth.password') }}</label>
            <Input id="ldap-password" v-model="password" type="password" required autocomplete="current-password" />
          </div>
          <Button class="w-full" type="submit" :disabled="busy">{{ busy ? t('auth.signingIn') : t('auth.logIn') }}</Button>
          <div class="text-sm text-muted-foreground">
            <button type="button" class="-mx-2 inline-flex min-h-11 items-center px-2 hover:text-foreground hover:underline" @click="leaveLdap">
              {{ t('auth.sso.back') }}
            </button>
          </div>
        </form>

        <form v-else class="space-y-3" @submit.prevent="submit">
          <div class="space-y-1">
            <label class="text-sm font-medium" for="email">{{ t('auth.email') }}</label>
            <Input
              id="email"
              v-model="email"
              type="email"
              required
              autocomplete="email"
              placeholder="you@example.com"
              :readonly="emailFirst && step === 'password'"
            />
          </div>
          <template v-if="showPassword">
            <p v-if="emailFirst && !passwordAllowed" class="text-sm text-muted-foreground">{{ t(domainEnforced ? 'auth.sso.domainEnforced' : 'auth.sso.passwordDisabled') }}</p>
            <div v-else class="space-y-1">
              <label class="text-sm font-medium" for="password">{{ t('auth.password') }}</label>
              <Input id="password" v-model="password" type="password" required autocomplete="current-password" />
            </div>
          </template>
          <Button v-if="!showPassword" class="w-full" type="submit" :disabled="busy">
            {{ busy ? t('auth.sso.checking') : t('auth.sso.continue') }}
          </Button>
          <Button v-else-if="!emailFirst || passwordAllowed" class="w-full" type="submit" :disabled="busy">
            {{ busy ? t('auth.signingIn') : t('auth.logIn') }}
          </Button>
        </form>

        <!-- `min-h-11` is the touch target, and the negative inline margin
             keeps it from pushing the two links away from the form's edges. -->
        <div v-if="step === 'email' || step === 'password'" class="mt-1 flex items-center justify-between text-sm text-muted-foreground">
          <button
            v-if="emailFirst && step === 'password'"
            type="button"
            class="-mx-2 inline-flex min-h-11 items-center px-2 hover:text-foreground hover:underline"
            @click="changeEmail"
          >
            {{ t('auth.sso.changeEmail') }}
          </button>
          <RouterLink v-else class="-mx-2 inline-flex min-h-11 items-center px-2 hover:text-foreground hover:underline" to="/forgot-password">{{ t('auth.forgotPassword') }}</RouterLink>
          <RouterLink class="-mx-2 inline-flex min-h-11 items-center px-2 hover:text-foreground hover:underline" to="/signup">{{ t('auth.createAccount') }}</RouterLink>
        </div>

        <!-- The workspace's providers, for anyone who would rather click than type. -->
        <div v-if="emailFirst && step === 'email' && sso && sso.providers.length" class="mt-4 space-y-2">
          <div class="flex items-center gap-3 text-xs text-muted-foreground">
            <span class="h-px flex-1 bg-border" />{{ t('auth.sso.or') }}<span class="h-px flex-1 bg-border" />
          </div>
          <Button v-for="p in sso.providers" :key="p.id" v-bind="providerButton(p)" variant="outline" class="w-full">
            <KeyRound class="size-4" aria-hidden="true" />
            {{ t('auth.sso.continueWith', { name: p.name }) }}
          </Button>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
