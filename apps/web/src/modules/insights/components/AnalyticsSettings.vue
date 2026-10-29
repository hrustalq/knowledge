<script setup lang="ts">
/**
 * The workspace's analytics settings (#79): recording on or off, and how long
 * rows are kept. Both are sparse overrides of the deployment's env, which is a
 * **ceiling**: a workspace can turn recording off and keep rows for less,
 * never more. So each row shows what is asked for, the ceiling, and what
 * applies — a silent clamp lies about the configuration.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type { AnalyticsSettingsResponse } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { PageState } from '@/shared/layout'

const props = defineProps<{ workspaceId: string }>()

const { t } = useI18n()
const queryClient = useQueryClient()

const options = apiQueryOptions('/v1/analytics/settings', { query: { workspaceId: props.workspaceId } })
const query = useQuery(options)
const settings = computed(() => query.data.value as AnalyticsSettingsResponse | undefined)

const MAX_DAYS = 3650
const enabled = ref<'inherit' | 'on' | 'off'>('inherit')
const retention = ref('')

watch(
  settings,
  (s) => {
    if (!s) return
    enabled.value = s.requested.enabled === null ? 'inherit' : s.requested.enabled ? 'on' : 'off'
    retention.value = s.requested.retentionDays === null ? '' : String(s.requested.retentionDays)
  },
  { immediate: true },
)

const retentionDraft = computed<number | null>(() => (retention.value.trim() === '' ? null : Number(retention.value)))
const retentionInvalid = computed(() => {
  const n = retentionDraft.value
  return n !== null && (!Number.isInteger(n) || n < 1 || n > MAX_DAYS)
})
const enabledDraft = computed(() => (enabled.value === 'inherit' ? null : enabled.value === 'on'))
const dirty = computed(() => {
  const s = settings.value
  return !!s && (enabledDraft.value !== s.requested.enabled || retentionDraft.value !== s.requested.retentionDays)
})
/** A value past the ceiling is saved as asked and applies clamped; say so before it is saved. */
const retentionClamped = computed(() => {
  const n = retentionDraft.value
  return !!settings.value && n !== null && !retentionInvalid.value && n > settings.value.ceiling.retentionDays
})

const onOff = (v: boolean) => (v ? t('analytics.settings.on') : t('analytics.settings.off'))
const days = (n: number) => t('analytics.settings.days', { n }, n)

const saving = ref(false)
async function save() {
  if (saving.value || retentionInvalid.value || !dirty.value) return
  saving.value = true
  try {
    const next = await api.put('/v1/analytics/settings', {
      body: { workspaceId: props.workspaceId, enabled: enabledDraft.value, retentionDays: retentionDraft.value },
    })
    queryClient.setQueryData(options.queryKey, next)
    void queryClient.invalidateQueries({ queryKey: ['/v1/analytics/overview'] })
    toast.success(t('analytics.settings.saved'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <PageState v-if="query.isPending.value" state="loading" :rows="3" row-class="h-12" />
  <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />

  <form v-else-if="settings" class="space-y-5" @submit.prevent="save">
    <div>
      <h2 class="text-base font-semibold">{{ t('analytics.settings.title') }}</h2>
      <p class="kn-measure mt-0.5 text-sm text-muted-foreground">{{ t('analytics.settings.intro') }}</p>
    </div>

    <div class="divide-y rounded-md border">
      <div class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[1fr_12rem]">
        <div class="min-w-0">
          <span class="text-sm font-medium">{{ t('analytics.settings.recording.label') }}</span>
          <p class="kn-measure text-xs text-muted-foreground">{{ t('analytics.settings.recording.hint') }}</p>
          <p class="mt-1 text-xs">
            <span class="text-muted-foreground">{{ t('analytics.settings.applies') }}</span>
            {{ onOff(settings.effective.enabled) }}
            <span v-if="!settings.ceiling.enabled" class="ml-1 text-muted-foreground">{{ t('analytics.settings.offByDeployment') }}</span>
          </p>
        </div>
        <Select v-model="enabled">
          <SelectTrigger class="h-9 w-full" :aria-label="t('analytics.settings.recording.label')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{{ t('analytics.settings.inherit', { value: onOff(settings.ceiling.enabled) }) }}</SelectItem>
            <SelectItem value="on" :disabled="!settings.ceiling.enabled">{{ t('analytics.settings.on') }}</SelectItem>
            <SelectItem value="off">{{ t('analytics.settings.off') }}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[1fr_12rem]">
        <div class="min-w-0">
          <label for="analytics-retention" class="text-sm font-medium">{{ t('analytics.settings.retention.label') }}</label>
          <p class="text-xs text-muted-foreground">
            {{ t('analytics.settings.retention.hint', { text: days(settings.queryTextDays) }) }}
          </p>
          <p class="mt-1 text-xs">
            <span class="text-muted-foreground">{{ t('analytics.settings.applies') }}</span>
            {{ days(settings.effective.retentionDays) }}
          </p>
          <p v-if="settings.effective.retentionDays < settings.deadPageDays" class="mt-1 text-xs text-muted-foreground">
            {{ t('analytics.settings.retention.belowDead', { n: settings.deadPageDays }) }}
          </p>
        </div>
        <div class="space-y-1">
          <Input
            id="analytics-retention"
            v-model="retention"
            type="number"
            inputmode="numeric"
            min="1"
            :max="MAX_DAYS"
            step="1"
            class="h-9"
            :placeholder="String(settings.ceiling.retentionDays)"
            :aria-invalid="retentionInvalid || undefined"
            aria-describedby="analytics-retention-ceiling"
          />
          <p id="analytics-retention-ceiling" class="text-xs" :class="retentionClamped ? 'text-destructive' : 'text-muted-foreground'">
            {{
              retentionClamped
                ? t('analytics.settings.retention.clamped', { n: settings.ceiling.retentionDays })
                : t('analytics.settings.ceiling', { value: days(settings.ceiling.retentionDays) })
            }}
          </p>
        </div>
      </div>
    </div>

    <div class="flex justify-end">
      <Button type="submit" size="sm" :disabled="!dirty || retentionInvalid || saving">
        {{ saving ? t('common.loading') : t('common.save') }}
      </Button>
    </div>
  </form>
</template>
