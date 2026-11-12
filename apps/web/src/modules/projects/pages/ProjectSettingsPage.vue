<script setup lang="ts">
/**
 * One project's policies (#928, docs/features/76): every workspace setting a
 * project may override, on one page. A setting resolves project → workspace →
 * default, and each row says all three: what the workspace set, what the
 * project set, and what applies.
 *
 * Who writes what is the API's rule, read from `settings/access` rather than
 * re-derived here: a workspace admin writes everything; the project's
 * maintainer (an editor holding `manage` on it) writes all but the two merge
 * gates, which they see disabled with the reason. Everyone else reads.
 *
 * One Save for the page. Only the groups that changed are sent, each to its
 * own route, so a refusal names the group it came from. A group whose section
 * is switched off (its read 404s) is absent, not disabled.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import {
  API_BREAKING_CHANGE_POLICIES,
  LINT_POLICIES,
  PROJECT_VERIFICATION_KEYS,
  WORK_ITEM_CONFLICT_RULES,
  WORK_ITEM_ISSUE_RULES,
  WORK_ITEM_VERIFICATION_RULES,
  type LintPolicySettings,
  type ProjectBreakingChangeSettings,
  type ProjectCaptureParentSettings,
  type ProjectSettingsAccess,
  type ProjectVerificationKey,
  type ProjectVerificationSettings,
  type ProjectWorkItemRules,
} from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { getWorkspaceId } from '@/shared/api/api'
import { formatNumber } from '@/shared/utils/format'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'
import { Autocomplete } from '@knowledge/ui/autocomplete'
import { Badge } from '@knowledge/ui/badge'
import { Button } from '@knowledge/ui/button'
import { Input } from '@knowledge/ui/input'
import { PageState } from '@knowledge/ui/layout'
import ProjectSettingRow from '@/modules/projects/components/ProjectSettingRow.vue'

const { t } = useI18n()
const route = useRoute()
const projects = useProjectsStore()
const documents = useDocumentsStore()
const workspaceId = getWorkspaceId()

const projectId = computed(() => String(route.params.id ?? ''))
const project = computed(() => projects.items.find((p) => p.projectId === projectId.value) ?? null)
const path = computed(() => ({ path: { id: projectId.value } }))
// A switched-off section answers 404: asking again would not change that.
const once = { retry: false } as const

const accessQuery = useQuery(computed(() => ({ ...apiQueryOptions('/v1/projects/{id}/settings/access', path.value), ...once })))
const verificationQuery = useQuery(computed(() => ({ ...apiQueryOptions('/v1/projects/{id}/settings/verification', path.value), ...once })))
const breakingQuery = useQuery(computed(() => ({ ...apiQueryOptions('/v1/projects/{id}/settings/breaking-changes', path.value), ...once })))
const lintQuery = useQuery(
  computed(() => ({ ...apiQueryOptions('/v1/lint-policy', { query: { workspaceId, projectId: projectId.value } }), ...once })),
)
const rulesQuery = useQuery(computed(() => ({ ...apiQueryOptions('/v1/projects/{id}/settings/work-items', path.value), ...once })))
const captureQuery = useQuery(computed(() => ({ ...apiQueryOptions('/v1/projects/{id}/settings/capture-parent', path.value), ...once })))
const queries = [accessQuery, verificationQuery, breakingQuery, lintQuery, rulesQuery, captureQuery]

const access = computed(() => accessQuery.data.value as ProjectSettingsAccess | undefined)
const verification = computed(() => verificationQuery.data.value as ProjectVerificationSettings | undefined)
const breaking = computed(() => breakingQuery.data.value as ProjectBreakingChangeSettings | undefined)
const lint = computed(() => lintQuery.data.value as LintPolicySettings | undefined)
const rules = computed(() => rulesQuery.data.value as ProjectWorkItemRules | undefined)
const capture = computed(() => captureQuery.data.value as ProjectCaptureParentSettings | undefined)

const canWrite = computed(() => access.value?.canWrite ?? false)
const canWriteGates = computed(() => access.value?.canWriteGates ?? false)
/** A maintainer sees the gates disabled with this beside them; a reader's page says read-only once, at the top. */
const gateReason = computed(() => (canWrite.value && !canWriteGates.value ? t('projectSettings.gates.adminOnly') : undefined))

