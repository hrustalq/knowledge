<script setup lang="ts">
// Styleguide (#74): the rules a team agreed on, in plain words, each with a
// severity. The linter checks text against them and nothing else. One for the
// workspace; a project may replace it with its own (replace, not merge, so a
// project can relax a rule). Rule ids are stable once saved: a finding, a
// thread and the quality dashboard name the rule by id after its text changes.
//
// The scope's lint policy sits beside its rules: whether merge requests on its
// pages are checked. It shows what the scope asks for and what applies, since
// the deployment's STYLE_LINT_POLICY and a disabled linter can both clamp it.
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BookCheck,
  Lightbulb,
  Plus,
  ScanText,
  Trash2,
} from 'lucide-vue-next'
import type {
  AssistantLintResponse,
  GetStyleguideResponse,
  LintPolicy,
  LintPolicySettings,
  StyleRule,
  StyleRuleSeverity,
} from '@knowledge/contracts'
import { STYLE_RULE_SEVERITIES, STYLE_RULE_TEXT_MAX } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { useProjectsStore } from '@/stores/projects'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { Input } from '@/shared/ui/input'
import { Skeleton } from '@/shared/ui/skeleton'
import { Textarea } from '@/shared/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog'
import AiEmptyState from './AiEmptyState.vue'

const { t } = useI18n()
const props = defineProps<{ canManage: boolean }>()

const workspaceId = getWorkspaceId()
const projects = useProjectsStore()
onMounted(() => {
  if (!projects.loaded) void projects.fetchList()
})

/** `workspace`, or a project id. */
const scope = ref<string>('workspace')
const projectId = computed(() => (scope.value === 'workspace' ? null : scope.value))
const projectName = computed(() => projects.items.find((p) => p.projectId === projectId.value)?.name ?? '')

const options = computed(() =>
  apiQueryOptions('/v1/ai/styleguides', {
    query: { workspaceId, ...(projectId.value ? { projectId: projectId.value } : {}) },
  }),
)
const query = useQuery(computed(() => options.value))
const data = computed(() => query.data.value as GetStyleguideResponse | undefined)
/** The styleguide shown here is this scope's own — not one it inherits. */
const own = computed(() => {
  const d = data.value
  if (!d?.styleguide) return null
  return (projectId.value ? d.scope === 'project' : d.scope === 'workspace') ? d.styleguide : null
})
/** A project with no styleguide of its own, reading the workspace's. */
const inherited = computed(() => (projectId.value && data.value?.scope === 'workspace' ? data.value.styleguide : null))
const maxRules = computed(() => data.value?.maxRules ?? 50)

const invalidates = () => [['/v1/ai/styleguides']]
const save = useApiMutation('put', '/v1/ai/styleguides', { invalidates })
const remove = useApiMutation('delete', '/v1/ai/styleguides/{id}', { invalidates })
const lint = useApiMutation('post', '/v1/assistant/lint')

// ---- Lint policy ------------------------------------------------------------

const policyQuery = useQuery(
  computed(() =>
    apiQueryOptions('/v1/lint-policy', {
      query: { workspaceId, ...(projectId.value ? { projectId: projectId.value } : {}) },
    }),
  ),
)
const policy = computed(() => policyQuery.data.value as LintPolicySettings | undefined)
const savePolicy = useApiMutation('put', '/v1/lint-policy', {
  invalidates: () => [['/v1/lint-policy'], ['/v1/merge-requests/{id}/checks']],
})
/** What a scope may ask for in this release; `block` comes with the merge gate. */
const POLICY_CHOICES = ['inherit', 'off', 'warn', 'block'] as const
const policyChoice = computed(() => policy.value?.requested ?? 'inherit')

