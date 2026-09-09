<script setup lang="ts">
/**
 * Your own account: name, language, password, API key.
 *
 * Four independent sections rather than one form with one Save, because these
 * have four different consequences — a rename is cosmetic, a language change
 * reloads the interface, a password change is a security event, and rotating a
 * key breaks every client using the old one. A single Save button would make
 * them look interchangeable.
 *
 * Everything here acts on the caller and takes no user id; renaming somebody
 * else is a platform-admin act and lives in /settings/users.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'
import { Check, Copy, KeyRound, TriangleAlert } from 'lucide-vue-next'
import { SUPPORTED_LOCALES, type Locale, type MeResponse, type RotateApiKeyResponse } from '@knowledge/contracts'
import { apiFetch, getLocale, setLocale } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import UserAvatar from '@/components/merge-requests/UserAvatar.vue'

const { t, locale } = useI18n()
const auth = useAuthStore()

const LOCALE_LABELS: Record<Locale, string> = { en: 'English', ru: 'Русский' }

// --- display name --------------------------------------------------------

const name = ref('')
watch(() => auth.me?.displayName, (v) => { name.value = v ?? '' }, { immediate: true })

const nameDirty = computed(
  () => name.value.trim().length > 0 && name.value.trim() !== (auth.me?.displayName ?? ''),
)
const savingName = ref(false)

async function saveName() {
  if (!nameDirty.value) return
  savingName.value = true
  try {
    const me = await apiFetch<MeResponse>('/v1/me', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: name.value.trim() }),
    })
    auth.adopt(me)
    toast.success(t('profileSettings.name.saved'))
  } catch {
    toast.error(t('profileSettings.name.failed'))
  } finally {
    savingName.value = false
  }
}

// --- language ------------------------------------------------------------
// Same three writes the topbar switcher makes (cookie, live i18n, users.locale)
// so the two controls cannot leave the app in different states.

const activeLocale = computed(() => (locale.value as Locale) ?? getLocale())

async function chooseLocale(next: Locale) {
  if (next === activeLocale.value) return
  setLocale(next)
  locale.value = next
  if (typeof document !== 'undefined') document.documentElement.lang = next
  await auth.saveLocale(next)
}

// --- password ------------------------------------------------------------

const current = ref('')
const next = ref('')
const confirm = ref('')
const savingPassword = ref(false)

const passwordProblem = computed(() => {
  if (!next.value) return null
  if (next.value.length < 8) return t('profileSettings.password.tooShort')
  if (confirm.value && next.value !== confirm.value) return t('profileSettings.password.mismatch')
  return null
})
const canSavePassword = computed(
  () => current.value.length > 0 && next.value.length >= 8 && next.value === confirm.value,
)

async function savePassword() {
  if (!canSavePassword.value) return
  savingPassword.value = true
  try {
    await apiFetch('/v1/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: current.value, newPassword: next.value }),
    })
    current.value = ''
    next.value = ''
    confirm.value = ''
    toast.success(t('profileSettings.password.saved'))
  } catch {
    toast.error(t('profileSettings.password.failed'))
  } finally {
    savingPassword.value = false
  }
}

// --- api key -------------------------------------------------------------
// Shown once and never again: only the SHA-256 reaches PostgreSQL, so there is
// nothing to come back for. The UI has to say so before the key is minted, not
// after — a "copy this now" notice that arrives with the value is a warning
// nobody had the chance to act on.

const rotating = ref(false)
const freshKey = ref<string | null>(null)
const copied = ref(false)

async function rotate() {
  rotating.value = true
  try {
    const res = await apiFetch<RotateApiKeyResponse>('/v1/me/api-key', { method: 'POST' })
    freshKey.value = res.apiKey
    copied.value = false
    await auth.reload()
  } catch {
    toast.error(t('profileSettings.apiKey.failed'))
  } finally {
    rotating.value = false
  }
}

async function copyKey() {
  if (!freshKey.value) return
  try {
    await navigator.clipboard.writeText(freshKey.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    toast.error(t('profileSettings.apiKey.copyFailed'))
  }
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-5">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('profileSettings.title') }}</h1>
      <p class="mt-1 text-sm text-muted-foreground">{{ t('profileSettings.subtitle') }}</p>
    </div>

    <div v-if="auth.me" class="flex max-w-2xl flex-col gap-5">
      <!-- Identity -->
      <section class="rounded-xl border bg-card p-5">
        <div class="flex items-start gap-4">
          <UserAvatar :user-id="auth.me.userId" :name="name || auth.me.displayName" class="!size-12 !text-base" />
          <div class="min-w-0 flex-1">
            <h2 class="font-display text-[15px] font-semibold tracking-tight">
              {{ t('profileSettings.name.title') }}
            </h2>
            <p class="mt-0.5 text-xs text-muted-foreground">
              {{ t('profileSettings.name.hint') }}
            </p>
            <div class="mt-3 flex flex-wrap items-end gap-2">
              <div class="min-w-48 flex-1">
                <Label for="kn-display-name" class="sr-only">{{ t('profileSettings.name.label') }}</Label>
                <Input
                  id="kn-display-name"
                  v-model="name"
                  :maxlength="120"
                  :placeholder="auth.me.displayName"
                  @keydown.enter="saveName"
                />
              </div>
              <Button :disabled="!nameDirty || savingName" @click="saveName">
                {{ savingName ? t('common.saving') : t('common.save') }}
              </Button>
            </div>
            <p class="mt-2 text-xs text-muted-foreground">
              {{ t('profileSettings.name.email', { email: auth.me.email }) }}
              <RouterLink to="/u" class="text-primary underline-offset-2 hover:underline">
                {{ t('profileSettings.name.viewProfile') }}
              </RouterLink>
            </p>
          </div>
        </div>
      </section>

      <!-- Language -->
      <section class="rounded-xl border bg-card p-5">
        <h2 class="font-display text-[15px] font-semibold tracking-tight">
          {{ t('profileSettings.language.title') }}
        </h2>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t('profileSettings.language.hint') }}</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <!-- A language is named in itself, never translated. -->
          <Button
            v-for="code in SUPPORTED_LOCALES"
            :key="code"
            :variant="code === activeLocale ? 'default' : 'outline'"
            size="sm"
            :aria-pressed="code === activeLocale"
            @click="chooseLocale(code)"
          >{{ LOCALE_LABELS[code] }}</Button>
        </div>
      </section>

      <!-- Password -->
      <section class="rounded-xl border bg-card p-5">
        <h2 class="font-display text-[15px] font-semibold tracking-tight">
          {{ t('profileSettings.password.title') }}
        </h2>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t('profileSettings.password.hint') }}</p>
        <div class="mt-3 grid gap-3 sm:max-w-sm">
          <div class="grid gap-1.5">
            <Label for="kn-pw-current">{{ t('profileSettings.password.current') }}</Label>
            <Input id="kn-pw-current" v-model="current" type="password" autocomplete="current-password" />
          </div>
          <div class="grid gap-1.5">
            <Label for="kn-pw-next">{{ t('profileSettings.password.next') }}</Label>
            <Input
              id="kn-pw-next"
              v-model="next"
              type="password"
              autocomplete="new-password"
              :aria-invalid="passwordProblem !== null || undefined"
              :aria-describedby="passwordProblem ? 'kn-pw-problem' : undefined"
            />
          </div>
          <div class="grid gap-1.5">
            <Label for="kn-pw-confirm">{{ t('profileSettings.password.confirm') }}</Label>
            <Input
              id="kn-pw-confirm"
              v-model="confirm"
              type="password"
              autocomplete="new-password"
              :aria-invalid="passwordProblem !== null || undefined"
            />
          </div>
          <p v-if="passwordProblem" id="kn-pw-problem" class="text-xs text-destructive">
            {{ passwordProblem }}
          </p>
          <div>
            <Button :disabled="!canSavePassword || savingPassword" @click="savePassword">
              {{ savingPassword ? t('common.saving') : t('profileSettings.password.submit') }}
            </Button>
          </div>
        </div>
      </section>

      <!-- API key -->
      <section class="rounded-xl border bg-card p-5">
        <h2 class="font-display text-[15px] font-semibold tracking-tight">
          {{ t('profileSettings.apiKey.title') }}
        </h2>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t('profileSettings.apiKey.hint') }}</p>

        <div class="mt-3 flex flex-wrap items-center gap-3">
          <span class="flex items-center gap-2 text-sm">
            <KeyRound class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ auth.me.mode === 'dev'
              ? t('profileSettings.apiKey.devMode')
              : t('profileSettings.apiKey.status') }}
          </span>
          <Button
            v-if="auth.me.mode !== 'dev'"
            variant="outline"
            size="sm"
            :disabled="rotating"
            @click="rotate"
          >
            {{ rotating ? t('profileSettings.apiKey.rotating') : t('profileSettings.apiKey.rotate') }}
          </Button>
        </div>

        <!-- The warning is part of the button's own line above; this block is
             the one and only sighting of the value. -->
        <div v-if="freshKey" class="mt-4 rounded-lg border border-dashed p-3">
          <p class="flex items-start gap-2 text-xs text-muted-foreground">
            <TriangleAlert class="size-3.5 shrink-0 translate-y-0.5" aria-hidden="true" />
            <span>{{ t('profileSettings.apiKey.onceOnly') }}</span>
          </p>
          <div class="mt-2 flex items-center gap-2">
            <code class="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{{ freshKey }}</code>
            <Button variant="outline" size="sm" @click="copyKey">
              <Check v-if="copied" class="size-3.5" />
              <Copy v-else class="size-3.5" />
              {{ copied ? t('common.copied') : t('common.copy') }}
            </Button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
