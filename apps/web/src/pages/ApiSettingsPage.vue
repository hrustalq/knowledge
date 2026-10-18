<script setup lang="ts">
/**
 * /settings/api (#78): how the API reference's try-it console may reach the
 * APIs a spec describes.
 *
 * The proxy mode is the web-access pattern (docs/features/25) on purpose: the
 * radio follows what this workspace asks for, the tint and the badge follow
 * what is in force, and a clamp by API_TRY_PROXY_MODE gets a sentence — a
 * setting that reads "open" while the deployment says "off" is a silent lie.
 * `allowlist` reuses the source policies in AI → Plugins, so there is one host
 * list to keep, not two. Admin-only to change, like the route behind it.
 *
 * Below it, the merge gate for breaking spec changes (phase 6): the same
 * three-row control, with no deployment ceiling — `null` is the code default,
 * `warn`, and the row says so rather than looking unset.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { ShieldCheck } from 'lucide-vue-next'
import {
  API_BREAKING_CHANGE_POLICIES,
  API_TRY_PROXY_MODES,
  DEFAULT_API_BREAKING_CHANGE_POLICY,
  type ApiBreakingChangePolicy,
  type ApiSettingsResponse,
  type ApiTryProxyMode,
  type UpdateApiSettingsRequest,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { formatBytes, formatNumber } from '@/lib/format'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/components/ui/badge'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { PageState } from '@/components/layout/page'

const { t } = useI18n()
const auth = useAuthStore()
const queryClient = useQueryClient()
const workspaceId = getWorkspaceId()
const canManage = computed(() => auth.canAdminWorkspace)

const options = apiQueryOptions('/v1/workspaces/{id}/api-settings', { path: { id: workspaceId } })
const query = useQuery(options)
const settings = computed(() => query.data.value as ApiSettingsResponse | undefined)
const proxy = computed(() => settings.value?.tryProxy)
const breaking = computed(() => settings.value?.breakingChanges)

function setMode(mode: ApiTryProxyMode | null) {
  if (mode === proxy.value?.requested) return
  return save({ apiTryProxyMode: mode })
}
function setPolicy(policy: ApiBreakingChangePolicy | null) {
  if (policy === breaking.value?.requested) return
  return save({ apiBreakingChangePolicy: policy })
}

async function save(body: UpdateApiSettingsRequest) {
  if (!canManage.value) return
  try {
    const next = (await api.patch('/v1/workspaces/{id}/api-settings', {
      path: { id: workspaceId },
      body,
    })) as ApiSettingsResponse
    queryClient.setQueryData(options.queryKey, next)
    toast.success(t('apiSettings.saved'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-6">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('apiSettings.title') }}</h1>
      <p class="mt-0.5 text-sm text-muted-foreground">{{ t('apiSettings.subtitle') }}</p>
    </div>

    <PageState v-if="query.isPending.value" state="loading" :rows="3" row-class="h-16" />
    <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />

    <section v-else-if="proxy && settings" class="max-w-2xl space-y-4">
      <header class="space-y-1 border-b pb-3">
        <h2 class="text-sm font-semibold">{{ t('apiSettings.proxy.title') }}</h2>
        <p class="text-sm leading-relaxed text-muted-foreground">{{ t('apiSettings.proxy.subtitle') }}</p>
      </header>

      <RadioGroup
        :model-value="proxy.requested ?? proxy.ceiling"
        :disabled="!canManage"
        class="kn-modes"
        :aria-label="t('apiSettings.proxy.title')"
        @update:model-value="setMode($event as ApiTryProxyMode)"
      >
        <label
          v-for="mode in API_TRY_PROXY_MODES"
          :key="mode"
          class="kn-mode"
          :data-active="proxy.effective === mode || undefined"
          :data-capped="(proxy.source === 'clamped' && proxy.requested === mode) || undefined"
        >
          <RadioGroupItem :value="mode" :disabled="!canManage" class="mt-0.5" />
          <span class="min-w-0">
            <span class="flex flex-wrap items-center gap-1.5">
              <span class="text-sm font-medium">{{ t(`apiSettings.mode.${mode}.label`) }}</span>
              <Badge v-if="proxy.source === 'clamped' && mode === proxy.requested" variant="secondary" class="font-normal">
                {{ t('apiSettings.cappedTo', { mode: t(`apiSettings.mode.${proxy.effective}.label`) }) }}
              </Badge>
              <Badge v-else-if="proxy.source === 'clamped' && mode === proxy.effective" class="font-normal">
                {{ t('apiSettings.inForce') }}
              </Badge>
              <Badge v-else-if="proxy.requested === null && mode === proxy.ceiling" variant="outline" class="font-normal">
                {{ t('apiSettings.fromEnv') }}
              </Badge>
            </span>
            <span class="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
              {{ t(`apiSettings.mode.${mode}.body`) }}
              <RouterLink
                v-if="mode === 'allowlist' || mode === 'open'"
                to="/settings/ai/plugins"
                class="text-primary underline-offset-2 hover:underline"
              >{{ t('apiSettings.policies') }}</RouterLink>
            </span>
          </span>
        </label>
      </RadioGroup>

      <p v-if="proxy.source === 'clamped'" class="kn-clamp">
        <ShieldCheck class="mt-px size-3.5 shrink-0" />
        <span>
          {{
            t('apiSettings.clampExplained', {
              requested: t(`apiSettings.mode.${proxy.requested}.label`),
              ceiling: t(`apiSettings.mode.${proxy.ceiling}.label`),
            })
          }}
        </span>
      </p>

      <div class="flex flex-wrap items-baseline justify-between gap-3">
        <p class="text-[13px] text-muted-foreground">
          {{
            t('apiSettings.limits', {
              perMinute: formatNumber(settings.tryLimits.perMinute),
              timeout: formatNumber(Math.round(settings.tryLimits.timeoutMs / 1000)),
              request: formatBytes(settings.tryLimits.maxRequestBytes),
              response: formatBytes(settings.tryLimits.maxResponseBytes),
            })
          }}
        </p>
        <button
          v-if="canManage && proxy.requested !== null"
          type="button"
          class="text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          @click="setMode(null)"
        >
          {{ t('apiSettings.inherit', { mode: t(`apiSettings.mode.${proxy.ceiling}.label`) }) }}
        </button>
      </div>
    </section>

    <section v-if="breaking" class="max-w-2xl space-y-4">
      <header class="space-y-1 border-b pb-3">
        <h2 class="text-sm font-semibold">{{ t('apiSettings.breaking.title') }}</h2>
        <p class="text-sm leading-relaxed text-muted-foreground">{{ t('apiSettings.breaking.subtitle') }}</p>
      </header>

      <RadioGroup
        :model-value="breaking.effective"
        :disabled="!canManage"
        class="kn-modes"
        :aria-label="t('apiSettings.breaking.title')"
        @update:model-value="setPolicy($event as ApiBreakingChangePolicy)"
      >
        <label
          v-for="policy in API_BREAKING_CHANGE_POLICIES"
          :key="policy"
          class="kn-mode"
          :data-active="breaking.effective === policy || undefined"
        >
          <RadioGroupItem :value="policy" :disabled="!canManage" class="mt-0.5" />
          <span class="min-w-0">
            <span class="flex flex-wrap items-center gap-1.5">
              <span class="text-sm font-medium">{{ t(`apiSettings.breaking.mode.${policy}.label`) }}</span>
              <Badge
                v-if="breaking.requested === null && policy === DEFAULT_API_BREAKING_CHANGE_POLICY"
                variant="outline"
                class="font-normal"
              >
                {{ t('apiSettings.breaking.default') }}
              </Badge>
            </span>
            <span class="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
              {{ t(`apiSettings.breaking.mode.${policy}.body`) }}
            </span>
          </span>
        </label>
      </RadioGroup>

      <div v-if="canManage && breaking.requested !== null" class="flex justify-end">
        <button
          type="button"
          class="text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          @click="setPolicy(null)"
        >
          {{ t('apiSettings.breaking.inherit') }}
        </button>
      </div>
    </section>

    <p v-if="settings && !canManage" class="max-w-2xl text-[13px] text-muted-foreground">{{ t('apiSettings.adminOnly') }}</p>
  </div>
</template>

<style scoped>
/* The web-access mode control (AiWebAccessSection): three stacked rows sharing
   one border, because the options are alternatives, not three settings. */
.kn-modes {
  gap: 0;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  overflow: hidden;
}
.kn-mode {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  padding: 0.75rem;
  cursor: pointer;
  transition: background-color 120ms ease-out;
}
.kn-mode + .kn-mode {
  border-top: 1px solid var(--border);
}
.kn-mode:hover {
  background: var(--accent);
}
.kn-mode[data-active] {
  background: color-mix(in oklab, var(--primary) 6%, transparent);
}
.kn-mode[data-capped] {
  background: color-mix(in oklab, var(--muted-foreground) 6%, transparent);
}
.kn-clamp {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  line-height: 1.5;
  background: color-mix(in oklab, var(--muted-foreground) 8%, transparent);
  color: var(--muted-foreground);
}
</style>
