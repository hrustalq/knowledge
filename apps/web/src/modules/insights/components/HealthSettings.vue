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
 *
 * The search-ranking group (#305, #401) is the same contract for the knobs
 * `make tune` proposes: the RRF constant, the vector relevance floor and the
 * per-state trust weights, whose override is sparse per state. Their defaults
 * are code constants, except the absolute cosine floor (`SEARCH_MIN_COSINE`).
 * The community prior and layered expansion (#475) join it, both off by default.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import {
  TRUST_WEIGHT_KEYS,
  TRUST_WEIGHT_MAX,
  TRUST_WEIGHT_MIN,
  type KnowledgeHealthSettingsOverride,
  type KnowledgeHealthSettingsResponse,
  type TrustWeights,
} from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { getWorkspaceId } from '@/shared/api/api'
import { formatNumber } from '@/shared/utils/format'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { PageState } from '@/widgets/page'

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

type WeightKey = keyof TrustWeights
/** The scalar search knobs, one row each; the bounds are the settings route's. */
const KNOBS = [
  { key: 'rrfK', min: 1, max: 1000, step: 1, integer: true },
  { key: 'minCosine', min: 0, max: 1, step: 0.01, integer: false },
  { key: 'minCosineShare', min: 0, max: 1, step: 0.01, integer: false },
  { key: 'communityPriorWeight', min: 0, max: 2, step: 0.05, integer: false },
  { key: 'communityPriorFloor', min: 0, max: 1, step: 0.01, integer: false },
] as const
type Knob = (typeof KNOBS)[number]
type KnobKey = Knob['key']

/** The on/off keys, each a three-way: inherit, on, off. */
type SwitchKey = 'trustRanking' | 'layeredExpansion'
type Switch = 'inherit' | 'on' | 'off'

/**
 * The inputs: a value per numeric key (empty = inherit) and a three-way for
 * each switch. A `type="number"` input's v-model hands back a number once typed
 * into and the string it was given before, so every read goes through `text`.
 */
type Field = string | number
const text = (v: Field) => String(v).trim()
const form = reactive<
  Record<NumericKey | KnobKey, Field> & Record<SwitchKey, Switch> & { trustWeights: Record<WeightKey, Field> }
>({
  reviewIntervalDays: '',
  remindBeforeDays: '',
  inactiveAfterDays: '',
  emptyMaxChars: '',
  trustRanking: 'inherit',
  layeredExpansion: 'inherit',
  rrfK: '',
  minCosine: '',
  minCosineShare: '',
  communityPriorWeight: '',
  communityPriorFloor: '',
  trustWeights: Object.fromEntries(TRUST_WEIGHT_KEYS.map((k) => [k, ''])) as Record<WeightKey, Field>,
})

function adopt(res: KnowledgeHealthSettingsResponse) {
  for (const { key } of NUMERIC) form[key] = res.override[key] === null ? '' : String(res.override[key])
  for (const key of ['trustRanking', 'layeredExpansion'] as const) {
    form[key] = res.override[key] === null ? 'inherit' : res.override[key] ? 'on' : 'off'
  }
  for (const { key } of KNOBS) form[key] = res.override[key] === null ? '' : String(res.override[key])
  for (const k of TRUST_WEIGHT_KEYS) {
    const v = res.override.trustWeights?.[k]
    form.trustWeights[k] = v === undefined ? '' : String(v)
  }
}
watch(settings, (res) => res && adopt(res), { immediate: true })

/** What the form would send — `null` for every key left empty. */
const draft = computed<KnowledgeHealthSettingsOverride>(() => ({
  reviewIntervalDays: parse(form.reviewIntervalDays),
  remindBeforeDays: parse(form.remindBeforeDays),
  inactiveAfterDays: parse(form.inactiveAfterDays),
  emptyMaxChars: parse(form.emptyMaxChars),
  trustRanking: form.trustRanking === 'inherit' ? null : form.trustRanking === 'on',
  layeredExpansion: form.layeredExpansion === 'inherit' ? null : form.layeredExpansion === 'on',
  ...(Object.fromEntries(KNOBS.map((knob) => [knob.key, parseKnob(knob)])) as Record<KnobKey, number | null>),
  trustWeights: draftWeights.value,
}))
function parse(raw: Field): number | null {
  const trimmed = text(raw)
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** Only the states given a value; none at all is `null`, "inherit every default". */
const draftWeights = computed<Partial<TrustWeights> | null>(() => {
  const set = TRUST_WEIGHT_KEYS.flatMap((k) => {
    const raw = text(form.trustWeights[k])
    return raw === '' ? [] : [[k, Number(raw)] as const]
  })
  return set.length ? Object.fromEntries(set) : null
})
const sameWeights = (a: Partial<TrustWeights> | null, b: Partial<TrustWeights> | null) =>
  TRUST_WEIGHT_KEYS.every((k) => (a?.[k] ?? null) === (b?.[k] ?? null))

const dirty = computed(() => {
  const current = settings.value?.override
  if (!current) return false
  return (Object.keys(draft.value) as (keyof KnowledgeHealthSettingsOverride)[]).some((k) =>
    k === 'trustWeights' ? !sameWeights(draft.value.trustWeights, current.trustWeights) : draft.value[k] !== current[k],
  )
})

function invalid(key: NumericKey, max: number): boolean {
  const raw = text(form[key])
  if (raw === '') return false
  const n = Number(raw)
  return !Number.isInteger(n) || n < 0 || n > max
}
function parseKnob(knob: Knob): number | null {
  const raw = text(form[knob.key])
  return raw === '' || knobInvalid(knob) ? null : Number(raw)
}
function knobInvalid({ key, min, max, integer }: Knob): boolean {
  const raw = text(form[key])
  if (raw === '') return false
  const n = Number(raw)
  return !(integer ? Number.isInteger(n) : Number.isFinite(n)) || n < min || n > max
}
/** A floor of 0 is no floor; the RRF constant is never 0. */
const knobLabel = (value: number) => (value === 0 ? t('health.settings.off') : formatNumber(value))
function weightInvalid(key: WeightKey): boolean {
  const raw = text(form.trustWeights[key])
  if (raw === '') return false
  const n = Number(raw)
  return !Number.isFinite(n) || n < TRUST_WEIGHT_MIN || n > TRUST_WEIGHT_MAX
}
const anyInvalid = computed(
  () => NUMERIC.some(({ key, max }) => invalid(key, max)) || KNOBS.some(knobInvalid) || TRUST_WEIGHT_KEYS.some(weightInvalid),
)
const weightLabel = (key: WeightKey) => (key === 'inactive' ? t('verification.inactive') : t(`verification.state.${key}`))
const weightOverridden = (key: WeightKey) => settings.value?.override.trustWeights?.[key] !== undefined

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
const onOff = (value: boolean | undefined) => (value ? t('health.settings.on') : t('health.settings.off'))

const saving = ref(false)
async function save() {
  if (saving.value || anyInvalid.value) return
  saving.value = true
  try {
    const next = await api.patch('/v1/knowledge-health/settings', {
      query: { workspaceId },
      body: draft.value,
    })
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

  <form v-else-if="settings" class="space-y-5" @submit.prevent="save">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-base font-semibold">{{ t('health.settings.title') }}</h2>
        <p class="kn-measure mt-0.5 text-sm text-muted-foreground">{{ t('health.settings.intro') }}</p>
      </div>
      <Badge v-if="!props.canManage" variant="outline">{{ t('health.settings.readOnly') }}</Badge>
    </div>

    <div class="divide-y rounded-md border">
      <div v-for="{ key, unit, max } in NUMERIC" :key="key" class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[1fr_12rem]">
        <div class="min-w-0">
          <label :for="`health-${key}`" class="text-sm font-medium">{{ t(`health.settings.key.${key}.label`) }}</label>
          <p class="kn-measure text-xs text-muted-foreground">{{ t(`health.settings.key.${key}.hint`) }}</p>
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
          <p class="kn-measure text-xs text-muted-foreground">{{ t('health.settings.key.trustRanking.hint') }}</p>
          <p class="mt-1 text-xs">
            <span class="text-muted-foreground">{{ t('health.settings.applies') }}</span>
            {{ onOff(settings.effective.trustRanking) }}
            <span v-if="settings.override.trustRanking !== null" class="ml-1 text-primary/80">{{ t('ai.overridden') }}</span>
          </p>
        </div>
        <Select v-model="form.trustRanking" :disabled="!props.canManage">
          <SelectTrigger class="h-9 w-full" :aria-label="t('health.settings.key.trustRanking.label')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{{ t('health.settings.inherit', { value: onOff(settings.defaults.trustRanking) }) }}</SelectItem>
            <SelectItem value="on">{{ t('health.settings.on') }}</SelectItem>
            <SelectItem value="off">{{ t('health.settings.off') }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <section class="space-y-2" aria-labelledby="health-ranking-title">
      <div>
        <h3 id="health-ranking-title" class="text-sm font-semibold">{{ t('health.settings.ranking.title') }}</h3>
        <p class="kn-measure mt-0.5 text-xs text-muted-foreground">{{ t('health.settings.ranking.intro') }}</p>
      </div>

      <div class="divide-y rounded-md border">
        <div v-for="knob in KNOBS" :key="knob.key" class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[1fr_12rem]">
          <div class="min-w-0">
            <label :for="`health-${knob.key}`" class="text-sm font-medium">{{ t(`health.settings.key.${knob.key}.label`) }}</label>
            <p class="kn-measure text-xs text-muted-foreground">{{ t(`health.settings.key.${knob.key}.hint`) }}</p>
            <p class="mt-1 text-xs">
              <span class="text-muted-foreground">{{ t('health.settings.applies') }}</span>
              {{ knobLabel(settings.effective[knob.key]) }}
              <span v-if="settings.override[knob.key] !== null" class="ml-1 text-primary/80">{{ t('ai.overridden') }}</span>
            </p>
            <p v-if="knob.key === 'communityPriorFloor' && settings.effective.communityPriorWeight === 0" class="mt-1 text-xs text-muted-foreground">
              {{ t('health.settings.key.communityPriorFloor.inert') }}
            </p>
          </div>
          <div class="space-y-1">
            <Input
              :id="`health-${knob.key}`"
              v-model="form[knob.key]"
              type="number"
              :inputmode="knob.integer ? 'numeric' : 'decimal'"
              :min="knob.min"
              :max="knob.max"
              :step="knob.step"
              class="h-9 tabular-nums"
              :placeholder="formatNumber(settings.defaults[knob.key])"
              :disabled="!props.canManage"
              :aria-invalid="knobInvalid(knob) || undefined"
              :aria-describedby="`health-${knob.key}-default`"
            />
            <p :id="`health-${knob.key}-default`" class="text-xs text-muted-foreground">
              {{ t('health.settings.default', { value: knobLabel(settings.defaults[knob.key]) }) }}
            </p>
          </div>
        </div>

        <fieldset class="space-y-3 px-4 py-3">
          <div>
            <legend class="text-sm font-medium">{{ t('health.settings.key.trustWeights.label') }}</legend>
            <p class="kn-measure text-xs text-muted-foreground">{{ t('health.settings.key.trustWeights.hint') }}</p>
            <p v-if="!settings.effective.trustRanking" class="mt-1 text-xs text-muted-foreground">
              {{ t('health.settings.key.trustWeights.inert') }}
            </p>
          </div>
          <!-- Subgrid rows: a label that wraps (Russian runs long) pushes its
               whole row of inputs down together instead of misaligning one. -->
          <div class="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <div v-for="key in TRUST_WEIGHT_KEYS" :key="key" class="row-span-3 grid min-w-0 grid-rows-subgrid gap-y-1">
              <label :for="`health-weight-${key}`" class="self-end text-xs font-medium">
                {{ weightLabel(key) }}
              </label>
              <Input
                :id="`health-weight-${key}`"
                v-model="form.trustWeights[key]"
                type="number"
                inputmode="decimal"
                :min="TRUST_WEIGHT_MIN"
                :max="TRUST_WEIGHT_MAX"
                step="0.05"
                class="h-9 tabular-nums"
                :placeholder="formatNumber(settings.defaults.trustWeights[key])"
                :disabled="!props.canManage"
                :aria-invalid="weightInvalid(key) || undefined"
                :aria-describedby="`health-weight-${key}-applies`"
              />
              <p :id="`health-weight-${key}-applies`" class="text-xs tabular-nums">
                <span class="text-muted-foreground">{{ t('health.settings.applies') }}</span>
                ×{{ formatNumber(settings.effective.trustWeights[key]) }}
                <span v-if="weightOverridden(key)" class="ml-1 text-primary/80">{{ t('ai.overridden') }}</span>
              </p>
            </div>
          </div>
          <p class="text-xs text-muted-foreground">
            {{ t('health.settings.key.trustWeights.range', { min: formatNumber(TRUST_WEIGHT_MIN), max: formatNumber(TRUST_WEIGHT_MAX) }) }}
          </p>
        </fieldset>

        <div class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[1fr_12rem]">
          <div class="min-w-0">
            <span class="text-sm font-medium">{{ t('health.settings.key.layeredExpansion.label') }}</span>
            <p class="kn-measure text-xs text-muted-foreground">{{ t('health.settings.key.layeredExpansion.hint') }}</p>
            <p class="mt-1 text-xs">
              <span class="text-muted-foreground">{{ t('health.settings.applies') }}</span>
              {{ onOff(settings.effective.layeredExpansion) }}
              <span v-if="settings.override.layeredExpansion !== null" class="ml-1 text-primary/80">{{ t('ai.overridden') }}</span>
            </p>
          </div>
          <Select v-model="form.layeredExpansion" :disabled="!props.canManage">
            <SelectTrigger class="h-9 w-full" :aria-label="t('health.settings.key.layeredExpansion.label')">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">{{ t('health.settings.inherit', { value: onOff(settings.defaults.layeredExpansion) }) }}</SelectItem>
              <SelectItem value="on">{{ t('health.settings.on') }}</SelectItem>
              <SelectItem value="off">{{ t('health.settings.off') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </section>

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
