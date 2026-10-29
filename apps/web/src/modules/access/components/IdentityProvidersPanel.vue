<script setup lang="ts">
/**
 * Settings → Security → Providers (#75): a workspace's OpenID Connect,
 * SAML 2.0 and (where the instance allows it) LDAP providers. The client
 * secret and the LDAP bind password are write-only — the API returns
 * `hasSecret` and nothing more, so the field is always empty and says whether
 * one is stored. What the IdP needs from us (the redirect URI, or the SAML
 * ACS and metadata URLs) is shown for copying. A SAML provider's SP key pair
 * is made by the API on create; nothing here edits it.
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
  GROUP_SYNC_MODES,
  IDP_PRESETS,
  WORKSPACE_ROLES,
  type GroupSyncMode,
  type IdentityProviderView,
  type IdpKind,
  type IdpPreset,
  type ListIdentityProvidersResponse,
  type TestIdentityProviderResponse,
  type WorkspaceRole,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { ApiRequestError } from '@/shared/api/http'
import { errorMessage } from '@/shared/api/errors'
import { getWorkspaceId } from '@/shared/api/api'
import { useCopy } from '@/shared/composables/use-copy'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { confirm } from '@/shared/ui/confirm'
import { Checkbox } from '@/shared/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Textarea } from '@/shared/ui/textarea'
import { PageState } from '@/widgets/page'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'

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
const EXAMPLES = {
  domains: 'corp.example',
  scopes: 'email profile',
  groupsClaim: 'groups',
  idpEntityId: 'https://idp.example.com/realms/company',
  ssoUrl: 'https://idp.example.com/realms/company/protocol/saml',
  emailAttribute: 'email',
  nameAttribute: 'displayName',
  idpCert: '-----BEGIN CERTIFICATE-----',
  ldapUrl: 'ldaps://dc.corp.example:636',
  bindDn: 'cn=knowledge,ou=services,dc=corp,dc=example',
  baseDn: 'ou=people,dc=corp,dc=example',
  userFilter: '(&(objectClass=person)(uid={username}))',
  ldapEmail: 'mail',
  ldapGroups: 'memberOf',
}
/** A Select item cannot carry the empty string, so "no default role" needs a value of its own. */
const NO_ROLE = '__none__'

/** What this instance lets a new provider be; LDAP only under AUTH_LDAP_ENABLED. */
const kinds = computed<IdpKind[]>(() => data.value?.kinds ?? ['oidc', 'saml'])

const blank = () => ({
  kind: 'oidc' as IdpKind,
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
  groupSyncMode: 'additive' as GroupSyncMode,
  sessionTtlHours: '',
  enabled: false,
  showOnLogin: true,
  platformWide: false,
  idpEntityId: '',
  ssoUrl: '',
  idpCert: '',
  allowIdpInitiated: false,
  emailAttribute: '',
  nameAttribute: '',
  ldapUrl: '',
  startTls: true,
  bindDn: '',
  bindPassword: '',
  baseDn: '',
  userFilter: '',
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
    kind: p.kind,
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
    groupSyncMode: p.groupSyncMode,
    sessionTtlHours: p.sessionTtlHours ? String(p.sessionTtlHours) : '',
    enabled: p.enabled,
    showOnLogin: p.showOnLogin,
    platformWide: p.platformWide,
    idpEntityId: p.saml?.idpEntityId ?? '',
    ssoUrl: p.saml?.ssoUrl ?? '',
    idpCert: p.saml?.idpCert ?? '',
    allowIdpInitiated: p.saml?.allowIdpInitiated ?? false,
    emailAttribute: p.saml?.emailAttribute ?? p.ldap?.emailAttribute ?? '',
    nameAttribute: p.saml?.nameAttribute ?? p.ldap?.nameAttribute ?? '',
    ldapUrl: p.ldap?.url ?? '',
    startTls: p.ldap?.startTls ?? true,
    bindDn: p.ldap?.bindDn ?? '',
    bindPassword: '',
    baseDn: p.ldap?.baseDn ?? '',
    userFilter: p.ldap?.userFilter ?? '',
  })
  clearSecret.value = false
  open.value = true
}