// ---------------------------------------------------------------- the draft
/** '' and 'inherit' both mean "no project value": the workspace's applies. */
type Choice = string
const RULE_KEYS = ['issues', 'conflicts', 'verification'] as const
type RuleKey = (typeof RULE_KEYS)[number]
const RULE_OPTIONS: Record<RuleKey, readonly string[]> = {
  issues: WORK_ITEM_ISSUE_RULES,
  conflicts: WORK_ITEM_CONFLICT_RULES,
  verification: WORK_ITEM_VERIFICATION_RULES,
}
const UNITS: Record<ProjectVerificationKey, { unit: 'days' | 'chars'; max: number }> = {
  reviewIntervalDays: { unit: 'days', max: 3650 },
  remindBeforeDays: { unit: 'days', max: 3650 },
  inactiveAfterDays: { unit: 'days', max: 3650 },
  emptyMaxChars: { unit: 'chars', max: 100_000 },
}

const draft = reactive({
  verification: Object.fromEntries(PROJECT_VERIFICATION_KEYS.map((k) => [k, ''])) as Record<ProjectVerificationKey, string | number>,
  breaking: 'inherit' as Choice,
  lint: 'inherit' as Choice,
  rules: { issues: 'inherit', conflicts: 'inherit', verification: 'inherit' } as Record<RuleKey, Choice>,
  captureParent: [] as string[],
})
const text = (v: string | number) => String(v).trim()

function adoptVerification() {
  for (const k of PROJECT_VERIFICATION_KEYS) draft.verification[k] = verification.value?.[k].project?.toString() ?? ''
}
function adoptBreaking() {
  draft.breaking = breaking.value?.policy.project ?? 'inherit'
}
function adoptLint() {
  draft.lint = lint.value?.requested ?? 'inherit'
}
function adoptRules() {
  for (const k of RULE_KEYS) draft.rules[k] = rules.value?.[k].project ?? 'inherit'
}
function adoptCapture() {
  const own = capture.value?.parentDocumentId.project
  draft.captureParent = own ? [own] : []
}
watch(verification, adoptVerification, { immediate: true })
watch(breaking, adoptBreaking, { immediate: true })
watch(lint, adoptLint, { immediate: true })
watch(rules, adoptRules, { immediate: true })
watch(capture, adoptCapture, { immediate: true })

const parsed = (k: ProjectVerificationKey): number | null => (text(draft.verification[k]) === '' ? null : Number(text(draft.verification[k])))
function invalid(k: ProjectVerificationKey): boolean {
  const n = parsed(k)
  return n !== null && (!Number.isInteger(n) || n < 0 || n > UNITS[k].max)
}
const anyInvalid = computed(() => PROJECT_VERIFICATION_KEYS.some(invalid))
const chosen = (c: Choice) => (c === 'inherit' ? null : c)

const dirty = computed(() => ({
  verification: !!verification.value && PROJECT_VERIFICATION_KEYS.some((k) => parsed(k) !== verification.value![k].project),
  breaking: !!breaking.value && chosen(draft.breaking) !== breaking.value.policy.project,
  lint: !!lint.value && chosen(draft.lint) !== lint.value.requested,
  rules: !!rules.value && RULE_KEYS.some((k) => chosen(draft.rules[k]) !== rules.value![k].project),
  capture: !!capture.value && (draft.captureParent[0] ?? null) !== capture.value.parentDocumentId.project,
}))
const anyDirty = computed(() => Object.values(dirty.value).some(Boolean))

function discard() {
  adoptVerification()
  adoptBreaking()
  adoptLint()
  adoptRules()
  adoptCapture()
}

