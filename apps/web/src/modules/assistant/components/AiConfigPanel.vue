<script setup lang="ts">
// The workspace's assistant settings. Providers save on their own, through their
// dialog (AiProvidersSection); this form is everything around them, and its
// fields are OVERRIDES of the env defaults: clearing one hands it back.
//
// That inheritance is the reason this form does not just POST its own state.
// The numeric inputs are pre-filled with the *effective* value, so a naive save
// would silently convert every inherited field into a workspace override the
// first time anyone pressed Save. Fields the user did not touch are sent as
// null — "keep inheriting" — and only edited fields become overrides.
import { useI18n } from 'vue-i18n'
import { formatDateTime } from '@/shared/utils/format'
import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type { AiSettingsResponse } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { Button } from '@knowledge/ui/button'
import { Checkbox } from '@knowledge/ui/checkbox'
import { Input } from '@knowledge/ui/input'
import { Skeleton } from '@knowledge/ui/skeleton'
import AiSettingsSection from './AiSettingsSection.vue'
import AiProvidersSection from './AiProvidersSection.vue'

const { t } = useI18n()

defineProps<{ canManage: boolean }>()

const workspaceId = getWorkspaceId()
const query = useQuery(apiQueryOptions('/v1/ai/settings', { query: { workspaceId } }))
const settings = computed(() => query.data.value as AiSettingsResponse | undefined)

type Form = {
  temperature: number
  maxToolCalls: number
  timeoutMs: number
  // Strings, unlike the three above: these must be clearable back to "inherit
  // the env value", and an emptied type="number" input cannot express that.
  extractionMinConfidence: string
  extractionMaxChunks: string
  /** Days a quality score stands (#74); empty inherits QUALITY_AUDIT_DAYS. */
  qualityAuditDays: string
  agentModeEnabled: boolean
  /** What the workspace asks for, or the ceiling it inherits (issue #68). */
  externalAiActions: boolean
  workspaceMonthlyTokenBudget: string
  defaultUserMonthlyTokenBudget: string
  enforceBudget: boolean
}

const form = ref<Form | null>(null)
/** The values the form loaded with — what "untouched" means when saving. */
const loaded = ref<Form | null>(null)

function formFrom(s: AiSettingsResponse): Form {
  return {
    temperature: s.temperature,
    maxToolCalls: s.maxToolCalls,
    timeoutMs: s.timeoutMs,
    // Left empty unless the workspace actually overrides it, so the placeholder
    // can show what is being inherited and emptying the box means "inherit".
    extractionMinConfidence:
      s.sources.extractionMinConfidence === 'db' ? s.extractionMinConfidence.toString() : '',
    extractionMaxChunks: s.sources.extractionMaxChunks === 'db' ? s.extractionMaxChunks.toString() : '',
    qualityAuditDays: s.qualityAudit.source === 'db' ? s.qualityAudit.days.toString() : '',
    agentModeEnabled: s.agentModeEnabled,
    externalAiActions: s.externalAiActions.requested ?? s.externalAiActions.ceiling,
    workspaceMonthlyTokenBudget: s.workspaceMonthlyTokenBudget?.toString() ?? '',
    defaultUserMonthlyTokenBudget: s.defaultUserMonthlyTokenBudget?.toString() ?? '',
    enforceBudget: s.enforceBudget,
  }
}

/**
 * A provider or a route saved on this page refetches these settings while the
 * form below may hold unsaved edits, so a refetch moves only the fields nobody
 * has touched. Replacing the whole form threw those edits away.
 */
function rebased(next: Form, current: Form, base: Form): Form {
  const out: Record<string, unknown> = { ...next }
  for (const key of Object.keys(next) as (keyof Form)[]) {
    if (current[key] !== base[key]) out[key] = current[key]
  }
  return out as Form
}

watch(
  settings,
  (s) => {
    if (!s) return
    const next = formFrom(s)
    form.value = form.value && loaded.value ? rebased(next, form.value, loaded.value) : next
    loaded.value = next
  },
  { immediate: true },
)

const dirty = computed(
  () => form.value !== null && loaded.value !== null && JSON.stringify(form.value) !== JSON.stringify(loaded.value),
)

