<script setup lang="ts">
/**
 * Every provider this workspace can call, in one list, and which work runs on
 * which of them.
 *
 * The default config and the named profiles stay two things underneath: the
 * default inherits the environment and is what every unrouted call falls through
 * to, so it cannot be deleted or renamed. To the reader they are one list with a
 * pinned first row, because "Default provider" and "Providers" as two sections
 * asked them to learn that distinction before they could add a model.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Plus } from 'lucide-vue-next'
import type { AiSettingsResponse, ListAiProvidersResponse } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { errorMessage } from '@/shared/api/errors'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { confirm } from '@/shared/ui/confirm'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import { buildProviderRows, type ProviderDialogTarget, type ProviderRow } from '@/modules/assistant/model/provider-rows'
import AiSettingsSection from './AiSettingsSection.vue'
import AiDecisionRoute from './AiDecisionRoute.vue'
import AiProviderRowItem from './AiProviderRow.vue'
import AiProviderDialog from './AiProviderDialog.vue'

const { t } = useI18n()

const props = defineProps<{ canManage: boolean; settings: AiSettingsResponse }>()

const workspaceId = getWorkspaceId()
const queryClient = useQueryClient()
const query = useQuery(apiQueryOptions('/v1/ai/providers', { query: { workspaceId } }))
const providers = computed(() => (query.data.value as ListAiProvidersResponse | undefined)?.providers ?? [])

const invalidates = () => [['/v1/ai/providers'], ['/v1/ai/settings'], ['/v1/ai/providers/choices']]
const deleteProvider = useApiMutation('delete', '/v1/ai/providers/{id}', { invalidates })
const saveSettings = useApiMutation('patch', '/v1/ai/settings', { invalidates })

/**
 * A profile's last check is stored on its row. The default has no row to store
 * one on, so its result lasts as long as the page: enough to read the answer to
 * the button just pressed, and it does not pretend to be a health record.
 */
const defaultCheck = ref<{ status: 'ok' | 'error'; error: string | null } | null>(null)

const rows = computed<ProviderRow[]>(() =>
  buildProviderRows(props.settings, providers.value).map((row) =>
    row.isDefault && defaultCheck.value ? { ...row, status: defaultCheck.value.status, error: defaultCheck.value.error } : row,
  ),
)
const defaultRowName = computed(() => {
  const { provider, model } = props.settings
  return provider === 'none' ? t('ai.providerRow.none') : model || provider
})

// --- dialog ---------------------------------------------------------------
const dialogOpen = ref(false)
const dialogTarget = ref<ProviderDialogTarget>({ kind: 'new' })

function openDialog(target: ProviderDialogTarget) {
  dialogTarget.value = target
  dialogOpen.value = true
}

function edit(row: ProviderRow) {
  const provider = providers.value.find((p) => p.id === row.id)
  if (provider) openDialog({ kind: 'profile', provider })
  else openDialog({ kind: 'default' })
}

// --- row actions ----------------------------------------------------------
const testingId = ref<string | null>(null)

async function test(row: ProviderRow) {
  testingId.value = row.id
  const name = row.name ?? t('ai.default')
  try {
    const result = await api.post('/v1/ai/settings/test', {
      body: { workspaceId, ...(row.isDefault ? { useDefault: true } : { providerId: row.id }) },
    })
    if (row.isDefault) defaultCheck.value = { status: result.ok ? 'ok' : 'error', error: result.ok ? null : (result.error ?? null) }
    if (result.ok) toast.success(t('ai.providerReached', { name, model: result.model, ms: result.latencyMs }))
    else toast.error(t('ai.nameAndError', { name, error: result.error }))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    testingId.value = null
    void queryClient.invalidateQueries({ queryKey: ['/v1/ai/providers'] })
  }
}

async function remove(row: ProviderRow) {
  const name = row.name ?? ''
  // Removing clears the routes that point at it, and that work silently moves
  // to the default, so the people who routed it should hear so first.
  const ok = await confirm({
    title: t('ai.removeNamed', { name }),
    description: row.serves.length ? t('ai.providerRow.removeRoutedDesc') : t('ai.providerRow.removeDesc'),
    action: t('common.remove'),
    destructive: true,
  })
  if (!ok) return
  try {
    await deleteProvider.mutateAsync({ path: { id: row.id } })
    toast.success(t('ai.removedNamed', { name }))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

// --- routing --------------------------------------------------------------
const PURPOSES = [
  { key: 'chat', field: 'chatProviderId' },
  { key: 'review', field: 'reviewProviderId' },
  { key: 'extraction', field: 'extractionProviderId' },
] as const

/**
 * reka-ui reserves the empty string for "nothing selected", so an option
 * meaning "no route" needs a sentinel of its own — with `value=""` the trigger
 * silently showed Default even when a profile was routed.
 */
const UNROUTED = '__default__'

async function route(field: string, value: string) {
  try {
    await saveSettings.mutateAsync({ body: { workspaceId, [field]: value === UNROUTED ? null : value } })
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <AiSettingsSection :title="t('ai.providers')" :description="t('ai.providersDesc')">
    <ul class="@container divide-y rounded-lg border">
      <AiProviderRowItem
        v-for="row in rows"
        :key="row.id"
        :row="row"
        :can-manage="canManage"
        :testing="testingId === row.id"
        @edit="edit(row)"
        @test="test(row)"
        @remove="remove(row)"
      />
      <li v-if="query.isPending.value" class="px-3 py-3" aria-hidden="true">
        <Skeleton class="h-4 w-48" />
      </li>
      <li v-if="canManage">
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground hover:bg-accent/50 focus-visible:ring-ring/50 flex w-full items-center gap-3 rounded-b-lg px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-inset"
          @click="openDialog({ kind: 'new' })"
        >
          <Plus class="size-4 shrink-0" aria-hidden="true" />
          {{ t('ai.addProvider') }}
        </button>
      </li>
    </ul>

    <p v-if="query.isError.value" class="text-destructive text-xs">{{ errorMessage(query.error.value, t) }}</p>

    <AiProviderDialog v-model:open="dialogOpen" :target="dialogTarget" :settings="settings" />
  </AiSettingsSection>

  <!-- Routing only means anything once there is something to route to. -->
  <AiSettingsSection v-if="providers.length" :title="t('ai.routing')" :description="t('ai.routingDesc')">
    <div class="space-y-3">
      <label v-for="p in PURPOSES" :key="p.key" class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-sm">
          {{ t(`ai.purpose.${p.key}`) }}
          <span class="text-muted-foreground block text-xs">{{ t(`ai.purpose.${p.key}Hint`) }}</span>
        </span>
        <Select
          :model-value="settings.routing[p.key] ?? UNROUTED"
          :disabled="!canManage"
          @update:model-value="route(p.field, String($event ?? UNROUTED))"
        >
          <SelectTrigger class="w-64 max-w-full"><SelectValue :placeholder="t('ai.default')" /></SelectTrigger>
          <SelectContent>
            <SelectItem :value="UNROUTED">{{ t('ai.routeToDefault', { name: defaultRowName }) }}</SelectItem>
            <SelectItem v-for="opt in providers.filter((x) => x.enabled)" :key="opt.id" :value="opt.id">
              {{ opt.name }}
            </SelectItem>
          </SelectContent>
        </Select>
      </label>
    </div>
    <AiDecisionRoute
      class="border-t pt-3"
      :can-manage="canManage"
      :routed="settings.routing.decision"
      :decision="settings.decision"
      :providers="providers"
    />
  </AiSettingsSection>
</template>