const saving = ref(false)
async function save() {
  if (saving.value || anyInvalid.value || !anyDirty.value) return
  saving.value = true
  const d = dirty.value
  const sends: Array<[() => Promise<unknown>, { refetch: () => unknown }]> = []
  if (d.verification) {
    const body = Object.fromEntries(PROJECT_VERIFICATION_KEYS.map((k) => [k, parsed(k)])) as Record<ProjectVerificationKey, number | null>
    sends.push([() => api.patch('/v1/projects/{id}/settings/verification', { ...path.value, body }), verificationQuery])
  }
  if (d.breaking) {
    const policy = chosen(draft.breaking) as ProjectBreakingChangeSettings['policy']['project']
    sends.push([() => api.patch('/v1/projects/{id}/settings/breaking-changes', { ...path.value, body: { policy } }), breakingQuery])
  }
  if (d.lint) {
    const policy = chosen(draft.lint) as LintPolicySettings['requested']
    sends.push([() => api.put('/v1/lint-policy', { body: { workspaceId, projectId: projectId.value, policy } }), lintQuery])
  }
  if (d.rules) {
    const body = Object.fromEntries(RULE_KEYS.map((k) => [k, chosen(draft.rules[k])])) as {
      [K in RuleKey]: ProjectWorkItemRules[K]['project']
    }
    sends.push([() => api.patch('/v1/projects/{id}/settings/work-items', { ...path.value, body }), rulesQuery])
  }
  if (d.capture) {
    const parentDocumentId = draft.captureParent[0] ?? null
    sends.push([() => api.patch('/v1/projects/{id}/settings/capture-parent', { ...path.value, body: { parentDocumentId } }), captureQuery])
  }
  // Each group is its own request: one refused does not undo the others, and its message says which.
  const results = await Promise.allSettled(sends.map(([send]) => send()))
  await Promise.all(sends.map(([, query]) => query.refetch()))
  saving.value = false
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed.length) for (const f of failed) toast.error(errorMessage(f.reason, t))
  else toast.success(t('projectSettings.saved'))
}

// ---------------------------------------------------------------- in words
function amount(k: ProjectVerificationKey, value: number): string {
  if (value === 0 && k === 'reviewIntervalDays') return t('verification.interval.never')
  if (value === 0 && UNITS[k].unit === 'days') return t('health.settings.off')
  return UNITS[k].unit === 'days' ? t('health.settings.days', { n: value }, value) : t('health.settings.chars', { n: formatNumber(value) }, value)
}
const gate = (value: string) => t(`apiSettings.breaking.mode.${value}.label`)
const rule = (k: RuleKey, value: string) => t(`workItems.rules.${k}.options.${value}`)
const pageOptions = computed(() =>
  documents.items.filter((d) => d.projectId === projectId.value).map((d) => ({ value: d.documentId, label: d.title, meta: d.category })),
)
const pageTitle = (id: string | null) => (id ? (documents.items.find((d) => d.documentId === id)?.title ?? t('projectSettings.capture.unknownPage')) : t('projectSettings.capture.root'))
watch(
  () => documents.loaded,
  (loaded) => {
    if (!loaded) void documents.fetchList()
  },
  { immediate: true },
)

const field = 'h-9 w-full rounded-md border bg-transparent px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50'
const links = computed(() => [
  { to: '/settings/glossary', label: t('projectSettings.links.glossary') },
  { to: '/settings/ai/styleguide', label: t('projectSettings.links.styleguide') },
  { to: '/settings/templates', label: t('projectSettings.links.templates') },
  { to: '/qa?tab=environments', label: t('projectSettings.links.environments') },
  { to: `/settings/projects/${projectId.value}/site`, label: t('projectSettings.links.site') },
])
</script>