/** "" → null (inherit / unlimited); a number → that number. */
function num(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const n = Number(trimmed.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/**
 * A field the user did not touch keeps its current layer: null when it was
 * inherited, its own value when it was already a workspace override.
 */
function override<K extends keyof Form>(key: K, source: keyof AiSettingsResponse['sources'] | null, value: unknown) {
  const untouched = form.value?.[key] === loaded.value?.[key]
  if (untouched && source && settings.value?.sources[source] === 'env') return null
  return value
}

const save = useApiMutation('patch', '/v1/ai/settings', { invalidates: () => [['/v1/ai/settings']] })

async function onSave() {
  const f = form.value
  if (!f) return
  await save.mutateAsync({
    body: {
      workspaceId,
      temperature: override('temperature', 'temperature', f.temperature) as number | null,
      maxToolCalls: override('maxToolCalls', 'maxToolCalls', f.maxToolCalls) as number | null,
      timeoutMs: override('timeoutMs', 'timeoutMs', f.timeoutMs) as number | null,
      // num(), not override(): these render empty when inherited, so an empty
      // box already means "inherit" and needs no untouched-field guard.
      extractionMinConfidence: num(f.extractionMinConfidence),
      extractionMaxChunks: num(f.extractionMaxChunks),
      qualityAuditDays: num(f.qualityAuditDays),
      agentModeEnabled: f.agentModeEnabled,
      // Sent only once touched: an inherited switch stays inherited, so a later
      // change to the env ceiling still reaches this workspace.
      ...(f.externalAiActions === loaded.value?.externalAiActions ? {} : { externalAiActions: f.externalAiActions }),
      workspaceMonthlyTokenBudget: num(f.workspaceMonthlyTokenBudget),
      defaultUserMonthlyTokenBudget: num(f.defaultUserMonthlyTokenBudget),
      enforceBudget: f.enforceBudget,
    },
  })
  toast.success(t('ai.settingsSaved'))
}

/**
 * Inheritance is the resting state, so it is the overrides that get marked.
 * Badging all seven fields "from env" on a fresh workspace put a bordered pill
 * beside every label and said nothing, since that is simply what a workspace
 * that has never been configured looks like.
 */
function overridden(field: keyof AiSettingsResponse['sources']): boolean {
  return settings.value?.sources[field] === 'db'
}

/** AI_EXTERNAL_ACTIONS_ENABLED — false takes "Open in…" away from every workspace. */
const externalCeiling = computed(() => settings.value?.externalAiActions.ceiling ?? true)
</script>

<template>
  <!-- Fills the column like the sibling tabs. It used to cap at 56rem, which
       left the form a narrow strip beside empty page on any wide screen; the
       width now goes to the controls, whose field groups gain columns as it
       grows (AiSettingsSection) instead of stretching one input across it. -->
  <div v-if="query.isPending.value" class="space-y-6">
    <div v-for="i in 3" :key="i" class="space-y-4 border-b py-6">
      <Skeleton class="h-4 w-32" />
      <div class="space-y-4">
        <Skeleton class="h-9 w-full" />
        <Skeleton class="h-9 w-full" />
      </div>
    </div>
  </div>

  <form v-else-if="form" @submit.prevent="onSave">
    <AiProvidersSection v-if="settings" :can-manage="canManage" :settings="settings" />

    <AiSettingsSection
      :title="t('ai.behavior')"
      :description="t('ai.behaviorDesc')"
    >
      <div class="grid gap-4 sm:grid-cols-3 xl:grid-cols-4">
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('ai.temperature') }}</span>
          <Input v-model.number="form.temperature" type="number" min="0" max="2" step="0.1" :disabled="!canManage" />
        </label>
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('ai.toolBudget') }}</span>
          <Input v-model.number="form.maxToolCalls" type="number" min="0" max="64" :disabled="!canManage" />
        </label>
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('ai.timeoutMs') }}</span>
          <Input v-model.number="form.timeoutMs" type="number" min="1000" max="600000" :disabled="!canManage" />
        </label>
      </div>
      <p class="text-muted-foreground text-xs leading-snug">{{ t('ai.behaviorAgentNote') }}</p>
      <label class="flex items-start gap-2.5">
        <Checkbox
          class="mt-0.5"
          :model-value="form.agentModeEnabled"
          :disabled="!canManage"
          @update:model-value="form.agentModeEnabled = $event === true"
        />
        <span class="text-sm leading-snug">
          {{ t('ai.allowAgentMode') }}
          <span class="text-muted-foreground mt-0.5 block text-xs">
            {{ t('ai.agentModeDesc') }}
          </span>
        </span>
      </label>
      <label class="flex items-start gap-2.5">
        <!-- The env ceiling can only take the actions away, so under a false
             ceiling the box is disabled and the note below says why rather than
             showing a setting that does nothing. -->
        <Checkbox
          class="mt-0.5"
          :model-value="form.externalAiActions && externalCeiling"
          :disabled="!canManage || !externalCeiling"
          @update:model-value="form.externalAiActions = $event === true"
        />
        <span class="text-sm leading-snug">
          {{ t('aiSettings.externalActions.label') }}
          <span v-if="overridden('externalAiActions')" class="text-primary ml-1.5 text-xs">
            {{ t('ai.overridden') }}
          </span>
          <span class="text-muted-foreground mt-0.5 block text-xs">
            {{ t('aiSettings.externalActions.hint') }}
          </span>
          <span v-if="!externalCeiling" class="text-muted-foreground mt-0.5 block text-xs">
            {{ t('aiSettings.externalActions.clampedByEnv') }}
          </span>
        </span>
      </label>
    </AiSettingsSection>

    <AiSettingsSection
      :title="t('ai.extraction')"
      :description="t('ai.extractionDesc')"
    >
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <label class="block space-y-1.5">
          <span class="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            {{ t('ai.extractionMinConfidence') }}
            <span v-if="overridden('extractionMinConfidence')" class="text-primary">
              {{ t('ai.overridden') }}
            </span>
          </span>
          <Input
            v-model="form.extractionMinConfidence"
            :disabled="!canManage"
            :placeholder="settings?.extractionMinConfidence?.toString()"
          />
        </label>
        <label class="block space-y-1.5">
          <span class="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            {{ t('ai.extractionMaxChunks') }}
            <span v-if="overridden('extractionMaxChunks')" class="text-primary">
              {{ t('ai.overridden') }}
            </span>
          </span>
          <Input
            v-model="form.extractionMaxChunks"
            :disabled="!canManage"
            :placeholder="settings?.extractionMaxChunks?.toString()"
          />
        </label>
      </div>
      <p class="text-muted-foreground text-xs leading-snug">{{ t('ai.extractionHint') }}</p>
    </AiSettingsSection>

    <!-- How often the auditor re-scores a page nobody changed (#74). Both
         halves are shown: what this workspace asks for, and what applies. -->
    <AiSettingsSection :title="t('ai.qualityAudit')" :description="t('ai.qualityAuditDesc')">
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <label class="block space-y-1.5">
          <span class="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            {{ t('ai.qualityAuditDays') }}
            <span v-if="settings?.qualityAudit.source === 'db'" class="text-primary">{{ t('ai.overridden') }}</span>
          </span>
          <Input
            v-model="form.qualityAuditDays"
            inputmode="numeric"
            :disabled="!canManage"
            :placeholder="settings?.qualityAudit.defaultDays.toString()"
          />
        </label>
      </div>
      <p v-if="settings" class="text-muted-foreground text-xs leading-snug">
        {{ t('ai.qualityAuditHint', { days: settings.qualityAudit.days, defaultDays: settings.qualityAudit.defaultDays }) }}
      </p>
    </AiSettingsSection>

    <AiSettingsSection
      :title="t('ai.budgets')"
      :description="t('ai.budgetsDesc')"
    >
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('ai.workspaceTokensPerMonth') }}</span>
          <Input v-model="form.workspaceMonthlyTokenBudget" :disabled="!canManage" :placeholder="t('ai.unlimited')" />
        </label>
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('ai.defaultPerUser') }}</span>
          <Input v-model="form.defaultUserMonthlyTokenBudget" :disabled="!canManage" :placeholder="t('ai.unlimited')" />
        </label>
      </div>
      <label class="flex items-start gap-2.5">
        <Checkbox
          class="mt-0.5"
          :model-value="form.enforceBudget"
          :disabled="!canManage"
          @update:model-value="form.enforceBudget = $event === true"
        />
        <span class="text-sm leading-snug">
          {{ t('ai.enforceBudget') }}
          <span class="text-muted-foreground mt-0.5 block text-xs">
            {{ t('ai.enforceBudgetDesc') }}
          </span>
        </span>
      </label>
    </AiSettingsSection>

    <!-- Sticky so Save stays reachable from any section of a long form.
         The negative bottom margin cancels the settings column's own py-6:
         without it the bar floats flush against the viewport while scrolling
         and then gains 32px of dead space under it at the end of the scroll,
         which reads as the buttons shifting. -->
    <div
      class="bg-background/85 sticky bottom-0 -mx-4 -mb-6 mt-2 flex flex-wrap items-center gap-3 border-t px-4 py-3 backdrop-blur lg:-mx-8 lg:px-8"
    >
      <Button type="submit" size="sm" :disabled="!canManage || !dirty || save.isPending.value">
        {{ save.isPending.value ? t('common.saving') : t('ai.saveChanges') }}
      </Button>

      <p v-if="dirty" class="text-muted-foreground text-xs">{{ t('ai.unsavedChanges') }}</p>
      <p v-else-if="settings?.updatedAt" class="text-muted-foreground text-xs">
        {{ t('ai.savedAt', { when: formatDateTime(settings.updatedAt) }) }}
      </p>
    </div>
  </form>
</template>
