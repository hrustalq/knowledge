<script setup lang="ts">
/**
 * Settings → Security → Domains (#75 phase 4): email domains this workspace
 * claims, proves through DNS, and may then enforce — which takes passwords
 * away from every address on the domain.
 *
 * A row reads left to right in the order an admin works through it: publish
 * the TXT record, verify, enforce. The record stays visible until the domain
 * is verified, because "what do I paste where" is the question a pending row
 * exists to answer. A platform admin also gets "Mark verified" for an install
 * that cannot be reached by public DNS.
 */
import { computed, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Copy, Globe, Plus, ShieldCheck } from 'lucide-vue-next'
import type { ListSsoDomainsResponse, SsoDomainView, VerifySsoDomainResponse } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { ApiRequestError } from '@/api/http'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { useCopy } from '@/lib/use-copy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { PageState } from '@/components/layout/page'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const { t } = useI18n()
const workspaceId = getWorkspaceId()
const path = { id: workspaceId }
/** The Select cannot hold null; this stands for "any of the workspace's providers". */
const ANY = '__any__'

const list = useQuery({
  ...apiQueryOptions('/v1/workspaces/{id}/sso-domains', { path }),
  retry: false,
})
const data = computed(() => list.data.value as ListSsoDomainsResponse | undefined)
const ssoOff = computed(() => list.error.value instanceof ApiRequestError && list.error.value.status === 404)

const invalidates = () => [['/v1/workspaces/{id}/sso-domains']]
const claim = useApiMutation('post', '/v1/workspaces/{id}/sso-domains', { invalidates })
const verify = useApiMutation('post', '/v1/workspaces/{id}/sso-domains/{domain}/verify', { invalidates })
const update = useApiMutation('patch', '/v1/workspaces/{id}/sso-domains/{domain}', { invalidates })
const remove = useApiMutation('delete', '/v1/workspaces/{id}/sso-domains/{domain}', { invalidates })

const form = reactive({ domain: '', providerId: ANY })
const { state: copyState, copy } = useCopy()
const copied = reactive({ key: '' })

