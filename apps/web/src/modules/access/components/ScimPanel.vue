<script setup lang="ts">
/**
 * Settings → Security → Provisioning (#75 phase 5): what an IdP needs to
 * provision this workspace over SCIM — the base URL and a bearer token — and
 * the role a provisioned person gets when no mapped group says more.
 *
 * A new token's secret is shown once, in place, until dismissed: the API
 * keeps only its hash, so leaving the tab loses it, which the notice says.
 * Group → role mappings for SCIM groups live on the Group mapping tab with
 * the provider ones, because an admin looks for "who gets which role" in one
 * place.
 */
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { KeyRound, Plus } from 'lucide-vue-next'
import { SCIM_DEFAULT_ROLES, type ScimDefaultRole, type ScimSettingsView, type ScimTokenCreated, type ScimTokenView } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { ApiRequestError } from '@/shared/api/http'
import { errorMessage } from '@/shared/api/errors'
import { getWorkspaceId } from '@/shared/api/api'
import { formatDateTime, formatRelative } from '@/shared/utils/format'
import CopyBlock from '@/modules/access/components/CopyBlock.vue'
import { Button } from '@/shared/ui/button'
import { confirm } from '@/shared/ui/confirm'
import { Input } from '@/shared/ui/input'
import { PageState } from '@/widgets/page'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'

const { t } = useI18n()
const workspaceId = getWorkspaceId()
const path = { id: workspaceId }

const settings = useQuery({
  ...apiQueryOptions('/v1/workspaces/{id}/scim', { path }),
  retry: false,
})
const data = computed(() => settings.data.value as ScimSettingsView | undefined)
const scimOff = computed(() => settings.error.value instanceof ApiRequestError && settings.error.value.status === 404)

const invalidates = () => [['/v1/workspaces/{id}/scim']]
const save = useApiMutation('put', '/v1/workspaces/{id}/scim', { invalidates })
const mint = useApiMutation('post', '/v1/workspaces/{id}/scim-tokens', { invalidates })
const revoke = useApiMutation('delete', '/v1/workspaces/{id}/scim-tokens/{tokenId}', { invalidates })

const form = reactive({ name: '' })
const fresh = ref<ScimTokenCreated | null>(null)

async function setDefaultRole(value: unknown) {
  const defaultRole = value as ScimDefaultRole
  if (!data.value || defaultRole === data.value.defaultRole) return
  try {
    await save.mutateAsync({ path, body: { defaultRole } })
    toast.success(t('security.scim.defaultRoleSaved'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function create() {
  const name = form.name.trim()
  if (!name) return
  try {
    fresh.value = (await mint.mutateAsync({ path, body: { name } })) as ScimTokenCreated
    form.name = ''
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function confirmRevoke(token: ScimTokenView) {
  const ok = await confirm({
    title: t('security.scim.revokeTitle', { name: token.name }),
    description: t('security.scim.revokeBody'),
    action: t('security.scim.revoke'),
    destructive: true,
  })
  if (!ok) return
  try {
    await revoke.mutateAsync({ path: { ...path, tokenId: token.id } })
    if (fresh.value?.token.id === token.id) fresh.value = null
    toast.success(t('security.scim.revoked'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <section class="flex flex-col gap-4">
    <div>
      <h2 class="text-base font-semibold">{{ t('security.scim.title') }}</h2>
      <p class="mt-0.5 max-w-prose text-sm text-muted-foreground">{{ t('security.scim.hint') }}</p>
    </div>

    <p v-if="scimOff" class="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
      {{ t('security.scim.disabled') }}
    </p>
    <PageState v-else-if="settings.isPending.value" state="loading" :rows="3" row-class="h-12" />
    <PageState v-else-if="settings.isError.value" state="error" :error="settings.error.value" />

    <template v-else-if="data">
      <CopyBlock :code="data.baseUrl" :label="t('security.scim.baseUrl')" />
      <p class="text-sm text-muted-foreground">
        {{ t('security.scim.counts', { users: data.users, active: data.activeUsers, groups: data.groups }) }}
      </p>

      <div class="grid max-w-md gap-1">
        <label class="text-sm font-medium" for="scim-default-role">{{ t('security.scim.defaultRole') }}</label>
        <Select :model-value="data.defaultRole" :disabled="save.isPending.value" @update:model-value="setDefaultRole">
          <SelectTrigger id="scim-default-role" class="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="role in SCIM_DEFAULT_ROLES" :key="role" :value="role">
              {{ role === 'none' ? t('security.scim.noRole') : t(`role.${role}`) }}
            </SelectItem>
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground">{{ t('security.scim.defaultRoleHint') }}</p>
      </div>

      <div class="flex flex-col gap-3">
        <h3 class="text-sm font-semibold">{{ t('security.scim.tokens') }}</h3>

        <div v-if="fresh" class="flex flex-col gap-2 rounded-md border border-primary/40 bg-primary/5 p-4">
          <p class="text-sm font-medium">{{ t('security.scim.freshTitle', { name: fresh.token.name }) }}</p>
          <p class="text-sm text-muted-foreground">{{ t('security.scim.freshHint') }}</p>
          <CopyBlock :code="fresh.secret" :label="t('security.scim.bearer')" secret />
          <Button size="sm" variant="outline" class="self-start" @click="fresh = null">{{ t('security.scim.freshDone') }}</Button>
        </div>

        <form class="flex flex-wrap items-end gap-2" @submit.prevent="create">
          <div class="grid min-w-0 flex-1 gap-1 sm:max-w-sm">
            <label class="text-sm font-medium" for="scim-token-name">{{ t('security.scim.tokenName') }}</label>
            <Input id="scim-token-name" v-model="form.name" required maxlength="80" autocomplete="off" :placeholder="t('security.scim.tokenNamePlaceholder')" />
          </div>
          <Button type="submit" :disabled="mint.isPending.value || !form.name.trim()">
            <Plus class="size-4" aria-hidden="true" />{{ t('security.scim.create') }}
          </Button>
        </form>

        <p v-if="!data.tokens.length" class="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
          {{ t('security.scim.empty') }}
        </p>
        <ul v-else class="divide-y rounded-md border">
          <li v-for="token in data.tokens" :key="token.id" class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
            <KeyRound class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span class="min-w-0 truncate text-sm font-medium">{{ token.name }}</span>
            <code class="rounded bg-muted px-1.5 py-0.5 text-xs">{{ token.prefix }}…</code>
            <span class="ml-auto text-xs text-muted-foreground" :title="formatDateTime(token.createdAt)">
              {{ token.lastUsedAt ? t('security.scim.lastUsed', { when: formatRelative(token.lastUsedAt) }) : t('security.scim.neverUsed') }}
            </span>
            <Button size="sm" variant="ghost" class="text-destructive" @click="confirmRevoke(token)">{{ t('security.scim.revoke') }}</Button>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
