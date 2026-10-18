<script setup lang="ts">
/**
 * Settings → Security → Providers (#75): a workspace's OpenID Connect
 * providers. The client secret is write-only — the API returns `hasSecret`
 * and nothing more, so the field is always empty and says whether one is
 * stored. The redirect URI is shown for copying into the IdP's client.
 *
 * With AUTH_SSO_ENABLED off the list route answers 404, and the panel says
 * so rather than offering a form that could never sign anyone in.
 */
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Copy, KeyRound, Plus } from 'lucide-vue-next'
import {
  IDP_PRESETS,
  WORKSPACE_ROLES,
  type IdentityProviderView,
  type IdpPreset,
  type ListIdentityProvidersResponse,
  type TestIdentityProviderResponse,
  type WorkspaceRole,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { ApiRequestError } from '@/api/http'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { useCopy } from '@/lib/use-copy'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PageState } from '@/components/layout/page'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const { t } = useI18n()
const auth = useAuthStore()
const workspaceId = getWorkspaceId()
const path = { id: workspaceId }

const list = useQuery({
  ...apiQueryOptions('/v1/workspaces/{id}/identity-providers', { path }),
  retry: false,
})
const data = computed(() => list.data.value as ListIdentityProvidersResponse | undefined)
const ssoOff = computed(() => list.error.value instanceof ApiRequestError && list.error.value.status === 404)

const invalidates = () => [['/v1/workspaces/{id}/identity-providers']]
const create = useApiMutation('post', '/v1/workspaces/{id}/identity-providers', { invalidates })
const update = useApiMutation('patch', '/v1/workspaces/{id}/identity-providers/{providerId}', { invalidates })
const remove = useApiMutation('delete', '/v1/workspaces/{id}/identity-providers/{providerId}', { invalidates })
const test = useApiMutation('post', '/v1/workspaces/{id}/identity-providers/{providerId}/test')

/** Presets that are one IdP each: their issuer is fixed, so there is no field for it. */
const FIXED_ISSUER: IdpPreset[] = ['google', 'yandex']
/** Example values shown in empty fields — technical spellings, the same in every language. */
const EXAMPLES = { domains: 'corp.example', scopes: 'email profile', groupsClaim: 'groups' }
/** A Select item cannot carry the empty string, so "no default role" needs a value of its own. */
const NO_ROLE = '__none__'

const blank = () => ({
  preset: 'keycloak' as IdpPreset,
  name: '',
  issuer: '',
  clientId: '',
  clientSecret: '',
  scopes: '',
  allowedDomains: '',
  jitEnabled: false,
  defaultRole: NO_ROLE as WorkspaceRole | typeof NO_ROLE,
  groupsClaim: '',
  sessionTtlHours: '',
  enabled: false,
  showOnLogin: true,
  platformWide: false,
})

const open = ref(false)
const editing = ref<IdentityProviderView | null>(null)
const form = reactive(blank())
const clearSecret = ref(false)

function startCreate() {
  editing.value = null
  Object.assign(form, blank())
  clearSecret.value = false
  open.value = true
}

function startEdit(p: IdentityProviderView) {
  editing.value = p
  Object.assign(form, {
    preset: p.preset,
    name: p.name,
    issuer: p.config.issuer,
    clientId: p.config.clientId,
    clientSecret: '',
    scopes: p.config.scopes.join(' '),
    allowedDomains: p.allowedDomains.join(', '),
    jitEnabled: p.jitEnabled,
    defaultRole: p.defaultRole ?? NO_ROLE,
    groupsClaim: p.groupsClaim ?? '',
    sessionTtlHours: p.sessionTtlHours ? String(p.sessionTtlHours) : '',
    enabled: p.enabled,
    showOnLogin: p.showOnLogin,
    platformWide: p.platformWide,
  })
  clearSecret.value = false
  open.value = true
}

const split = (s: string, by: RegExp) => s.split(by).map((x) => x.trim()).filter(Boolean)

function body() {
  const ttl = Number.parseInt(form.sessionTtlHours, 10)
  return {
    preset: form.preset,
    name: form.name.trim(),
    ...(FIXED_ISSUER.includes(form.preset) ? {} : { issuer: form.issuer.trim() }),
    clientId: form.clientId.trim(),
    scopes: split(form.scopes, /[\s,]+/),
    allowedDomains: split(form.allowedDomains, /[\s,]+/),
    jitEnabled: form.jitEnabled,
    defaultRole: form.defaultRole === NO_ROLE ? null : form.defaultRole,
    groupsClaim: form.groupsClaim.trim() || null,
    sessionTtlHours: Number.isFinite(ttl) && ttl > 0 ? ttl : null,
    enabled: form.enabled,
    showOnLogin: form.showOnLogin,
    // Only a platform admin may change it; anyone else sends it unchanged.
    ...(auth.isAdmin ? { platformWide: form.platformWide } : {}),
    // Write-only: a value sets it, '' clears it, absent keeps what is stored.
    ...(form.clientSecret ? { clientSecret: form.clientSecret } : clearSecret.value ? { clientSecret: '' } : {}),
  }
}