const split = (s: string, by: RegExp) => s.split(by).map((x) => x.trim()).filter(Boolean)
/** Write-only: a value sets it, '' clears it, absent keeps what is stored. */
const secret = (value: string) => (value ? value : clearSecret.value ? '' : undefined)
/** StartTLS applies to a plain ldap:// URL only; ldaps:// is TLS from the first byte. */
const plainLdap = computed(() => form.ldapUrl.trim().toLowerCase().startsWith('ldap://'))

/** The protocol's own fields: each kind's settings are sent only for that kind. */
function protocolFields() {
  if (form.kind === 'saml') {
    return {
      idpEntityId: form.idpEntityId.trim(),
      ssoUrl: form.ssoUrl.trim(),
      idpCert: form.idpCert.trim(),
      allowIdpInitiated: form.allowIdpInitiated,
      emailAttribute: form.emailAttribute.trim() || null,
      nameAttribute: form.nameAttribute.trim() || null,
    }
  }
  if (form.kind === 'ldap') {
    const bindPassword = secret(form.bindPassword)
    return {
      ldapUrl: form.ldapUrl.trim(),
      startTls: plainLdap.value && form.startTls,
      bindDn: form.bindDn.trim() || null,
      baseDn: form.baseDn.trim(),
      userFilter: form.userFilter.trim() || null,
      emailAttribute: form.emailAttribute.trim() || null,
      nameAttribute: form.nameAttribute.trim() || null,
      ...(bindPassword !== undefined ? { bindPassword } : {}),
    }
  }
  const clientSecret = secret(form.clientSecret)
  return {
    preset: form.preset,
    ...(FIXED_ISSUER.includes(form.preset) ? {} : { issuer: form.issuer.trim() }),
    clientId: form.clientId.trim(),
    scopes: split(form.scopes, /[\s,]+/),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
  }
}

function body() {
  const ttl = Number.parseInt(form.sessionTtlHours, 10)
  return {
    name: form.name.trim(),
    ...protocolFields(),
    allowedDomains: split(form.allowedDomains, /[\s,]+/),
    jitEnabled: form.jitEnabled,
    defaultRole: form.defaultRole === NO_ROLE ? null : form.defaultRole,
    groupsClaim: form.groupsClaim.trim() || null,
    groupSyncMode: form.groupSyncMode,
    sessionTtlHours: Number.isFinite(ttl) && ttl > 0 ? ttl : null,
    enabled: form.enabled,
    showOnLogin: form.showOnLogin,
    // Only a platform admin may change it; anyone else sends it unchanged.
    ...(auth.isAdmin ? { platformWide: form.platformWide } : {}),
  }
}

