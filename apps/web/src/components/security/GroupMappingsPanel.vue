<script setup lang="ts">
/**
 * Settings → Security → Group mapping (#75): which IdP group grants which
 * workspace role. A mapping names one of the workspace's providers (or a
 * platform-wide one), or a group the SCIM client pushed. A provider mapping
 * rewrites nothing when it changes — it applies at each person's next
 * sign-in, which the hint says, because an admin who expects the roster to
 * move at once will think the save failed. A SCIM mapping does apply at once:
 * provisioning already knows who is in the group.
 *
 * Posting a group that is already mapped replaces its role (the API upserts),
 * so there is no edit dialog: add it again with the new role.
 */
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Plus, Users, Wrench } from 'lucide-vue-next'
import { WORKSPACE_ROLES, type GroupMappingView, type ListGroupMappingsResponse, type WorkspaceRole } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { ApiRequestError } from '@/api/http'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { PageState } from '@/components/layout/page'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const { t } = useI18n()
const workspaceId = getWorkspaceId()
const path = { id: workspaceId }
/** The source Select's value for "a SCIM group" — providers are named by id. */
const SCIM = '__scim__'

const list = useQuery({
  ...apiQueryOptions('/v1/workspaces/{id}/group-mappings', { path }),
  retry: false,
})
const data = computed(() => list.data.value as ListGroupMappingsResponse | undefined)
const bothOff = computed(() => list.error.value instanceof ApiRequestError && list.error.value.status === 404)
const providerById = computed(() => new Map((data.value?.providers ?? []).map((p) => [p.id, p])))
const scimOn = computed(() => !!data.value?.enabled.scim)
const canMap = computed(() => !!data.value?.providers.length || scimOn.value)

const invalidates = () => [['/v1/workspaces/{id}/group-mappings']]
const upsert = useApiMutation('post', '/v1/workspaces/{id}/group-mappings', { invalidates })
const remove = useApiMutation('delete', '/v1/workspaces/{id}/group-mappings/{mappingId}', { invalidates })

const form = reactive({ providerId: '', externalGroup: '', role: 'viewer' as WorkspaceRole, trustedOperator: false })

// Preselect the first source once they load, so the common one-IdP case is one field.
watch(
  data,
  (d) => {
    if (!d) return
    const sources = [...d.providers.map((p) => p.id), ...(d.enabled.scim ? [SCIM] : [])]
    if (sources.length && !sources.includes(form.providerId)) form.providerId = sources[0]
  },
  { immediate: true },
)

const formProvider = computed(() => providerById.value.get(form.providerId))
const formScim = computed(() => form.providerId === SCIM)
const scimGroupName = (id: string) => data.value?.scimGroups.find((g) => g.id === id)?.displayName ?? id

// A SCIM group is picked from what the client pushed, so switching sources clears the field.
watch(formScim, () => (form.externalGroup = ''))