async function save() {
  try {
    if (editing.value) {
      await update.mutateAsync({ path: { ...path, providerId: editing.value.id }, body: body() })
    } else {
      await create.mutateAsync({ path, body: { kind: 'oidc', ...body() } })
    }
    toast.success(t('security.providers.saved'))
    open.value = false
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function runTest(p: IdentityProviderView) {
  try {
    const res = (await test.mutateAsync({ path: { ...path, providerId: p.id } })) as TestIdentityProviderResponse
    if (res.ok) toast.success(t('security.providers.testOk', { issuer: res.issuer ?? '' }))
    else toast.error(t('security.providers.testFailed', { error: res.error ?? '' }))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function confirmRemove(p: IdentityProviderView) {
  // A native confirm keeps this one destructive action from needing its own dialog state.
  if (!window.confirm(t('security.providers.removeConfirm', { name: p.name }))) return
  try {
    await remove.mutateAsync({ path: { ...path, providerId: p.id } })
    toast.success(t('security.providers.removed'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

const { state: copyState, copy } = useCopy()
const busy = computed(() => create.isPending.value || update.isPending.value)
</script>

<template>
  <section class="flex flex-col gap-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-base font-semibold">{{ t('security.providers.title') }}</h2>
        <p class="mt-0.5 max-w-prose text-sm text-muted-foreground">{{ t('security.providers.hint') }}</p>
      </div>
      <Button v-if="data" size="sm" @click="startCreate">
        <Plus class="size-4" aria-hidden="true" />{{ t('security.providers.add') }}
      </Button>
    </div>

    <p v-if="ssoOff" class="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
      {{ t('security.providers.disabled') }}
    </p>
    <PageState v-else-if="list.isPending.value" state="loading" :rows="2" row-class="h-16" />
    <PageState v-else-if="list.isError.value" state="error" :error="list.error.value" />
    <p v-else-if="!data?.providers.length" class="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
      {{ t('security.providers.empty') }}
    </p>

    <ul v-else class="divide-y rounded-md border">
      <li v-for="p in data.providers" :key="p.id" class="flex flex-col gap-2 px-4 py-3">
        <div class="flex flex-wrap items-center gap-2">
          <KeyRound class="size-4 text-muted-foreground" aria-hidden="true" />
          <span class="font-medium">{{ p.name }}</span>
          <Badge variant="outline">{{ t(`security.providers.presets.${p.preset}`) }}</Badge>
          <Badge :variant="p.enabled ? 'default' : 'secondary'">
            {{ p.enabled ? t('security.providers.enabled') : t('security.providers.disabledBadge') }}
          </Badge>
          <Badge v-if="p.platformWide" variant="outline">{{ t('security.providers.platformWide') }}</Badge>
          <Badge v-if="p.jitEnabled" variant="outline">{{ t('security.providers.jitBadge') }}</Badge>
          <div class="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" :disabled="test.isPending.value" @click="runTest(p)">{{ t('security.providers.test') }}</Button>
            <Button size="sm" variant="ghost" @click="startEdit(p)">{{ t('security.providers.edit') }}</Button>
            <Button size="sm" variant="ghost" class="text-destructive" @click="confirmRemove(p)">{{ t('security.providers.remove') }}</Button>
          </div>
        </div>
        <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span class="min-w-0 truncate">{{ p.config.issuer }}</span>
          <span v-if="p.allowedDomains.length">{{ t('security.providers.domainsList', { domains: p.allowedDomains.join(', ') }) }}</span>
        </div>
        <div class="flex min-w-0 items-center gap-2 text-xs">
          <span class="shrink-0 text-muted-foreground">{{ t('security.providers.redirectUri') }}</span>
          <code class="min-w-0 truncate rounded bg-muted px-1.5 py-0.5">{{ p.redirectUri }}</code>
          <Button size="icon" variant="ghost" class="size-7 shrink-0" :aria-label="t('security.providers.copy')" @click="copy(p.redirectUri)">
            <Copy class="size-3.5" aria-hidden="true" />
          </Button>
          <span v-if="copyState !== 'idle'" class="text-muted-foreground" aria-live="polite">
            {{ copyState === 'copied' ? t('security.providers.copied') : t('security.providers.copyFailed') }}
          </span>
        </div>
      </li>
    </ul>

    <Dialog v-model:open="open">
      <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ editing ? t('security.providers.editTitle') : t('security.providers.addTitle') }}</DialogTitle>
          <DialogDescription>{{ t('security.providers.formHint') }}</DialogDescription>
        </DialogHeader>
        <form id="idp-form" class="grid gap-3" @submit.prevent="save">
          <div class="grid gap-1">
            <label class="text-sm font-medium" for="idp-preset">{{ t('security.providers.preset') }}</label>
            <Select v-model="form.preset">
              <SelectTrigger id="idp-preset"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="preset in IDP_PRESETS" :key="preset" :value="preset">{{ t(`security.providers.presets.${preset}`) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-1">
            <label class="text-sm font-medium" for="idp-name">{{ t('security.providers.name') }}</label>
            <Input id="idp-name" v-model="form.name" required maxlength="80" :placeholder="t('security.providers.namePlaceholder')" />
          </div>
          <div v-if="!FIXED_ISSUER.includes(form.preset)" class="grid gap-1">
            <label class="text-sm font-medium" for="idp-issuer">{{ t('security.providers.issuer') }}</label>
            <Input id="idp-issuer" v-model="form.issuer" required type="url" :placeholder="t(`security.providers.issuerPlaceholder.${form.preset}`)" />
          </div>
          <div class="grid gap-1">
            <label class="text-sm font-medium" for="idp-client">{{ t('security.providers.clientId') }}</label>
            <Input id="idp-client" v-model="form.clientId" required autocomplete="off" />
          </div>
          <div class="grid gap-1">
            <label class="text-sm font-medium" for="idp-secret">{{ t('security.providers.clientSecret') }}</label>
            <Input
              id="idp-secret"
              v-model="form.clientSecret"
              type="password"
              autocomplete="new-password"
              :disabled="data && !data.secretsWritable"
              :placeholder="editing?.hasSecret ? t('security.providers.secretStored') : t('security.providers.secretNone')"
            />
            <p v-if="data && !data.secretsWritable" class="text-xs text-muted-foreground">{{ t('security.providers.secretsNotWritable') }}</p>
            <label v-else-if="editing?.hasSecret" class="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox :model-value="clearSecret" @update:model-value="clearSecret = !!$event" />{{ t('security.providers.clearSecret') }}
            </label>
          </div>
          <div class="grid gap-1">
            <label class="text-sm font-medium" for="idp-domains">{{ t('security.providers.allowedDomains') }}</label>
            <Input id="idp-domains" v-model="form.allowedDomains" :placeholder="EXAMPLES.domains" />
            <p class="text-xs text-muted-foreground">{{ t('security.providers.allowedDomainsHint') }}</p>
          </div>
          <label class="flex items-start gap-2 text-sm">
            <Checkbox class="mt-0.5" :model-value="form.jitEnabled" @update:model-value="form.jitEnabled = !!$event" />
            <span>{{ t('security.providers.jit') }}<span class="block text-xs text-muted-foreground">{{ t('security.providers.jitHint') }}</span></span>
          </label>
          <div class="grid gap-1">
            <label class="text-sm font-medium" for="idp-role">{{ t('security.providers.defaultRole') }}</label>
            <Select v-model="form.defaultRole">
              <SelectTrigger id="idp-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="NO_ROLE">{{ t('security.providers.noRole') }}</SelectItem>
                <SelectItem v-for="role in WORKSPACE_ROLES" :key="role" :value="role">{{ t(`role.${role}`) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <details class="text-sm">
            <summary class="cursor-pointer text-muted-foreground">{{ t('security.providers.advanced') }}</summary>
            <div class="mt-3 grid gap-3">
              <div class="grid gap-1">
                <label class="text-sm font-medium" for="idp-scopes">{{ t('security.providers.scopes') }}</label>
                <Input id="idp-scopes" v-model="form.scopes" :placeholder="EXAMPLES.scopes" />
              </div>
              <div class="grid gap-1">
                <label class="text-sm font-medium" for="idp-groups">{{ t('security.providers.groupsClaim') }}</label>
                <Input id="idp-groups" v-model="form.groupsClaim" :placeholder="EXAMPLES.groupsClaim" />
              </div>
              <div class="grid gap-1">
                <label class="text-sm font-medium" for="idp-ttl">{{ t('security.providers.sessionTtl') }}</label>
                <Input id="idp-ttl" v-model="form.sessionTtlHours" type="number" min="1" max="8760" :placeholder="t('security.providers.sessionTtlDefault')" />
              </div>
              <label class="flex items-center gap-2">
                <Checkbox :model-value="form.showOnLogin" @update:model-value="form.showOnLogin = !!$event" />{{ t('security.providers.showOnLogin') }}
              </label>
              <label v-if="auth.isAdmin" class="flex items-center gap-2">
                <Checkbox :model-value="form.platformWide" @update:model-value="form.platformWide = !!$event" />{{ t('security.providers.platformWideToggle') }}
              </label>
            </div>
          </details>
          <label class="flex items-center gap-2 text-sm font-medium">
            <Checkbox :model-value="form.enabled" @update:model-value="form.enabled = !!$event" />{{ t('security.providers.enableToggle') }}
          </label>
        </form>
        <DialogFooter>
          <Button variant="outline" @click="open = false">{{ t('security.providers.cancel') }}</Button>
          <Button type="submit" form="idp-form" :disabled="busy">{{ t('security.providers.save') }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>
