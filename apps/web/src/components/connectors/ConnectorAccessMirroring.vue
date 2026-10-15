<script setup lang="ts">
/**
 * The Access tab (#76, phase 6): whether this connector carries who may open a
 * page upstream onto the page here, and the upstream people it has met.
 *
 * Settings are saved together, like the page access dialog, because mode,
 * interval and audience are one decision. The identity list is the reason
 * the tab exists day to day: a principal with no person here is left out of
 * every page that names it, and this is where somebody maps them by hand.
 *
 * Admin-only, like the GitHub access card — the list names people from
 * outside the workspace, and the setting decides who reads every page the
 * connector writes.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useQuery } from '@tanstack/vue-query'
import { RefreshCw } from 'lucide-vue-next'
import {
  CONNECTOR_ACL_MODES,
  type ConnectorAclMode,
  type ConnectorAclResponse,
  type ListUserGroupsResponse,
  type ListWorkspaceMembersResponse,
  type UserGroupSummary,
  type WorkspaceMemberEntry,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { apiFetch, getWorkspaceId, relativeTime } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageState } from '@/components/layout/page'

const props = defineProps<{ connectorId: string }>()
const { t } = useI18n()

/** Radix Select has no empty value; this stands for "nobody" / "no group". */
const NONE = '__none'

const query = useQuery(
  computed(() => apiQueryOptions('/v1/connectors/{id}/acl', { path: { id: props.connectorId } })),
)
const acl = computed(() => query.data.value as ConnectorAclResponse | undefined)

const mode = ref<ConnectorAclMode>('off')
const interval = ref('')
const audience = ref(NONE)

watch(
  acl,
  (value) => {
    if (!value) return
    mode.value = value.mode
    interval.value = value.syncIntervalMinutes === null ? '' : String(value.syncIntervalMinutes)
    audience.value = value.audienceGroupId ?? NONE
  },
  { immediate: true },
)

const dirty = computed(() => {
  const a = acl.value
  if (!a) return false
  return (
    a.mode !== mode.value ||
    (a.syncIntervalMinutes === null ? '' : String(a.syncIntervalMinutes)) !== interval.value.trim() ||
    (a.audienceGroupId ?? NONE) !== audience.value
  )
})

// Candidates for the audience and for mapping, fetched in the browser only.
const members = ref<WorkspaceMemberEntry[]>([])
const groups = ref<UserGroupSummary[]>([])
watch(
  () => props.connectorId,
  async () => {
    const ws = getWorkspaceId()
    const [m, g] = await Promise.allSettled([
      apiFetch<ListWorkspaceMembersResponse>(`/v1/workspaces/${ws}/members`),
      apiFetch<ListUserGroupsResponse>(`/v1/groups?workspaceId=${ws}`),
    ])
    members.value = m.status === 'fulfilled' ? m.value.members.filter((x) => !x.disabled) : []
    // A connector's own mirrored groups cannot be its audience: they are what
    // per-item mirroring writes.
    groups.value = g.status === 'fulfilled' ? g.value.groups.filter((x) => x.source === 'manual') : []
  },
  { immediate: true },
)

const invalidates = () => [['/v1/connectors/{id}/acl'], ['/v1/connectors/{id}'], ['/v1/connectors']]
const update = useApiMutation('put', '/v1/connectors/{id}/acl', { invalidates })
const map = useApiMutation('put', '/v1/connectors/{id}/acl/identities/{identityId}', { invalidates })
const syncNow = useApiMutation('post', '/v1/connectors/{id}/acl/sync', { invalidates })