async function save() {
  try {
    if (editing.value) {
      await update.mutateAsync({ path: { ...path, providerId: editing.value.id }, body: body() })
    } else {
      await create.mutateAsync({ path, body: { kind: form.kind, ...body() } })
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
    const suffix = p.kind === 'saml' ? 'Saml' : p.kind === 'ldap' ? 'Ldap' : ''
    if (res.ok) toast.success(t(`security.providers.testOk${suffix}`, { issuer: res.issuer ?? '' }))
    else toast.error(t(`security.providers.testFailed${suffix}`, { error: res.error ?? '' }))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function confirmRemove(p: IdentityProviderView) {
  const ok = await confirm({
    title: t('security.providers.removeTitle', { name: p.name }),
    description: t('security.providers.removeBody'),
    action: t('security.providers.remove'),
    destructive: true,
  })
  if (!ok) return
  try {
    await remove.mutateAsync({ path: { ...path, providerId: p.id } })
    toast.success(t('security.providers.removed'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

/** What the IdP's admin copies from us, per protocol. */
function endpoints(p: IdentityProviderView): { label: string; value: string }[] {
  if (p.kind === 'ldap') return []
  if (!p.saml) {
    return [
      { label: t('security.providers.redirectUri'), value: p.redirectUri },
      ...(p.backchannelLogoutUri ? [{ label: t('security.providers.backchannelLogoutUri'), value: p.backchannelLogoutUri }] : []),
    ]
  }
  return [
    { label: t('security.providers.metadataUrl'), value: p.saml.entityId },
    { label: t('security.providers.acsUrl'), value: p.redirectUri },
  ]
}

const { state: copyState, copy: copyText } = useCopy()
/** Which value the last copy was of, so its status shows beside that row only. */
const copied = ref<string | null>(null)
function copy(value: string) {
  copied.value = value
  void copyText(value)
}
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
    <PageState v-else-if="!data?.providers.length" state="empty" :icon="KeyRound" :title="t('security.providers.empty')" />

    <ul v-else class="divide-y rounded-md border">
      <li v-for="p in data.providers" :key="p.id" class="flex flex-col gap-2 px-4 py-3">
        <div class="flex flex-wrap items-center gap-2">
          <KeyRound class="size-4 text-muted-foreground" aria-hidden="true" />
          <span class="font-medium">{{ p.name }}</span>
          <Badge variant="outline">{{ p.kind === 'oidc' ? t(`security.providers.presets.${p.preset}`) : t(`security.providers.kinds.${p.kind}`) }}</Badge>
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
          <span class="min-w-0 truncate">{{ p.saml?.idpEntityId ?? p.ldap?.url ?? p.config.issuer }}</span>
          <span v-if="p.allowedDomains.length">{{ t('security.providers.domainsList', { domains: p.allowedDomains.join(', ') }) }}</span>
        </div>
        <div v-for="e in endpoints(p)" :key="e.value" class="flex min-w-0 items-center gap-2 text-xs">
          <span class="shrink-0 text-muted-foreground">{{ e.label }}</span>
          <code class="min-w-0 truncate rounded bg-muted px-1.5 py-0.5" :title="e.value">{{ e.value }}</code>
          <Button
            size="icon"
            variant="ghost"
            class="size-7 shrink-0"
            :aria-label="t('security.providers.copyEndpoint', { label: e.label })"
            @click="copy(e.value)"
          >
            <Copy class="size-3.5" aria-hidden="true" />
          </Button>
          <span v-if="copyState !== 'idle' && copied === e.value" class="shrink-0 text-muted-foreground" aria-live="polite">
            {{ copyState === 'copied' ? t('security.providers.copied') : t('security.providers.copyFailed') }}
          </span>
        </div>
      </li>
    </ul>

    <Dialog v-model:open="open">
      <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ editing ? t('security.providers.editTitle') : t('security.providers.addTitle') }}</DialogTitle>
          <DialogDescription>{{ t(form.kind === 'saml' ? 'security.providers.formHintSaml' : form.kind === 'ldap' ? 'security.providers.formHintLdap' : 'security.providers.formHint') }}</DialogDescription>
        </DialogHeader>
        <form id="idp-form" class="grid gap-3" @submit.prevent="save">
          <div v-if="!editing" class="grid gap-1">
            <label class="text-sm font-medium" for="idp-kind">{{ t('security.providers.protocol') }}</label>
            <Select v-model="form.kind">
              <SelectTrigger id="idp-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="kind in kinds" :key="kind" :value="kind">{{ t(`security.providers.kinds.${kind}`) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div v-if="form.kind === 'oidc'" class="grid gap-1">
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
          <template v-if="form.kind === 'ldap'">
            <div class="grid gap-1">
              <label class="text-sm font-medium" for="idp-ldap-url">{{ t('security.providers.ldapUrl') }}</label>
              <Input
                id="idp-ldap-url"
                v-model="form.ldapUrl"
                required
                maxlength="500"
                autocomplete="off"
                spellcheck="false"
                aria-describedby="idp-ldap-url-hint"
                :placeholder="EXAMPLES.ldapUrl"
              />
              <p id="idp-ldap-url-hint" class="text-xs text-muted-foreground">{{ t('security.providers.ldapUrlHint') }}</p>
              <label v-if="plainLdap" class="flex items-center gap-2 text-sm">
                <Checkbox :model-value="form.startTls" @update:model-value="form.startTls = !!$event" />{{ t('security.providers.startTls') }}
              </label>
            </div>
            <div class="grid gap-1">
              <label class="text-sm font-medium" for="idp-base-dn">{{ t('security.providers.baseDn') }}</label>
              <Input id="idp-base-dn" v-model="form.baseDn" required maxlength="1000" autocomplete="off" spellcheck="false" :placeholder="EXAMPLES.baseDn" />
            </div>
            <div class="grid gap-1">
              <label class="text-sm font-medium" for="idp-bind-dn">{{ t('security.providers.bindDn') }}</label>
              <Input
                id="idp-bind-dn"
                v-model="form.bindDn"
                maxlength="1000"
                autocomplete="off"
                spellcheck="false"
                aria-describedby="idp-bind-dn-hint"
                :placeholder="EXAMPLES.bindDn"
              />
              <p id="idp-bind-dn-hint" class="text-xs text-muted-foreground">{{ t('security.providers.bindDnHint') }}</p>
            </div>
            <div class="grid gap-1">
              <label class="text-sm font-medium" for="idp-bind-password">{{ t('security.providers.bindPassword') }}</label>
              <Input
                id="idp-bind-password"
                v-model="form.bindPassword"
                type="password"
                autocomplete="new-password"
                :disabled="data && !data.secretsWritable"
                :placeholder="editing?.hasSecret ? t('security.providers.secretStored') : ''"
              />
              <p v-if="data && !data.secretsWritable" class="text-xs text-muted-foreground">{{ t('security.providers.secretsNotWritable') }}</p>
              <label v-else-if="editing?.hasSecret" class="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox :model-value="clearSecret" @update:model-value="clearSecret = !!$event" />{{ t('security.providers.clearSecret') }}
              </label>
            </div>
            <div class="grid gap-1">
              <label class="text-sm font-medium" for="idp-user-filter">{{ t('security.providers.userFilter') }}</label>
              <Input
                id="idp-user-filter"
                v-model="form.userFilter"
                maxlength="1000"
                autocomplete="off"
                spellcheck="false"
                class="font-mono text-xs md:text-xs"
                aria-describedby="idp-user-filter-hint"
                :placeholder="EXAMPLES.userFilter"
              />
              <p id="idp-user-filter-hint" class="text-xs text-muted-foreground">
                {{ t('security.providers.userFilterHint', { placeholder: '{username}' }) }}
              </p>
            </div>
          </template>
          <template v-if="form.kind === 'saml'">
            <div class="grid gap-1">
              <label class="text-sm font-medium" for="idp-entity">{{ t('security.providers.idpEntityId') }}</label>
              <Input id="idp-entity" v-model="form.idpEntityId" required maxlength="500" autocomplete="off" spellcheck="false" :placeholder="EXAMPLES.idpEntityId" />
            </div>
            <div class="grid gap-1">
              <label class="text-sm font-medium" for="idp-sso-url">{{ t('security.providers.ssoUrl') }}</label>
              <Input id="idp-sso-url" v-model="form.ssoUrl" required type="url" maxlength="2000" :placeholder="EXAMPLES.ssoUrl" />
            </div>
            <div class="grid gap-1">
              <label class="text-sm font-medium" for="idp-cert">{{ t('security.providers.idpCert') }}</label>
              <Textarea
                id="idp-cert"
                v-model="form.idpCert"
                required
                rows="4"
                wrap="off"
                spellcheck="false"
                autocomplete="off"
                aria-describedby="idp-cert-hint"
                class="max-h-40 overflow-auto font-mono text-xs whitespace-pre md:text-xs"
                :placeholder="EXAMPLES.idpCert"
              />
              <p id="idp-cert-hint" class="text-xs text-muted-foreground">{{ t('security.providers.idpCertHint') }}</p>
            </div>
          </template>
          <!-- SAML and LDAP read the person from named attributes; OIDC from standard claims. -->
          <fieldset v-if="form.kind !== 'oidc'" class="grid gap-3 rounded-md border px-3 pt-2 pb-3">
            <legend class="px-1 text-sm font-medium">{{ t('security.providers.attributeMap') }}</legend>
            <p class="-mt-1 text-xs text-muted-foreground">{{ t(form.kind === 'ldap' ? 'security.providers.attributeMapHintLdap' : 'security.providers.attributeMapHint') }}</p>
            <div class="grid gap-3 sm:grid-cols-3">
              <div class="grid min-w-0 gap-1">
                <label class="text-xs font-medium" for="idp-attr-email">{{ t('security.providers.emailAttribute') }}</label>
                <Input id="idp-attr-email" v-model="form.emailAttribute" maxlength="300" spellcheck="false" :placeholder="form.kind === 'ldap' ? EXAMPLES.ldapEmail : EXAMPLES.emailAttribute" />
              </div>
              <div class="grid min-w-0 gap-1">
                <label class="text-xs font-medium" for="idp-attr-name">{{ t('security.providers.nameAttribute') }}</label>
                <Input id="idp-attr-name" v-model="form.nameAttribute" maxlength="300" spellcheck="false" :placeholder="EXAMPLES.nameAttribute" />
              </div>
              <div class="grid min-w-0 gap-1">
                <label class="text-xs font-medium" for="idp-attr-groups">{{ t('security.providers.groupsAttribute') }}</label>
                <Input id="idp-attr-groups" v-model="form.groupsClaim" maxlength="100" spellcheck="false" :placeholder="form.kind === 'ldap' ? EXAMPLES.ldapGroups : EXAMPLES.groupsClaim" />
              </div>
            </div>
            <p class="text-xs text-muted-foreground">{{ t(form.kind === 'ldap' ? 'security.providers.groupsAttributeHintLdap' : 'security.providers.groupsAttributeHint') }}</p>
          </fieldset>
          <div v-if="form.kind === 'oidc' && !FIXED_ISSUER.includes(form.preset)" class="grid gap-1">
            <label class="text-sm font-medium" for="idp-issuer">{{ t('security.providers.issuer') }}</label>
            <Input id="idp-issuer" v-model="form.issuer" required type="url" :placeholder="t(`security.providers.issuerPlaceholder.${form.preset}`)" />
          </div>
          <div v-if="form.kind === 'oidc'" class="grid gap-1">
            <label class="text-sm font-medium" for="idp-client">{{ t('security.providers.clientId') }}</label>
            <Input id="idp-client" v-model="form.clientId" required autocomplete="off" />
          </div>
          <div v-if="form.kind === 'oidc'" class="grid gap-1">
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
              <div v-if="form.kind === 'oidc'" class="grid gap-1">
                <label class="text-sm font-medium" for="idp-scopes">{{ t('security.providers.scopes') }}</label>
                <Input id="idp-scopes" v-model="form.scopes" :placeholder="EXAMPLES.scopes" />
              </div>
              <label v-if="form.kind === 'saml'" class="flex items-start gap-2">
                <Checkbox class="mt-0.5" :model-value="form.allowIdpInitiated" @update:model-value="form.allowIdpInitiated = !!$event" />
                <span>{{ t('security.providers.allowIdpInitiated') }}<span class="block text-xs text-muted-foreground">{{ t('security.providers.allowIdpInitiatedHint') }}</span></span>
              </label>
              <div v-if="form.kind === 'oidc'" class="grid gap-1">
                <label class="text-sm font-medium" for="idp-groups">{{ t('security.providers.groupsClaim') }}</label>
                <Input id="idp-groups" v-model="form.groupsClaim" :placeholder="EXAMPLES.groupsClaim" />
              </div>
              <div class="grid gap-1">
                <label class="text-sm font-medium" for="idp-sync">{{ t('security.providers.groupSyncMode') }}</label>
                <Select v-model="form.groupSyncMode">
                  <SelectTrigger id="idp-sync"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="mode in GROUP_SYNC_MODES" :key="mode" :value="mode">{{ t(`security.groupMapping.modeBadge.${mode}`) }}</SelectItem>
                  </SelectContent>
                </Select>
                <p class="text-xs text-muted-foreground">{{ t(`security.groupMapping.mode.${form.groupSyncMode}`) }}</p>
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
