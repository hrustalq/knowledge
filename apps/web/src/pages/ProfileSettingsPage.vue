<script setup lang="ts">
/**
 * Your own account: name, language, password, API key.
 *
 * Four independent saves rather than one form with one Save, because these have
 * four different consequences — a rename is cosmetic, a language change reloads
 * the interface, a password change is a security event, and rotating a key
 * breaks every client using the old one. A single Save button would make them
 * look interchangeable.
 *
 * Independent saves are not four equal cards, though, which is what this page
 * used to be: a settings box for a two-button language preference carried the
 * same weight as one for a credential, and tiling them left a ragged row of
 * boxes at their own heights. They group by consequence instead — how you are
 * presented, and how you get in — and inside a group each setting is a
 * hairline-divided row: what it is and what it costs you, then the control.
 * Description-left / control-right was tried first and refused: two groups side
 * by side leave a card about 500px wide even at 1600, where an 18rem control
 * column crushes every hint into four lines. Separation is the rule and the
 * tonal step, not another container; the one thing that leads is the identity
 * lede, because it is the only element here with a face.
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
import AvatarPicker from '@/components/people/AvatarPicker.vue'

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
  <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-5">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('profileSettings.title') }}</h1>
      <p class="mt-1 text-sm text-muted-foreground">{{ t('profileSettings.subtitle') }}</p>
    </div>

    <!-- Two groups, side by side once the shell's own hinge opens. `items-start`
         so the shorter group ends where its content ends rather than stretching
         to match the taller one — an empty half-card would read as something
         that failed to load. -->
    <div v-if="auth.me" class="grid min-w-0 items-start gap-5 lg:grid-cols-2">
      <section class="min-w-0 rounded-xl border bg-card">
        <h2 class="border-b px-5 py-3.5 font-display text-[15px] font-semibold tracking-tight">
          {{ t('profileSettings.groups.profile') }}
        </h2>

        <ul class="divide-y">
          <!-- The lede. Deliberately not a description/control row: it is what
               everyone else sees of you, so it is shown rather than described,
               and it gets the group's generous interval against the tighter
               rows beneath it. The face and the name preview what the row below
               is editing — `name` is bound live, so both track as you type. -->
          <li class="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-5">
            <UserAvatar
              :user-id="auth.me.userId"
              :name="name || auth.me.displayName"
              :src="auth.me.avatarUrl"
              class="!size-12 !text-base"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate font-display text-base font-semibold tracking-tight">
                {{ name || auth.me.displayName }}
              </p>
              <p class="mt-0.5 text-xs text-muted-foreground">
                {{ t('profileSettings.name.email', { email: auth.me.email }) }}
                <RouterLink to="/u" class="text-primary underline-offset-2 hover:underline">
                  {{ t('profileSettings.name.viewProfile') }}
                </RouterLink>
              </p>
            </div>
            <!-- Saves on its own, like every row here: an upload has already
                 happened by the time it returns, so pairing it with the name's
                 Save button would claim otherwise. -->
            <AvatarPicker
              v-if="!auth.isDev"
              base="/v1/me"
              :has-image="auth.me.avatarUrl !== null"
              @changed="auth.reload()"
            />
            <p v-else class="text-xs text-muted-foreground">{{ t('avatar.hint') }}</p>
          </li>

          <li class="px-5 py-4">
            <div class="min-w-0">
              <h3 class="text-sm font-medium">{{ t('profileSettings.name.title') }}</h3>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ t('profileSettings.name.hint') }}</p>
            </div>
            <div class="mt-3 flex items-center gap-2">
              <Label for="kn-display-name" class="sr-only">{{ t('profileSettings.name.label') }}</Label>
              <Input
                id="kn-display-name"
                v-model="name"
                class="min-w-0 flex-1"
                :maxlength="120"
                :placeholder="auth.me.displayName"
                @keydown.enter="saveName"
              />
              <Button size="sm" class="shrink-0" :disabled="!nameDirty || savingName" @click="saveName">
                {{ savingName ? t('common.saving') : t('common.save') }}
              </Button>
            </div>
          </li>

          <li class="px-5 py-4">
            <div class="min-w-0">
              <h3 class="text-sm font-medium">{{ t('profileSettings.language.title') }}</h3>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ t('profileSettings.language.hint') }}</p>
            </div>
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
          </li>
        </ul>
      </section>

      <section class="min-w-0 rounded-xl border bg-card">
        <h2 class="border-b px-5 py-3.5 font-display text-[15px] font-semibold tracking-tight">
          {{ t('profileSettings.groups.signIn') }}
        </h2>

        <ul class="divide-y">
          <li class="px-5 py-4">
            <div class="min-w-0">
              <h3 class="text-sm font-medium">{{ t('profileSettings.password.title') }}</h3>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ t('profileSettings.password.hint') }}</p>
            </div>
            <div class="mt-3 grid gap-2.5">
              <div class="grid gap-1.5">
                <Label for="kn-pw-current" class="text-xs">{{ t('profileSettings.password.current') }}</Label>
                <Input id="kn-pw-current" v-model="current" type="password" autocomplete="current-password" />
              </div>
              <div class="grid gap-1.5">
                <Label for="kn-pw-next" class="text-xs">{{ t('profileSettings.password.next') }}</Label>
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
                <Label for="kn-pw-confirm" class="text-xs">{{ t('profileSettings.password.confirm') }}</Label>
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
                <Button size="sm" :disabled="!canSavePassword || savingPassword" @click="savePassword">
                  {{ savingPassword ? t('common.saving') : t('profileSettings.password.submit') }}
                </Button>
              </div>
            </div>
          </li>

          <li class="px-5 py-4">
            <div class="min-w-0">
              <h3 class="text-sm font-medium">{{ t('profileSettings.apiKey.title') }}</h3>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ t('profileSettings.apiKey.hint') }}</p>
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <span class="flex min-w-0 flex-1 items-start gap-2 text-xs text-muted-foreground">
                <KeyRound class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span class="min-w-0">{{ auth.me.mode === 'dev'
                  ? t('profileSettings.apiKey.devMode')
                  : t('profileSettings.apiKey.status') }}</span>
              </span>
              <Button
                v-if="auth.me.mode !== 'dev'"
                variant="outline"
                size="sm"
                class="shrink-0"
                :disabled="rotating"
                @click="rotate"
              >
                {{ rotating ? t('profileSettings.apiKey.rotating') : t('profileSettings.apiKey.rotate') }}
              </Button>
            </div>

            <!-- The one and only sighting of the value. -->
            <div v-if="freshKey" class="mt-3 rounded-lg border border-dashed p-3">
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
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
