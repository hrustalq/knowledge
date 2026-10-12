<script setup lang="ts">
/**
 * The workspace's freshness policy (docs/features/40): the five keys of the
 * `VERIFICATION_*` / `PAGE_INACTIVE_AFTER_DAYS` / `SEARCH_TRUST_RANKING`
 * block, each as a sparse override of the server default.
 *
 * Every row shows two things, because the API answers with two: what is
 * **asked for** (the override, empty meaning "inherit") and what **applies**
 * (the effective value). A form that showed only the input would read as
 * blank when the default is doing the work, and a form that showed only the
 * effective value would hide that it is a default — a silent clamp lies about
 * the configuration (CLAUDE.md). Env values are defaults here, not ceilings.
 *
 * A viewer may read the policy; only an admin may save it, which is the
 * route's role too.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type { KnowledgeHealthSettingsOverride, KnowledgeHealthSettingsResponse } from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageState } from '@/components/layout/page'

const props = defineProps<{ canManage: boolean }>()

const { t } = useI18n()
const queryClient = useQueryClient()
const workspaceId = getWorkspaceId()

const options = apiQueryOptions('/v1/knowledge-health/settings', { query: { workspaceId } })
const query = useQuery(options)
const settings = computed(() => query.data.value as KnowledgeHealthSettingsResponse | undefined)

type NumericKey = 'reviewIntervalDays' | 'remindBeforeDays' | 'inactiveAfterDays' | 'emptyMaxChars'
const NUMERIC: readonly { key: NumericKey; unit: 'days' | 'chars'; max: number }[] = [
  { key: 'reviewIntervalDays', unit: 'days', max: 3650 },
  { key: 'remindBeforeDays', unit: 'days', max: 3650 },
  { key: 'inactiveAfterDays', unit: 'days', max: 3650 },
  { key: 'emptyMaxChars', unit: 'chars', max: 100_000 },
]

/** The inputs: a string per numeric key (empty = inherit) and a three-way for the switch. */
const form = reactive<Record<NumericKey, string> & { trustRanking: 'inherit' | 'on' | 'off' }>({
  reviewIntervalDays: '',
  remindBeforeDays: '',
  inactiveAfterDays: '',
  emptyMaxChars: '',
  trustRanking: 'inherit',
})

function adopt(res: KnowledgeHealthSettingsResponse) {
  for (const { key } of NUMERIC) form[key] = res.override[key] === null ? '' : String(res.override[key])
  form.trustRanking = res.override.trustRanking === null ? 'inherit' : res.override.trustRanking ? 'on' : 'off'
}
watch(settings, (res) => res && adopt(res), { immediate: true })

/** What the form would send — `null` for every key left empty. */
const draft = computed<KnowledgeHealthSettingsOverride>(() => ({
  reviewIntervalDays: parse(form.reviewIntervalDays),
  remindBeforeDays: parse(form.remindBeforeDays),
  inactiveAfterDays: parse(form.inactiveAfterDays),
  emptyMaxChars: parse(form.emptyMaxChars),
  trustRanking: form.trustRanking === 'inherit' ? null : form.trustRanking === 'on',
}))
function parse(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isInteger(n) && n >= 0 ? n : null
}

const dirty = computed(() => {
  const current = settings.value?.override
  if (!current) return false
  return (Object.keys(draft.value) as (keyof KnowledgeHealthSettingsOverride)[]).some((k) => draft.value[k] !== current[k])
})

function invalid(key: NumericKey, max: number): boolean {
  const raw = form[key].trim()
  if (raw === '') return false
  const n = Number(raw)
  return !Number.isInteger(n) || n < 0 || n > max
}
const anyInvalid = computed(() => NUMERIC.some(({ key, max }) => invalid(key, max)))

/** What applies for a key, in words. */
function appliesLabel(key: NumericKey, unit: 'days' | 'chars'): string {
  const value = settings.value?.effective[key] ?? 0
  // A zero interval means "never", a zero window means "off"; a zero
  // threshold is still a number of characters.
  if (value === 0 && key === 'reviewIntervalDays') return t('verification.interval.never')
  if (value === 0 && unit === 'days') return t('health.settings.off')
  return unit === 'days' ? t('health.settings.days', { n: value }, value) : t('health.settings.chars', { n: formatNumber(value) }, value)
}
function defaultLabel(key: NumericKey): string {
  return formatNumber(settings.value?.defaults[key] ?? 0)
}
const trustDefault = computed(() => (settings.value?.defaults.trustRanking ? t('health.settings.on') : t('health.settings.off')))
const trustApplies = computed(() => (settings.value?.effective.trustRanking ? t('health.settings.on') : t('health.settings.off')))