async function save() {
  const minutes = interval.value.trim() === '' ? null : Number(interval.value)
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 5 || minutes > 10080)) {
    toast.error(t('connectors.acl.intervalInvalid'))
    return
  }
  try {
    await update.mutateAsync({
      path: { id: props.connectorId },
      body: {
        mode: mode.value,
        syncIntervalMinutes: minutes,
        audienceGroupId: audience.value === NONE ? null : audience.value,
      },
    })
    toast.success(mode.value === 'off' ? t('connectors.acl.savedOff') : t('connectors.acl.saved'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function mapTo(identityId: string, value: string) {
  try {
    await map.mutateAsync({
      path: { id: props.connectorId, identityId },
      body: { userId: value === NONE ? null : value },
    })
    toast.success(t('connectors.acl.mapped'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function refresh() {
  try {
    await syncNow.mutateAsync({ path: { id: props.connectorId } })
    toast.success(t('connectors.acl.syncQueued'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

const unmapped = computed(() => acl.value?.identities.filter((i) => !i.userId).length ?? 0)
</script>

<template>
  <PageState v-if="query.isPending.value" state="loading" />
  <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />
  <div v-else-if="acl" class="space-y-6 text-sm">
    <section class="space-y-3">
      <div>
        <h2 class="font-medium">{{ t('connectors.acl.title') }}</h2>
        <p class="text-muted-foreground text-xs">
          {{ acl.perItem ? t('connectors.acl.introPerItem') : t('connectors.acl.introAudience') }}
        </p>
      </div>

      <RadioGroup v-model="mode" class="gap-2">
        <label
          v-for="m in CONNECTOR_ACL_MODES"
          :key="m"
          class="flex items-start gap-2.5 rounded-md border p-3"
          :class="mode === m ? 'border-primary' : ''"
        >
          <RadioGroupItem :value="m" class="mt-0.5" />
          <span class="space-y-0.5">
            <span class="block font-medium">{{ t(`connectors.acl.mode.${m}`) }}</span>
            <span class="text-muted-foreground block text-xs">{{ t(`connectors.acl.modeHint.${m}`) }}</span>
          </span>
        </label>
      </RadioGroup>

      <div v-if="mode !== 'off'" class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-1.5">
          <Label for="kn-acl-interval">{{ t('connectors.acl.interval') }}</Label>
          <Input
            id="kn-acl-interval"
            v-model="interval"
            inputmode="numeric"
            :placeholder="String(acl.defaultSyncIntervalMinutes)"
          />
          <p class="text-muted-foreground text-xs">
            {{ t('connectors.acl.intervalHint', { n: acl.defaultSyncIntervalMinutes }) }}
          </p>
        </div>
        <div v-if="!acl.perItem" class="space-y-1.5">
          <Label for="kn-acl-audience">{{ t('connectors.acl.audience') }}</Label>
          <Select v-model="audience">
            <SelectTrigger id="kn-acl-audience" class="w-full">
              <SelectValue :placeholder="t('connectors.acl.audiencePlaceholder')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="NONE">{{ t('connectors.acl.audienceNone') }}</SelectItem>
              <SelectItem v-for="g in groups" :key="g.groupId" :value="g.groupId">{{ g.name }}</SelectItem>
            </SelectContent>
          </Select>
          <p class="text-muted-foreground text-xs">{{ t('connectors.acl.audienceHint') }}</p>
        </div>
      </div>

      <p v-if="acl.mode !== 'off' && mode === 'off'" class="text-xs text-amber-700 dark:text-amber-400">
        {{ t('connectors.acl.offWarning') }}
      </p>

      <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" :disabled="!dirty || update.isPending.value" @click="save">
          {{ update.isPending.value ? t('common.saving') : t('common.save') }}
        </Button>
        <Button
          v-if="acl.mode !== 'off'"
          size="sm"
          variant="outline"
          :disabled="syncNow.isPending.value"
          @click="refresh"
        >
          <RefreshCw class="size-3.5" /> {{ t('connectors.acl.syncNow') }}
        </Button>
      </div>
    </section>

    <section v-if="acl.mode !== 'off'" class="space-y-1">
      <dl class="grid gap-x-6 gap-y-1 sm:grid-cols-3">
        <div>
          <dt class="text-muted-foreground text-xs">{{ t('connectors.acl.lastSync') }}</dt>
          <dd>
            <span v-if="acl.syncedAt" :title="formatDateTime(acl.syncedAt)">{{ relativeTime(acl.syncedAt) }}</span>
            <span v-else class="text-muted-foreground">{{ t('connectors.never') }}</span>
          </dd>
        </div>
        <div>
          <dt class="text-muted-foreground text-xs">{{ t('connectors.acl.restrictedPages') }}</dt>
          <dd class="tabular-nums">{{ acl.restrictedPages }}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground text-xs">{{ t('connectors.acl.groups') }}</dt>
          <dd class="tabular-nums">{{ acl.groupCount }}</dd>
        </div>
      </dl>
    </section>

    <section v-if="acl.identities.length" class="space-y-2">
      <div>
        <h2 class="font-medium">{{ t('connectors.acl.identitiesTitle') }}</h2>
        <p class="text-muted-foreground text-xs">
          {{ unmapped ? t('connectors.acl.unmappedCount', { n: unmapped }, unmapped) : t('connectors.acl.allMapped') }}
        </p>
      </div>
      <ul class="divide-y rounded-md border">
        <li v-for="identity in acl.identities" :key="identity.id" class="flex flex-wrap items-center gap-2 px-3 py-2">
          <div class="min-w-0 flex-1">
            <!-- Upstream names are source text: rendered as text, never as markup. -->
            <div class="truncate font-medium">{{ identity.displayName ?? identity.externalId }}</div>
            <div class="text-muted-foreground truncate text-xs">{{ identity.email ?? identity.externalId }}</div>
          </div>
          <Badge v-if="identity.mappedBy" variant="outline" class="shrink-0">
            {{ t(`connectors.acl.mappedBy.${identity.mappedBy}`) }}
          </Badge>
          <Badge v-else variant="destructive" class="shrink-0">{{ t('connectors.acl.unmapped') }}</Badge>
          <Select
            :model-value="identity.userId ?? NONE"
            @update:model-value="(v) => mapTo(identity.id, String(v))"
          >
            <SelectTrigger
              class="h-8 w-56 shrink-0 text-xs"
              :aria-label="t('connectors.acl.mapLabel', { name: identity.displayName ?? identity.externalId })"
            >
              <SelectValue :placeholder="t('connectors.acl.mapPlaceholder')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="NONE">{{ t('connectors.acl.mapNone') }}</SelectItem>
              <SelectItem v-for="m in members" :key="m.userId" :value="m.userId">
                {{ m.displayName }} · {{ m.email }}
              </SelectItem>
            </SelectContent>
          </Select>
        </li>
      </ul>
      <p class="text-muted-foreground text-xs">{{ t('connectors.acl.mapHint') }}</p>
    </section>
  </div>
</template>
