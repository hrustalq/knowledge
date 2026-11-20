<script setup lang="ts">
/**
 * The OAuth consent screen for MCP clients (#1352, docs/features/33). An AI
 * client opened this tab to sign its person in; they choose what it may do —
 * the same narrowing a key takes — and the browser goes back to the client
 * carrying a one-use code (or `access_denied`). The answer is a session-only
 * API call: a key or a client's own token can never approve a grant.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { BadgeCheck, TriangleAlert } from 'lucide-vue-next'
import type { ApiKeyScope, McpToolset, OAuthRequestView } from '@knowledge/contracts'
import { API_KEY_SCOPES, MCP_TOOLSET_KEYS, OAUTH_GRANT_DEFAULT_DAYS } from '@knowledge/contracts'
import { Button } from '@knowledge/ui/button'
import { Label } from '@knowledge/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@knowledge/ui/select'
import { Skeleton } from '@knowledge/ui/skeleton'
import { api } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { useWorkspacesStore } from '@/stores/workspaces'
import ChoiceCards from '../components/connect/ChoiceCards.vue'

const { t } = useI18n()
const route = useRoute()
const workspaces = useWorkspacesStore()

const ALL = 'all'
const EXPIRY_CHOICES = ['30', String(OAUTH_GRANT_DEFAULT_DAYS), '365'] as const
const PICKABLE = MCP_TOOLSET_KEYS.filter((key) => key !== 'core')

const requestId = typeof route.query.request === 'string' ? route.query.request : ''
const request = ref<OAuthRequestView | null>(null)
const loadError = ref<string | null>(null)
const form = reactive({
  scope: 'write' as ApiKeyScope,
  workspaceId: ALL,
  expiry: String(OAUTH_GRANT_DEFAULT_DAYS),
  limit: false,
  toolsets: [] as McpToolset[],
})
const busy = ref<'allow' | 'deny' | null>(null)
const leaving = ref(false)
const error = ref<string | null>(null)

const scopeOptions = computed(() =>
  API_KEY_SCOPES.map((s) => ({ value: s, label: t(`connect.keys.scopes.${s}`), hint: t(`connect.keys.scopeHint.${s}`) })),
)

function toggleToolset(key: McpToolset) {
  form.toolsets = form.toolsets.includes(key) ? form.toolsets.filter((k) => k !== key) : [...form.toolsets, key]
}

// Client-only: the request is single-use and short-lived, nothing an SSR pass should hold.
onMounted(async () => {
  if (!requestId) {
    loadError.value = t('connect.oauth.missing')
    return
  }
  try {
    request.value = await api.get('/v1/oauth/requests/{id}', { path: { id: requestId } })
  } catch (e) {
    loadError.value = errorMessage(e, t)
  }
})

async function answer(kind: 'allow' | 'deny') {
  busy.value = kind
  error.value = null
  try {
    const res =
      kind === 'allow'
        ? await api.post('/v1/oauth/requests/{id}/approve', {
            path: { id: requestId },
            body: {
              scope: form.scope,
              ...(form.workspaceId !== ALL ? { workspaceId: form.workspaceId } : {}),
              ...(form.limit ? { toolsets: form.toolsets } : {}),
              expiresInDays: Number(form.expiry),
            },
          })
        : await api.post('/v1/oauth/requests/{id}/deny', { path: { id: requestId } })
    leaving.value = true
    // A native client's custom scheme works here too; the code is single-use and expires in minutes.
    window.location.assign(res.redirect)
  } catch (e) {
    error.value = errorMessage(e, t)
    busy.value = null
  }
}
</script>

<template>
  <header class="flex h-14 shrink-0 items-center border-b px-4 lg:px-6">
    <p class="font-display text-base font-semibold tracking-tight">{{ t('connect.oauth.bar') }}</p>
  </header>

  <main class="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:py-12">
    <div class="mx-auto grid w-full max-w-lg gap-8">
      <div v-if="!request && !loadError" class="grid gap-4" aria-busy="true">
        <Skeleton class="h-8 w-2/3" />
        <Skeleton class="h-4 w-1/2" />
        <Skeleton class="h-64 rounded-xl" />
      </div>

      <div v-else-if="loadError" class="grid gap-3" role="alert">
        <h1 class="font-display text-xl font-semibold tracking-tight">{{ t('connect.oauth.goneTitle') }}</h1>
        <p class="kn-measure text-sm text-muted-foreground">{{ loadError }}</p>
        <RouterLink to="/settings/ai/connect" class="text-sm text-primary underline underline-offset-4">{{ t('connect.oauth.toConnect') }}</RouterLink>
      </div>

      <template v-else-if="request">
        <section class="grid gap-2">
          <h1 class="font-display text-2xl font-semibold tracking-tight text-balance">
            {{ t('connect.oauth.title', { client: request.client.name }) }}
          </h1>
          <p v-if="request.client.domain" class="flex items-center gap-1.5 text-sm text-muted-foreground">
            <BadgeCheck class="size-4 shrink-0 text-primary" aria-hidden="true" />
            <span>{{ t('connect.oauth.verified', { domain: request.client.domain }) }}</span>
          </p>
          <p v-else class="flex items-start gap-2 rounded-lg border kn-callout-warning p-3 text-xs text-panel-warning-ink">
            <TriangleAlert class="size-3.5 shrink-0 translate-y-0.5" aria-hidden="true" />
            <span>{{ t('connect.oauth.unverified') }}</span>
          </p>
          <p class="text-sm text-muted-foreground">
            {{ t('connect.oauth.returnTo') }} <span class="font-medium break-all text-foreground">{{ request.redirectTo }}</span>
          </p>
        </section>

        <form class="grid min-w-0 gap-6" @submit.prevent="answer('allow')">
          <ChoiceCards v-model="form.scope" name="kn-oauth-scope" :legend="t('connect.keys.scope')" :options="scopeOptions" />

          <div class="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="kn-oauth-ws" class="text-xs">{{ t('connect.keys.workspace') }}</Label>
              <Select v-model="form.workspaceId">
                <SelectTrigger id="kn-oauth-ws" class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem :value="ALL">{{ t('connect.keys.allWorkspaces') }}</SelectItem>
                  <SelectItem v-for="w in workspaces.items" :key="w.workspaceId" :value="w.workspaceId">{{ w.name }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="kn-oauth-exp" class="text-xs">{{ t('connect.keys.expiry') }}</Label>
              <Select v-model="form.expiry">
                <SelectTrigger id="kn-oauth-exp" class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="e in EXPIRY_CHOICES" :key="e" :value="e">{{ t('connect.keys.days', { n: e }) }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <fieldset class="grid gap-2">
            <legend class="sr-only">{{ t('connect.keys.toolsetPicker.legend') }}</legend>
            <label class="flex cursor-pointer items-start gap-2.5 text-sm">
              <input v-model="form.limit" type="checkbox" class="mt-0.5 size-4 shrink-0 accent-primary" />
              <span>{{ t('connect.oauth.limit') }}</span>
            </label>
            <div v-if="form.limit" class="grid gap-x-4 gap-y-2 pl-6.5 sm:grid-cols-2">
              <p class="text-xs text-muted-foreground sm:col-span-2">
                <span class="font-medium text-foreground">{{ t('connect.toolsets.core.label') }}</span> · {{ t('connect.keys.toolsetPicker.always') }}
              </p>
              <label v-for="key in PICKABLE" :key="key" class="flex min-w-0 cursor-pointer items-start gap-2.5">
                <input type="checkbox" class="mt-0.5 size-4 shrink-0 accent-primary" :checked="form.toolsets.includes(key)" @change="toggleToolset(key)" />
                <span class="min-w-0">
                  <span class="block text-sm">{{ t(`connect.toolsets.${key}.label`) }}</span>
                  <span class="block text-caption text-muted-foreground">{{ t(`connect.toolsets.${key}.description`) }}</span>
                </span>
              </label>
            </div>
            <p v-else class="pl-6.5 text-caption text-muted-foreground">{{ t('connect.wizard.key.unlimited') }}</p>
          </fieldset>

          <p v-if="error" class="text-sm text-destructive" role="alert">{{ error }}</p>
          <p v-if="leaving" class="text-sm text-muted-foreground" role="status">{{ t('connect.oauth.leaving', { client: request.client.name }) }}</p>

          <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" :disabled="busy !== null || leaving" @click="answer('deny')">
              {{ busy === 'deny' ? t('connect.oauth.denying') : t('connect.oauth.deny') }}
            </Button>
            <Button type="submit" :disabled="busy !== null || leaving">
              {{ busy === 'allow' ? t('connect.oauth.allowing') : t('connect.oauth.allow') }}
            </Button>
          </div>
        </form>
      </template>
    </div>
  </main>
</template>
