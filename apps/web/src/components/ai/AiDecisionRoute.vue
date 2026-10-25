<script setup lang="ts">
/**
 * The decision route (#530, docs/features/67): which gen-api profile asks
 * TypeSafe Jev the yes/no questions that pre-filter the arbiter, harvest and
 * citation support, and at what probability each lets an item through.
 *
 * Unlike the routes above it, an unrouted decision is off, not "the default
 * below": the default config is a chat model, and Jev is something an admin
 * turns on. The data-path notice is shown before the choice, because it is
 * what the choice is about. DECISION_PROVIDER=none is a ceiling: a saved route
 * stays visible and the row says it is not applied, rather than clamping
 * silently. Thresholds follow AiCapturePanel's form shape — an empty input
 * inherits, and the placeholder is what it inherits.
 */
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Info } from 'lucide-vue-next'
import { DECISION_SITES, type AiProviderSummary, type DecisionSettings, type DecisionSite } from '@knowledge/contracts'
import { useApiMutation } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const props = defineProps<{
  canManage: boolean
  routed: string | null
  decision: DecisionSettings
  providers: AiProviderSummary[]
}>()

const { t } = useI18n()
const workspaceId = getWorkspaceId()
const save = useApiMutation('patch', '/v1/ai/settings', {
  invalidates: () => [['/v1/ai/settings'], ['/v1/ai/providers']],
})

const OFF = '__off__'
const FIELD = {
  arbiter: 'decisionArbiterThreshold',
  citation: 'decisionCitationThreshold',
  harvest: 'decisionHarvestThreshold',
} as const satisfies Record<DecisionSite, string>

// Jev is reached only through gen-api; the API refuses any other profile.
const options = computed(() => props.providers.filter((p) => p.enabled && p.provider === 'gen-api'))
const routedName = computed(() => props.providers.find((p) => p.id === props.routed)?.name ?? null)

async function route(value: string) {
  try {
    await save.mutateAsync({ body: { workspaceId, decisionProviderId: value === OFF ? null : value } })
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

const form = reactive<Record<DecisionSite, string>>({ arbiter: '', citation: '', harvest: '' })
watch(
  () => props.decision,
  (d) => {
    for (const site of DECISION_SITES) form[site] = d.thresholds[site].requested === null ? '' : String(d.thresholds[site].requested)
  },
  { immediate: true },
)

function parseUnit(raw: string): number | null {
  const v = raw.trim()
  if (v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null
}
const invalid = (site: DecisionSite) => form[site].trim() !== '' && parseUnit(form[site]) === null
const changed = computed(() => {
  const out: Record<string, number | null> = {}
  for (const site of DECISION_SITES) {
    const asked = parseUnit(form[site])
    if (asked !== props.decision.thresholds[site].requested) out[FIELD[site]] = asked
  }
  return out
})
const canSave = computed(() => !DECISION_SITES.some(invalid) && Object.keys(changed.value).length > 0)

async function saveThresholds() {
  if (!canSave.value || save.isPending.value) return
  try {
    await save.mutateAsync({ body: { workspaceId, ...changed.value } })
    toast.success(t('ai.decision.saved'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <div class="space-y-3">
    <label class="flex flex-wrap items-center justify-between gap-2">
      <span class="text-sm">
        {{ t('ai.purpose.decision') }}
        <span class="text-muted-foreground block text-xs">{{ t('ai.purpose.decisionHint') }}</span>
      </span>
      <Select
        :model-value="routed ?? OFF"
        :disabled="!canManage || !decision.available"
        @update:model-value="route(String($event ?? OFF))"
      >
        <SelectTrigger class="w-56"><SelectValue :placeholder="t('ai.decision.off')" /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="OFF">{{ t('ai.decision.off') }}</SelectItem>
          <SelectItem v-for="opt in options" :key="opt.id" :value="opt.id">{{ opt.name }}</SelectItem>
        </SelectContent>
      </Select>
    </label>

    <p v-if="!decision.available" class="text-muted-foreground text-xs">
      {{ routedName ? t('ai.decision.notAppliedNamed', { name: routedName }) : t('ai.decision.unavailable') }}
    </p>
    <p v-else-if="!options.length && !routed" class="text-muted-foreground text-xs">{{ t('ai.decision.noGenApi') }}</p>

    <p class="text-muted-foreground flex gap-2 text-xs leading-relaxed">
      <Info class="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>{{ t('ai.decision.dataPath') }}</span>
    </p>

    <fieldset v-if="routed && decision.available" class="space-y-2">
      <legend class="text-muted-foreground mb-2 text-xs font-medium">
        {{ t('ai.decision.thresholds', { model: decision.tunedOn }) }}
      </legend>
      <div class="grid gap-3 sm:grid-cols-3">
        <label v-for="site in DECISION_SITES" :key="site" class="block space-y-1.5">
          <span class="text-xs">{{ t(`ai.decision.site.${site}`) }}</span>
          <Input
            v-model="form[site]"
            inputmode="decimal"
            :disabled="!canManage"
            :placeholder="decision.thresholds[site].effective.toFixed(2)"
            :aria-invalid="invalid(site) || undefined"
            @keydown.enter.prevent="saveThresholds"
          />
          <span v-if="invalid(site)" class="text-destructive block text-xs">{{ t('ai.decision.invalid') }}</span>
        </label>
      </div>
      <p class="text-muted-foreground text-xs">{{ t('ai.decision.thresholdsHint') }}</p>
      <Button v-if="canManage" type="button" size="sm" variant="outline" :disabled="!canSave || save.isPending.value" @click="saveThresholds">
        {{ t('common.save') }}
      </Button>
    </fieldset>
  </div>
</template>