async function add() {
  const group = form.externalGroup.trim()
  if (!group || !form.providerId) return
  const providerId = formScim.value ? null : form.providerId
  const replacing = data.value?.mappings.some((m) => m.providerId === providerId && m.externalGroup === group)
  const label = formScim.value ? scimGroupName(group) : group
  try {
    await upsert.mutateAsync({
      path,
      body: { providerId, externalGroup: group, role: form.role, trustedOperator: form.trustedOperator },
    })
    toast.success(t(replacing ? 'security.groupMapping.replaced' : 'security.groupMapping.added', { group: label }))
    form.externalGroup = ''
    form.trustedOperator = false
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function confirmRemove(m: GroupMappingView) {
  // A native confirm keeps this one destructive action from needing its own dialog state.
  const group = m.providerId ? m.externalGroup : (m.scimGroupName ?? m.externalGroup)
  const key = m.providerId ? 'security.groupMapping.removeConfirm' : 'security.groupMapping.removeConfirmScim'
  if (!window.confirm(t(key, { group }))) return
  try {
    await remove.mutateAsync({ path: { ...path, mappingId: m.id } })
    toast.success(t('security.groupMapping.removed'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <section class="flex flex-col gap-4">
    <div>
      <h2 class="text-base font-semibold">{{ t('security.groupMapping.title') }}</h2>
      <p class="mt-0.5 max-w-prose text-sm text-muted-foreground">{{ t('security.groupMapping.hint') }}</p>
    </div>

    <p v-if="bothOff" class="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
      {{ t('security.groupMapping.disabled') }}
    </p>
    <PageState v-else-if="list.isPending.value" state="loading" :rows="2" row-class="h-12" />
    <PageState v-else-if="list.isError.value" state="error" :error="list.error.value" />
    <p v-else-if="!canMap" class="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
      {{ t('security.groupMapping.noProviders') }}
    </p>

    <template v-else-if="data">
      <form class="grid gap-3 rounded-md border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_auto] sm:items-end" @submit.prevent="add">
        <div class="grid gap-1">
          <label class="text-sm font-medium" for="gm-provider">{{ t('security.groupMapping.provider') }}</label>
          <Select v-model="form.providerId">
            <SelectTrigger id="gm-provider" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="p in data.providers" :key="p.id" :value="p.id">{{ p.name }}</SelectItem>
              <SelectItem v-if="scimOn" :value="SCIM">{{ t('security.groupMapping.scimSource') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="grid gap-1">
          <label class="text-sm font-medium" for="gm-group">{{ t('security.groupMapping.group') }}</label>
          <Select v-if="formScim" v-model="form.externalGroup" :disabled="!data.scimGroups.length">
            <SelectTrigger id="gm-group" class="w-full">
              <SelectValue :placeholder="t(data.scimGroups.length ? 'security.groupMapping.scimPick' : 'security.groupMapping.scimNone')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="g in data.scimGroups" :key="g.id" :value="g.id">
                {{ t('security.groupMapping.scimGroupOption', { name: g.displayName, count: g.memberCount }) }}
              </SelectItem>
            </SelectContent>
          </Select>
          <Input v-else id="gm-group" v-model="form.externalGroup" required maxlength="256" autocomplete="off" :placeholder="t('security.groupMapping.groupPlaceholder')" />
        </div>
        <div class="grid gap-1">
          <label class="text-sm font-medium" for="gm-role">{{ t('security.groupMapping.role') }}</label>
          <Select v-model="form.role">
            <SelectTrigger id="gm-role" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="role in WORKSPACE_ROLES" :key="role" :value="role">{{ t(`role.${role}`) }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" :disabled="upsert.isPending.value || !form.externalGroup.trim()">
          <Plus class="size-4" aria-hidden="true" />{{ t('security.groupMapping.add') }}
        </Button>
        <label class="flex items-center gap-2 text-sm sm:col-span-4">
          <Checkbox :model-value="form.trustedOperator" @update:model-value="form.trustedOperator = !!$event" />
          {{ t('security.groupMapping.operator') }}
        </label>
        <p v-if="formScim" class="text-xs text-muted-foreground sm:col-span-4">{{ t('security.groupMapping.scimHint') }}</p>
        <p v-else-if="formProvider" class="text-xs text-muted-foreground sm:col-span-4">
          {{ t(`security.groupMapping.mode.${formProvider.groupSyncMode}`) }}
          <template v-if="!formProvider.groupsClaim"> {{ t('security.groupMapping.presetClaim') }}</template>
        </p>
      </form>

      <p v-if="!data.mappings.length" class="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
        {{ t('security.groupMapping.empty') }}
      </p>
      <ul v-else class="divide-y rounded-md border">
        <li v-for="m in data.mappings" :key="m.id" class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
          <Users class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <code v-if="m.providerId" class="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-sm">{{ m.externalGroup }}</code>
          <span v-else class="min-w-0 truncate text-sm font-medium">{{ m.scimGroupName ?? t('security.groupMapping.scimGroupGone') }}</span>
          <span class="text-muted-foreground text-sm" aria-hidden="true">→</span>
          <Badge variant="outline">{{ t(`role.${m.role}`) }}</Badge>
          <span v-if="m.trustedOperator" class="flex items-center gap-1 text-xs text-muted-foreground">
            <Wrench class="size-3" aria-hidden="true" />{{ t('security.groupMapping.operatorBadge') }}
          </span>
          <span v-if="!m.providerId" class="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{{ t('security.groupMapping.scimBadge') }}</Badge>
          </span>
          <span v-else class="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            {{ m.providerName ?? t('security.groupMapping.providerGone') }}
            <Badge v-if="providerById.get(m.providerId)" variant="secondary">
              {{ t(`security.groupMapping.modeBadge.${providerById.get(m.providerId)!.groupSyncMode}`) }}
            </Badge>
          </span>
          <Button size="sm" variant="ghost" class="text-destructive" @click="confirmRemove(m)">{{ t('security.groupMapping.remove') }}</Button>
        </li>
      </ul>
    </template>
  </section>
</template>