const saving = ref(false)
async function save() {
  if (saving.value || anyInvalid.value) return
  saving.value = true
  try {
    const next = (await api.patch('/v1/knowledge-health/settings', {
      query: { workspaceId },
      body: draft.value,
    })) as KnowledgeHealthSettingsResponse
    queryClient.setQueryData(options.queryKey, next)
    // The policy decides what `inactive`, `empty` and `expired` mean, so the
    // rows and the counts are stale the moment it changes.
    void queryClient.invalidateQueries({ queryKey: ['/v1/knowledge-health'] })
    void queryClient.invalidateQueries({ queryKey: ['/v1/knowledge-health/summary'] })
    toast.success(t('health.settings.saved'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <PageState v-if="query.isPending.value" state="loading" :rows="5" row-class="h-12" />
  <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />

  <form v-else-if="settings" class="max-w-2xl space-y-5" @submit.prevent="save">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-base font-semibold">{{ t('health.settings.title') }}</h2>
        <p class="mt-0.5 text-sm text-muted-foreground">{{ t('health.settings.intro') }}</p>
      </div>
      <Badge v-if="!props.canManage" variant="outline">{{ t('health.settings.readOnly') }}</Badge>
    </div>

    <div class="divide-y rounded-md border">
      <div v-for="{ key, unit, max } in NUMERIC" :key="key" class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[1fr_12rem]">
        <div class="min-w-0">
          <label :for="`health-${key}`" class="text-sm font-medium">{{ t(`health.settings.key.${key}.label`) }}</label>
          <p class="text-xs text-muted-foreground">{{ t(`health.settings.key.${key}.hint`) }}</p>
          <p class="mt-1 text-xs">
            <span class="text-muted-foreground">{{ t('health.settings.applies') }}</span>
            {{ appliesLabel(key, unit) }}
            <span v-if="settings.override[key] !== null" class="ml-1 text-primary/80">{{ t('ai.overridden') }}</span>
          </p>
        </div>
        <div class="space-y-1">
          <Input
            :id="`health-${key}`"
            v-model="form[key]"
            type="number"
            inputmode="numeric"
            min="0"
            :max="max"
            step="1"
            class="h-9"
            :placeholder="defaultLabel(key)"
            :disabled="!props.canManage"
            :aria-invalid="invalid(key, max) || undefined"
            :aria-describedby="`health-${key}-default`"
          />
          <p :id="`health-${key}-default`" class="text-xs text-muted-foreground">
            {{ t('health.settings.default', { value: defaultLabel(key) }) }}
          </p>
        </div>
      </div>

      <div class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[1fr_12rem]">
        <div class="min-w-0">
          <span class="text-sm font-medium">{{ t('health.settings.key.trustRanking.label') }}</span>
          <p class="text-xs text-muted-foreground">{{ t('health.settings.key.trustRanking.hint') }}</p>
          <p class="mt-1 text-xs">
            <span class="text-muted-foreground">{{ t('health.settings.applies') }}</span>
            {{ trustApplies }}
            <span v-if="settings.override.trustRanking !== null" class="ml-1 text-primary/80">{{ t('ai.overridden') }}</span>
          </p>
        </div>
        <Select v-model="form.trustRanking" :disabled="!props.canManage">
          <SelectTrigger class="h-9 w-full" :aria-label="t('health.settings.key.trustRanking.label')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{{ t('health.settings.inherit', { value: trustDefault }) }}</SelectItem>
            <SelectItem value="on">{{ t('health.settings.on') }}</SelectItem>
            <SelectItem value="off">{{ t('health.settings.off') }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <div v-if="props.canManage" class="flex items-center gap-2">
      <Button type="submit" size="sm" :disabled="!dirty || anyInvalid || saving">
        {{ saving ? t('common.saving') : t('common.save') }}
      </Button>
      <Button type="button" variant="ghost" size="sm" :disabled="!dirty || saving" @click="adopt(settings)">
        {{ t('common.discard') }}
      </Button>
    </div>
  </form>
</template>