async function add() {
  const domain = form.domain.trim()
  if (!domain) return
  try {
    const view = (await claim.mutateAsync({
      path,
      body: { domain, ...(form.providerId !== ANY ? { providerId: form.providerId } : {}) },
    })) as SsoDomainView
    toast.success(t('security.domains.claimed', { domain: view.domain }))
    form.domain = ''
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function check(d: SsoDomainView, manual = false) {
  try {
    const res = (await verify.mutateAsync({ path: { ...path, domain: d.domain }, body: manual ? { manual: true } : {} })) as VerifySsoDomainResponse
    if (res.error) toast.error(t(`security.domains.verifyErrors.${res.error}`, { record: d.recordName }))
    else toast.success(t('security.domains.verified', { domain: d.domain }))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function setEnforced(d: SsoDomainView, enforced: boolean) {
  if (enforced) {
    const ok = await confirm({
      title: t('security.domains.enforceTitle', { domain: d.domain }),
      description: t('security.domains.enforceBody'),
      action: t('security.domains.enforce'),
    })
    if (!ok) return
  }
  try {
    await update.mutateAsync({ path: { ...path, domain: d.domain }, body: { enforced } })
    toast.success(t(enforced ? 'security.domains.enforcedOn' : 'security.domains.enforcedOff', { domain: d.domain }))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function setProvider(d: SsoDomainView, value: unknown) {
  const providerId = value === ANY ? null : String(value)
  if (providerId === d.providerId) return
  try {
    await update.mutateAsync({ path: { ...path, domain: d.domain }, body: { providerId } })
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function confirmRemove(d: SsoDomainView) {
  const ok = await confirm({
    title: t('security.domains.removeTitle', { domain: d.domain }),
    description: t('security.domains.removeBody'),
    action: t('security.domains.remove'),
    destructive: true,
  })
  if (!ok) return
  try {
    await remove.mutateAsync({ path: { ...path, domain: d.domain } })
    toast.success(t('security.domains.removed'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function copyValue(key: string, text: string) {
  copied.key = key
  await copy(text)
}
const copyLabel = (key: string) =>
  copied.key === key && copyState.value !== 'idle'
    ? t(copyState.value === 'copied' ? 'security.domains.copied' : 'security.domains.copyFailed')
    : t('security.domains.copy')
</script>

<template>
  <section class="flex flex-col gap-4">
    <div>
      <h2 class="text-base font-semibold">{{ t('security.domains.title') }}</h2>
      <p class="mt-0.5 max-w-prose text-sm text-muted-foreground">{{ t('security.domains.hint') }}</p>
    </div>

    <p v-if="ssoOff" class="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
      {{ t('security.providers.disabled') }}
    </p>
    <PageState v-else-if="list.isPending.value" state="loading" :rows="2" row-class="h-16" />
    <PageState v-else-if="list.isError.value" state="error" :error="list.error.value" />

    <template v-else-if="data">
      <form class="grid gap-3 rounded-md border p-4 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-end" @submit.prevent="add">
        <div class="grid gap-1">
          <label class="text-sm font-medium" for="sd-domain">{{ t('security.domains.domain') }}</label>
          <Input id="sd-domain" v-model="form.domain" required maxlength="253" autocomplete="off" :placeholder="t('security.domains.domainPlaceholder')" />
        </div>
        <div class="grid gap-1">
          <label class="text-sm font-medium" for="sd-provider">{{ t('security.domains.provider') }}</label>
          <Select v-model="form.providerId">
            <SelectTrigger id="sd-provider" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem :value="ANY">{{ t('security.domains.anyProvider') }}</SelectItem>
              <SelectItem v-for="p in data.providers" :key="p.id" :value="p.id">{{ p.name }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" :disabled="claim.isPending.value || !form.domain.trim()">
          <Plus class="size-4" aria-hidden="true" />{{ t('security.domains.claim') }}
        </Button>
      </form>

      <p v-if="!data.domains.length" class="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
        {{ t('security.domains.empty') }}
      </p>
      <ul v-else class="divide-y rounded-md border">
        <li v-for="d in data.domains" :key="d.domain" class="flex flex-col gap-3 px-4 py-3">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Globe class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span class="min-w-0 truncate font-medium">{{ d.domain }}</span>
            <Badge v-if="d.enforced" variant="default">{{ t('security.domains.status.enforced') }}</Badge>
            <Badge v-else-if="d.verifiedAt" variant="secondary">{{ t('security.domains.status.verified') }}</Badge>
            <Badge v-else variant="outline">{{ t('security.domains.status.pending') }}</Badge>
            <Button size="sm" variant="ghost" class="ml-auto text-destructive" @click="confirmRemove(d)">
              {{ t('security.domains.remove') }}
            </Button>
          </div>

          <!-- Pending: what to publish, and the two ways to prove it. -->
          <div v-if="!d.verifiedAt" class="grid gap-2 rounded-md bg-muted/40 p-3 text-sm">
            <p class="text-muted-foreground">{{ t('security.domains.publish') }}</p>
            <div class="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-center">
              <span class="text-xs text-muted-foreground">{{ t('security.domains.recordName') }}</span>
              <code class="min-w-0 truncate rounded bg-background px-1.5 py-0.5">{{ d.recordName }}</code>
              <Button size="sm" variant="ghost" @click="copyValue(`n:${d.domain}`, d.recordName)">
                <Copy class="size-3.5" aria-hidden="true" />{{ copyLabel(`n:${d.domain}`) }}
              </Button>
              <span class="text-xs text-muted-foreground">{{ t('security.domains.recordValue') }}</span>
              <code class="min-w-0 truncate rounded bg-background px-1.5 py-0.5">{{ d.verificationToken }}</code>
              <Button size="sm" variant="ghost" @click="copyValue(`v:${d.domain}`, d.verificationToken)">
                <Copy class="size-3.5" aria-hidden="true" />{{ copyLabel(`v:${d.domain}`) }}
              </Button>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" :disabled="verify.isPending.value" @click="check(d)">
                <ShieldCheck class="size-4" aria-hidden="true" />{{ t('security.domains.verify') }}
              </Button>
              <Button v-if="data.canVerifyManually" size="sm" variant="outline" :disabled="verify.isPending.value" @click="check(d, true)">
                {{ t('security.domains.markVerified') }}
              </Button>
              <span v-if="d.recheckUntil" class="text-xs text-muted-foreground">
                {{ t('security.domains.rechecking', { until: formatDateTime(d.recheckUntil) }) }}
              </span>
            </div>
          </div>

          <!-- Verified: where its people sign in, and whether passwords are gone. -->
          <div v-else class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div class="grid gap-1">
              <label class="text-xs text-muted-foreground" :for="`sd-p-${d.domain}`">{{ t('security.domains.provider') }}</label>
              <Select :model-value="d.providerId ?? ANY" @update:model-value="setProvider(d, $event)">
                <SelectTrigger :id="`sd-p-${d.domain}`" class="w-full sm:max-w-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem :value="ANY">{{ t('security.domains.anyProvider') }}</SelectItem>
                  <SelectItem v-for="p in data.providers" :key="p.id" :value="p.id">{{ p.name }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label class="flex items-center gap-2 text-sm">
              <Checkbox :model-value="d.enforced" :disabled="update.isPending.value" @update:model-value="setEnforced(d, !!$event)" />
              {{ t('security.domains.enforce') }}
            </label>
            <p class="text-xs text-muted-foreground sm:col-span-2">
              {{ t(d.enforced ? 'security.domains.enforcedHint' : 'security.domains.notEnforcedHint') }}
            </p>
          </div>
        </li>
      </ul>
    </template>
  </section>
</template>