async function choosePolicy(value: unknown) {
  const next = value === 'inherit' ? null : (value as Exclude<(typeof POLICY_CHOICES)[number], 'inherit'>)
  if (next === (policy.value?.requested ?? null)) return
  try {
    await savePolicy.mutateAsync({ body: { workspaceId, projectId: projectId.value, policy: next } })
    toast.success(t('ai.styleguide.policy.saved'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/** Why the policy that applies is the one it is — a message key and its arguments. */
const policyNote = computed(() => {
  const p = policy.value
  if (!p) return null
  const v = (x: LintPolicy) => t(`ai.styleguide.policy.value.${x}`)
  switch (p.source) {
    case 'agent-disabled':
      return t('ai.styleguide.policy.noteAgentDisabled')
    case 'inherited':
      return t('ai.styleguide.policy.noteInherited', { value: v(p.effective) })
    case 'ceiling':
      return p.requested
        ? t('ai.styleguide.policy.noteClamped', { asked: v(p.requested), ceiling: v(p.ceiling) })
        : t('ai.styleguide.policy.noteDefault', { value: v(p.effective) })
    default:
      return t('ai.styleguide.policy.noteScope', { value: v(p.effective) })
  }
})

// ---- The draft -----------------------------------------------------------

interface DraftRule extends StyleRule {
  /** The example fields are open — shown even while both sides are empty. */
  withExample: boolean
}
interface Draft {
  name: string
  description: string
  rules: DraftRule[]
}

const draft = ref<Draft | null>(null)
/** The draft as last loaded, to tell a change from a reload. */
const pristine = ref('')

function toDraft(source: { name: string; description: string; rules: StyleRule[] }): Draft {
  return {
    name: source.name,
    description: source.description,
    rules: source.rules.map((r) => ({
      ...r,
      example: r.example ? { ...r.example } : { bad: '', good: '' },
      withExample: Boolean(r.example),
    })),
  }
}

function load() {
  draft.value = own.value ? toDraft(own.value) : null
  pristine.value = JSON.stringify(draft.value)
}
watch(own, load, { immediate: true })

const dirty = computed(() => JSON.stringify(draft.value) !== pristine.value)

function start(from?: { rules: StyleRule[] }) {
  const name = projectId.value ? t('ai.styleguide.defaultProjectName', { project: projectName.value }) : t('ai.styleguide.defaultName')
  draft.value = toDraft({ name, description: '', rules: from?.rules ?? [] })
  if (!from) addRule()
}

/** `rule-<n>`, one past the highest in use: readable, and never reused within a styleguide. */
function nextId(): string {
  const used = (draft.value?.rules ?? []).map((r) => Number(/^rule-(\d+)$/.exec(r.id)?.[1] ?? 0))
  return `rule-${Math.max(0, ...used) + 1}`
}

function addRule() {
  if (!draft.value || draft.value.rules.length >= maxRules.value) return
  draft.value.rules.push({ id: nextId(), text: '', severity: 'warning', enabled: true, example: { bad: '', good: '' }, withExample: false })
}

function move(index: number, by: -1 | 1) {
  const rules = draft.value?.rules
  if (!rules) return
  const to = index + by
  if (to < 0 || to >= rules.length) return
  const [rule] = rules.splice(index, 1)
  rules.splice(to, 0, rule)
}

async function submit() {
  const d = draft.value
  if (!d) return
  const rules = d.rules
    .filter((r) => r.text.trim())
    .map(({ withExample: _open, example, ...r }) => ({
      ...r,
      text: r.text.trim(),
      ...(example && (example.bad.trim() || example.good.trim()) ? { example: { bad: example.bad, good: example.good } } : {}),
    }))
  try {
    await save.mutateAsync({
      body: { workspaceId, projectId: projectId.value, name: d.name.trim(), description: d.description.trim(), rules },
    })
    toast.success(t('ai.styleguide.saved'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

const removing = ref(false)
async function destroy() {
  removing.value = false
  const id = own.value?.id
  if (!id) return
  try {
    await remove.mutateAsync({ path: { id } })
    toast.success(t('ai.styleguide.deleted'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

// ---- Try it ----------------------------------------------------------------

const sample = ref('')
const result = ref<AssistantLintResponse | null>(null)
watch(scope, () => (result.value = null))

async function check() {
  if (!sample.value.trim()) return
  try {
    result.value = (await lint.mutateAsync({
      body: { workspaceId, ...(projectId.value ? { projectId: projectId.value } : {}), title: '', markdown: sample.value },
    })) as AssistantLintResponse
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/** The rules the last check ran against, to name a violation's rule. */
const ruleText = computed(() => {
  const rules = own.value?.rules ?? inherited.value?.rules ?? []
  return new Map(rules.map((r) => [r.id, r.text]))
})

const SEVERITY: Record<StyleRuleSeverity, { icon: typeof AlertCircle; tone: string; label: string }> = {
  error: { icon: AlertCircle, tone: 'text-panel-caution', label: 'mr.severityError' },
  warning: { icon: AlertTriangle, tone: 'text-panel-warning', label: 'mr.severityWarning' },
  suggestion: { icon: Lightbulb, tone: 'text-sky-500', label: 'mr.severitySuggestion' },
}

const readOnlyRules = computed(() => own.value?.rules ?? inherited.value?.rules ?? [])
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center gap-3 border-b pb-3">
      <label class="flex items-center gap-2 text-sm">
        <span class="text-muted-foreground">{{ t('ai.styleguide.scope') }}</span>
        <Select v-model="scope">
          <SelectTrigger class="h-8 w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="workspace">{{ t('ai.styleguide.scopeWorkspace') }}</SelectItem>
            <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <p class="text-muted-foreground text-sm">
        {{ projectId ? t('ai.styleguide.scopeProjectHint') : t('ai.styleguide.scopeWorkspaceHint') }}
      </p>
    </div>

    <!-- Whether merge requests in this scope are checked against its rules. -->
    <section v-if="policy" class="flex flex-wrap items-start gap-x-4 gap-y-2" aria-labelledby="kn-sg-policy">
      <div class="min-w-0 flex-1 basis-64">
        <h2 id="kn-sg-policy" class="text-sm font-medium">{{ t('ai.styleguide.policy.title') }}</h2>
        <p class="text-muted-foreground mt-0.5 text-xs">{{ policyNote }}</p>
      </div>
      <Select
        v-if="canManage"
        :model-value="policyChoice"
        :disabled="savePolicy.isPending.value"
        @update:model-value="choosePolicy"
      >
        <SelectTrigger class="h-8 w-56" :aria-label="t('ai.styleguide.policy.title')"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="c in POLICY_CHOICES" :key="c" :value="c">
            {{
              c === 'inherit'
                ? t(projectId ? 'ai.styleguide.policy.inheritProject' : 'ai.styleguide.policy.inheritDefault', {
                    value: t(`ai.styleguide.policy.value.${policy.inherited}`),
                  })
                : t(`ai.styleguide.policy.choice.${c}`)
            }}
          </SelectItem>
        </SelectContent>
      </Select>
    </section>

    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-16 w-full" />
    </div>

    <!-- Editing: this scope's own styleguide, or a new one. -->
    <form v-else-if="canManage && draft" class="space-y-5" @submit.prevent="submit">
      <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <label class="block space-y-1">
          <span class="text-muted-foreground text-xs font-medium">{{ t('ai.name') }}</span>
          <Input v-model="draft.name" required maxlength="120" />
        </label>
        <label class="block space-y-1">
          <span class="text-muted-foreground text-xs font-medium">{{ t('ai.description') }}</span>
          <Input v-model="draft.description" maxlength="500" :placeholder="t('ai.styleguide.descriptionPlaceholder')" />
        </label>
      </div>

      <section class="space-y-2" :aria-label="t('ai.styleguide.rules')">
        <div class="flex items-baseline justify-between gap-3">
          <h2 class="text-sm font-medium">{{ t('ai.styleguide.rules') }}</h2>
          <span class="text-muted-foreground text-xs tabular-nums">
            {{ t('ai.styleguide.ruleCount', { count: draft.rules.length, max: maxRules }) }}
          </span>
        </div>

        <ol class="space-y-2">
          <li
            v-for="(rule, i) in draft.rules"
            :key="rule.id"
            class="bg-card rounded-lg border p-3"
            :class="!rule.enabled && 'opacity-60'"
          >
            <div class="flex items-start gap-3">
              <span class="text-muted-foreground mt-2 w-5 shrink-0 text-right text-xs tabular-nums">{{ i + 1 }}.</span>
              <div class="min-w-0 flex-1 space-y-2">
                <Textarea
                  v-model="rule.text"
                  rows="2"
                  :maxlength="STYLE_RULE_TEXT_MAX"
                  :placeholder="t('ai.styleguide.rulePlaceholder')"
                  :aria-label="t('ai.styleguide.ruleText', { n: i + 1 })"
                />
                <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                  <Select v-model="rule.severity">
                    <SelectTrigger class="h-7 w-36 text-xs" :aria-label="t('ai.styleguide.severity')"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="s in STYLE_RULE_SEVERITIES" :key="s" :value="s">
                        <span class="inline-flex items-center gap-1.5">
                          <component :is="SEVERITY[s].icon" class="size-3.5" :class="SEVERITY[s].tone" />
                          {{ t(SEVERITY[s].label) }}
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <label class="inline-flex items-center gap-1.5">
                    <Checkbox :model-value="rule.enabled" @update:model-value="rule.enabled = $event === true" />
                    {{ t('ai.enabled') }}
                  </label>
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                    @click="rule.withExample = !rule.withExample"
                  >
                    {{ rule.withExample ? t('ai.styleguide.hideExample') : t('ai.styleguide.addExample') }}
                  </button>
                  <code class="text-muted-foreground ml-auto font-mono text-caption">{{ rule.id }}</code>
                </div>
                <div v-if="rule.withExample && rule.example" class="grid gap-2 sm:grid-cols-2">
                  <label class="block space-y-1">
                    <span class="text-xs font-medium text-panel-caution-ink">{{ t('ai.styleguide.exampleBad') }}</span>
                    <Input v-model="rule.example.bad" :maxlength="STYLE_RULE_TEXT_MAX" />
                  </label>
                  <label class="block space-y-1">
                    <span class="text-xs font-medium text-panel-tip-ink">{{ t('ai.styleguide.exampleGood') }}</span>
                    <Input v-model="rule.example.good" :maxlength="STYLE_RULE_TEXT_MAX" />
                  </label>
                </div>
              </div>
              <div class="flex shrink-0 flex-col gap-0.5">
                <Button type="button" variant="ghost" size="icon-sm" :disabled="i === 0" :aria-label="t('ai.styleguide.moveUp')" @click="move(i, -1)">
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  :disabled="i === draft.rules.length - 1"
                  :aria-label="t('ai.styleguide.moveDown')"
                  @click="move(i, 1)"
                >
                  <ArrowDown />
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" :aria-label="t('ai.styleguide.removeRule', { n: i + 1 })" @click="draft.rules.splice(i, 1)">
                  <Trash2 />
                </Button>
              </div>
            </div>
          </li>
        </ol>

        <Button type="button" variant="outline" size="sm" :disabled="draft.rules.length >= maxRules" @click="addRule">
          <Plus class="size-3.5" /> {{ t('ai.styleguide.addRule') }}
        </Button>
      </section>

      <div class="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button type="submit" size="sm" :disabled="save.isPending.value || !dirty || !draft.name.trim()">
          {{ t('common.save') }}
        </Button>
        <Button v-if="dirty" type="button" variant="outline" size="sm" @click="load">{{ t('ai.styleguide.discard') }}</Button>
        <Button v-if="own" type="button" variant="ghost" size="sm" class="text-destructive ml-auto" @click="removing = true">
          <Trash2 class="size-3.5" /> {{ t('ai.styleguide.delete') }}
        </Button>
      </div>
    </form>

    <!-- A project reading the workspace's styleguide. -->
    <div v-else-if="inherited" class="space-y-3">
      <div class="bg-muted/40 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm">
        <p>{{ t('ai.styleguide.inherits', { name: inherited.name }) }}</p>
        <Button v-if="canManage" size="sm" variant="outline" @click="start(inherited)">
          {{ t('ai.styleguide.override') }}
        </Button>
      </div>
      <ol class="space-y-1.5">
        <li v-for="(rule, i) in readOnlyRules" :key="rule.id" class="flex items-start gap-2 text-sm" :class="!rule.enabled && 'opacity-60'">
          <span class="text-muted-foreground w-5 shrink-0 text-right text-xs tabular-nums leading-5">{{ i + 1 }}.</span>
          <component :is="SEVERITY[rule.severity].icon" class="mt-0.5 size-4 shrink-0" :class="SEVERITY[rule.severity].tone" :aria-label="t(SEVERITY[rule.severity].label)" />
          <span>{{ rule.text }}</span>
        </li>
      </ol>
    </div>

    <!-- A member who cannot edit, reading the rules they are held to. -->
    <ol v-else-if="own" class="space-y-1.5">
      <li v-for="(rule, i) in readOnlyRules" :key="rule.id" class="flex items-start gap-2 text-sm" :class="!rule.enabled && 'opacity-60'">
        <span class="text-muted-foreground w-5 shrink-0 text-right text-xs tabular-nums leading-5">{{ i + 1 }}.</span>
        <component :is="SEVERITY[rule.severity].icon" class="mt-0.5 size-4 shrink-0" :class="SEVERITY[rule.severity].tone" :aria-label="t(SEVERITY[rule.severity].label)" />
        <span>{{ rule.text }}</span>
      </li>
    </ol>

    <AiEmptyState
      v-else
      :icon="BookCheck"
      :title="t('ai.styleguide.emptyTitle')"
      :body="t('ai.styleguide.emptyBody')"
      :example="{
        label: t('ai.forExample'),
        lines: [t('ai.styleguide.example1'), t('ai.styleguide.example2'), t('ai.styleguide.example3')],
      }"
    >
      <template #action>
        <Button v-if="props.canManage" size="sm" @click="start()"><Plus class="size-3.5" /> {{ t('ai.styleguide.create') }}</Button>
        <p v-else class="text-muted-foreground text-xs">{{ t('ai.adminCanAdd') }}</p>
      </template>
    </AiEmptyState>

    <!-- Try it: the same check the editor and the MCP tool run, against what is saved. -->
    <section v-if="own || inherited" class="space-y-3 border-t pt-5" :aria-labelledby="'kn-sg-try'">
      <div>
        <h2 id="kn-sg-try" class="text-sm font-medium">{{ t('ai.styleguide.tryTitle') }}</h2>
        <p class="text-muted-foreground mt-0.5 text-xs">
          {{ dirty ? t('ai.styleguide.tryUnsaved') : t('ai.styleguide.tryHint') }}
        </p>
      </div>
      <Textarea v-model="sample" rows="5" :placeholder="t('ai.styleguide.tryPlaceholder')" />
      <Button size="sm" variant="outline" :disabled="lint.isPending.value || !sample.trim()" @click="check">
        <ScanText class="size-3.5" /> {{ lint.isPending.value ? t('ai.styleguide.checking') : t('ai.styleguide.check') }}
      </Button>

      <div v-if="result" class="space-y-2" aria-live="polite">
        <p v-if="!result.enabled" class="text-muted-foreground text-sm">{{ t('ai.styleguide.linterOff') }}</p>
        <p v-else-if="result.violations.length === 0" class="text-sm">{{ t('ai.styleguide.clean') }}</p>
        <ul v-else class="space-y-2">
          <li v-for="(v, i) in result.violations" :key="i" class="bg-card rounded-lg border p-3 text-sm">
            <div class="flex items-start gap-2">
              <component :is="SEVERITY[v.severity].icon" class="mt-0.5 size-4 shrink-0" :class="SEVERITY[v.severity].tone" :aria-label="t(SEVERITY[v.severity].label)" />
              <div class="min-w-0 flex-1 space-y-1">
                <p>{{ v.message }}</p>
                <blockquote class="border-l-2 pl-2 font-mono text-xs break-words">{{ v.quote }}</blockquote>
                <p v-if="v.suggestion" class="text-xs">
                  <span class="text-muted-foreground">{{ t('ai.styleguide.suggestion') }}</span> {{ v.suggestion }}
                </p>
                <Badge variant="secondary" class="max-w-full truncate font-normal" :title="ruleText.get(v.ruleId)">
                  {{ ruleText.get(v.ruleId) ?? v.ruleId }}
                </Badge>
              </div>
            </div>
          </li>
        </ul>
        <p v-if="result.dropped > 0" class="text-muted-foreground text-xs">
          {{ t('ai.styleguide.dropped', { count: result.dropped }, result.dropped) }}
        </p>
      </div>
    </section>

    <AlertDialog :open="removing" @update:open="(v: boolean) => (removing = v)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('ai.styleguide.deleteTitle', { name: own?.name ?? '' }) }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ projectId ? t('ai.styleguide.deleteProjectBody') : t('ai.styleguide.deleteBody') }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="destroy">{{ t('common.delete') }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