<template>
  <PageState v-if="accessQuery.isPending.value" state="loading" :rows="6" row-class="h-14" />
  <PageState v-else-if="accessQuery.isError.value" state="error" :error="accessQuery.error.value" />

  <form v-else class="space-y-6" @submit.prevent="save">
    <header class="space-y-1">
      <div class="flex flex-wrap items-center gap-2">
        <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('projectSettings.title') }}</h1>
        <Badge v-if="!canWrite" variant="outline">{{ t('projectSettings.readOnly') }}</Badge>
      </div>
      <p class="kn-measure text-sm text-muted-foreground">
        {{ t('projectSettings.intro', { project: project?.name ?? '' }) }}
        <RouterLink :to="`/settings/projects/${projectId}`" class="text-primary hover:underline">{{ t('projectSettings.back') }}</RouterLink>
      </p>
    </header>

    <section v-if="verification" class="space-y-2" aria-labelledby="ps-verification">
      <div>
        <h2 id="ps-verification" class="text-sm font-semibold">{{ t('projectSettings.verification.title') }}</h2>
        <p class="kn-measure mt-0.5 text-xs text-muted-foreground">{{ t('projectSettings.verification.intro') }}</p>
      </div>
      <div class="divide-y rounded-md border">
        <ProjectSettingRow
          v-for="key in PROJECT_VERIFICATION_KEYS"
          :id="`ps-${key}`"
          :key="key"
          :label="t(`health.settings.key.${key}.label`)"
          :hint="t(`health.settings.key.${key}.hint`)"
          :applies="amount(key, verification[key].effective)"
          :source="verification[key].source"
          :workspace="amount(key, verification[key].inherited)"
          :set="text(draft.verification[key]) !== ''"
          :disabled="!canWrite"
          @reset="draft.verification[key] = ''"
        >
          <Input
            :id="`ps-${key}`"
            v-model="draft.verification[key]"
            type="number"
            inputmode="numeric"
            min="0"
            :max="UNITS[key].max"
            step="1"
            class="h-9 tabular-nums"
            :placeholder="formatNumber(verification[key].inherited)"
            :disabled="!canWrite"
            :aria-invalid="invalid(key) || undefined"
          />
        </ProjectSettingRow>
      </div>
    </section>

    <section v-if="breaking || lint" class="space-y-2" aria-labelledby="ps-gates">
      <div>
        <h2 id="ps-gates" class="text-sm font-semibold">{{ t('projectSettings.gates.title') }}</h2>
        <p class="kn-measure mt-0.5 text-xs text-muted-foreground">{{ t('projectSettings.gates.intro') }}</p>
      </div>
      <div class="divide-y rounded-md border">
        <ProjectSettingRow
          v-if="breaking"
          id="ps-breaking"
          :label="t('apiSettings.breaking.title')"
          :hint="t('projectSettings.gates.breakingHint')"
          :applies="gate(breaking.policy.effective)"
          :source="breaking.policy.source"
          :workspace="gate(breaking.policy.inherited)"
          :set="draft.breaking !== 'inherit'"
          :disabled="!canWriteGates"
          :reason="gateReason"
          @reset="draft.breaking = 'inherit'"
        >
          <select id="ps-breaking" v-model="draft.breaking" :class="field" :disabled="!canWriteGates" :aria-describedby="gateReason && 'ps-breaking-reason'">
            <option value="inherit">{{ t('projectSettings.inherit', { value: gate(breaking.policy.inherited) }) }}</option>
            <option v-for="p in API_BREAKING_CHANGE_POLICIES" :key="p" :value="p">{{ gate(p) }}</option>
          </select>
        </ProjectSettingRow>
        <ProjectSettingRow
          v-if="lint"
          id="ps-lint"
          :label="t('projectSettings.gates.lint')"
          :hint="lint.source === 'ceiling' ? t('projectSettings.gates.lintCeiling', { value: gate(lint.ceiling) }) : lint.source === 'agent-disabled' ? t('ai.styleguide.policy.noteAgentDisabled') : t('projectSettings.gates.lintHint')"
          :applies="gate(lint.effective)"
          :source="lint.requested !== null ? 'project' : 'workspace'"
          :workspace="gate(lint.inherited)"
          :set="draft.lint !== 'inherit'"
          :disabled="!canWriteGates"
          :reason="gateReason"
          @reset="draft.lint = 'inherit'"
        >
          <select id="ps-lint" v-model="draft.lint" :class="field" :disabled="!canWriteGates" :aria-describedby="gateReason && 'ps-lint-reason'">
            <option value="inherit">{{ t('projectSettings.inherit', { value: gate(lint.inherited) }) }}</option>
            <option v-for="p in LINT_POLICIES" :key="p" :value="p">{{ gate(p) }}</option>
          </select>
        </ProjectSettingRow>
      </div>
    </section>

    <section v-if="rules" class="space-y-2" aria-labelledby="ps-rules">
      <div>
        <h2 id="ps-rules" class="text-sm font-semibold">{{ t('workItems.rules.title') }}</h2>
        <p class="kn-measure mt-0.5 text-xs text-muted-foreground">
          {{ rules.routed ? t('projectSettings.rules.intro') : t('projectSettings.rules.noRoute') }}
        </p>
      </div>
      <div class="divide-y rounded-md border">
        <ProjectSettingRow
          v-for="key in RULE_KEYS"
          :id="`ps-rule-${key}`"
          :key="key"
          :label="t(`workItems.rules.${key}.label`)"
          :hint="t(`workItems.rules.${key}.hint`)"
          :applies="rule(key, rules[key].effective)"
          :source="rules[key].source"
          :workspace="rule(key, rules[key].inherited)"
          :set="draft.rules[key] !== 'inherit'"
          :disabled="!canWrite"
          @reset="draft.rules[key] = 'inherit'"
        >
          <select :id="`ps-rule-${key}`" v-model="draft.rules[key]" :class="field" :disabled="!canWrite">
            <option value="inherit">{{ t('projectSettings.inherit', { value: rule(key, rules[key].inherited) }) }}</option>
            <option v-for="o in RULE_OPTIONS[key]" :key="o" :value="o">{{ rule(key, o) }}</option>
          </select>
        </ProjectSettingRow>
      </div>
    </section>

    <section v-if="capture" class="space-y-2" aria-labelledby="ps-capture">
      <div>
        <h2 id="ps-capture" class="text-sm font-semibold">{{ t('projectSettings.capture.title') }}</h2>
        <p class="kn-measure mt-0.5 text-xs text-muted-foreground">{{ t('projectSettings.capture.intro') }}</p>
      </div>
      <div class="rounded-md border">
        <ProjectSettingRow
          id="ps-capture-parent"
          :label="t('projectSettings.capture.label')"
          :hint="capture.parentDocumentId.project && capture.parentDocumentId.source !== 'project' ? t('projectSettings.capture.stale') : undefined"
          :applies="pageTitle(capture.parentDocumentId.effective)"
          :source="capture.parentDocumentId.source"
          :workspace="pageTitle(capture.parentDocumentId.inherited)"
          :set="draft.captureParent.length > 0"
          :disabled="!canWrite"
          @reset="draft.captureParent = []"
        >
          <Autocomplete
            v-model="draft.captureParent"
            :label="t('projectSettings.capture.label')"
            hide-label
            :placeholder="t('projectSettings.capture.placeholder')"
            :multiple="false"
            :options="pageOptions"
            :fallback-label="(id: string) => pageTitle(id)"
            :empty-hint="t('glossary.noPagesInProject')"
            :disabled="!canWrite"
          />
        </ProjectSettingRow>
      </div>
    </section>

    <section class="space-y-2" aria-labelledby="ps-links">
      <div>
        <h2 id="ps-links" class="text-sm font-semibold">{{ t('projectSettings.links.title') }}</h2>
        <p class="kn-measure mt-0.5 text-xs text-muted-foreground">{{ t('projectSettings.links.intro') }}</p>
      </div>
      <ul class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <li v-for="link in links" :key="link.to">
          <RouterLink :to="link.to" class="text-primary hover:underline">{{ link.label }}</RouterLink>
        </li>
      </ul>
    </section>

    <PageState v-if="queries.some((q) => q.isPending.value)" state="loading" :rows="2" row-class="h-10" />

    <div v-if="canWrite" class="sticky bottom-0 -mx-1 flex items-center gap-2 border-t bg-background px-1 py-3">
      <Button type="submit" size="sm" :disabled="!anyDirty || anyInvalid || saving">
        {{ saving ? t('common.saving') : t('common.save') }}
      </Button>
      <Button type="button" variant="ghost" size="sm" :disabled="!anyDirty || saving" @click="discard">
        {{ t('common.discard') }}
      </Button>
    </div>
  </form>
</template>
