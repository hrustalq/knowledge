<script setup lang="ts">
/**
 * The configurator (#1250): describe a goal, review the changes it proposes,
 * apply some, all or none. The model only proposes — the API applies each
 * change through the same service its own settings screen writes with, checks
 * the role on execution (workspace admin for every current kind), and writes
 * schedules and triggers switched off. Model text is shown as plain text only.
 */
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { ArrowRight, CalendarClock, GitPullRequest, Sparkles, Zap } from 'lucide-vue-next'
import type {
  ConfigurationChange,
  ConfigurationChangeKind,
  ConfigurationProposal,
  ListConfigurationProposalsResponse,
  ProposeConfigurationResponse,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { getWorkspaceId, relativeTime } from '@/shared/api/api'
import { errorDetails, errorMessage } from '@/shared/api/errors'
import { formatCalendarPart, formatList } from '@/shared/utils/format'
import { usePermission } from '@/stores/permissions'
import { useProjectsStore } from '@/stores/projects'
import { Badge } from '@knowledge/ui/badge'
import { Button } from '@knowledge/ui/button'
import { Checkbox } from '@knowledge/ui/checkbox'
import { Textarea } from '@knowledge/ui/textarea'
import { AiEmptyState } from '@knowledge/ui/empty-state'

const { t } = useI18n()
const workspaceId = getWorkspaceId()
const canApply = usePermission('workspace:admin')
const projects = useProjectsStore()
void projects.fetchList()

const KEY = ['/v1/ai/configurator/proposals']
const list = useQuery(apiQueryOptions('/v1/ai/configurator/proposals', { query: { workspaceId } }))
const proposals = computed<ConfigurationProposal[]>(
  () => (list.data.value as ListConfigurationProposalsResponse | undefined)?.proposals ?? [],
)

const propose = useApiMutation('post', '/v1/ai/configurator/proposals', { invalidates: () => [KEY] })
const apply = useApiMutation('post', '/v1/ai/configurator/proposals/{id}/apply', {
  invalidates: () => [KEY, ['/v1/ai/agents'], ['/v1/ai/agents/triggers'], ['/v1/connectors']],
})
const dismiss = useApiMutation('post', '/v1/ai/configurator/proposals/{id}/dismiss', { invalidates: () => [KEY] })

const goal = ref('')
/** The reply of a propose that wrote no proposal: it says why, or asks. */
const reply = ref<string | null>(null)
const openId = ref<string | null>(null)
const open = computed(() => proposals.value.find((p) => p.id === openId.value) ?? null)

const picked = ref(new Set<string>())
const refused = ref<string | null>(null)
const pending = computed(() => open.value?.changes.filter((c) => c.state === 'pending') ?? [])
// A newly opened proposal starts with every pending change ticked: "apply all" is one press.
watch(openId, () => {
  picked.value = new Set(pending.value.map((c) => c.id))
  refused.value = null
})

async function submit() {
  const text = goal.value.trim()
  if (text.length < 5 || propose.isPending.value) return
  reply.value = null
  try {
    const res = (await propose.mutateAsync({
      body: { workspaceId, goal: text, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined },
    })) as ProposeConfigurationResponse
    if (res.proposal) {
      await list.refetch()
      openId.value = res.proposal.id
    } else {
      reply.value = res.reply
    }
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function applyPicked() {
  if (!open.value || !picked.value.size) return
  refused.value = null
  try {
    const asked = [...picked.value]
    const res = (await apply.mutateAsync({ path: { id: open.value.id }, body: { workspaceId, changeIds: asked } })) as ConfigurationProposal
    // What actually applied: a change configured by hand meanwhile lands unavailable instead.
    const done = res.changes.filter((c) => asked.includes(c.id) && c.state === 'applied').length
    if (done) toast.success(t('ai.configurator.applied', { count: done }, done))
    if (done < asked.length) toast.warning(t('ai.configurator.someUnavailable', { count: asked.length - done }, asked.length - done))
    picked.value = new Set()
  } catch (e) {
    const changeId = errorDetails(e)?.changeId
    refused.value = typeof changeId === 'string' ? changeId : null
    toast.error(errorMessage(e, t))
  }
}

async function dismissRest() {
  if (!open.value) return
  try {
    await dismiss.mutateAsync({ path: { id: open.value.id }, body: { workspaceId } })
    picked.value = new Set()
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

function toggle(id: string, on: boolean) {
  const next = new Set(picked.value)
  if (on) next.add(id)
  else next.delete(id)
  picked.value = next
}

const KIND_ICON: Record<ConfigurationChangeKind, typeof Zap> = {
  'agent-schedule': CalendarClock,
  'agent-trigger': Zap,
  'connector-drift-check': GitPullRequest,
}

/** A field's value in words. Null — nothing set — is a dash. 2026-10-11 is a Sunday. */
function show(field: string, value: unknown): string {
  if (value === null || value === undefined || (Array.isArray(value) && !value.length)) return '—'
  switch (field) {
    case 'scheduleKind':
      return t(`ai.configurator.scheduleKinds.${value}`)
    case 'scheduleWeekdays':
      return formatList((value as number[]).map((day) => formatCalendarPart(`2026-10-${11 + day}`, 'weekday')))
    case 'event':
      return t(`ai.triggers.events.${value}`)
    case 'mode':
      return t(`connectors.driftCheckMode.${value}`)
    case 'projectId':
      return projects.items.find((p) => p.projectId === value)?.name ?? String(value)
    case 'connectorIds':
      return t('ai.configurator.connectorCount', { count: (value as string[]).length }, (value as string[]).length)
  }
  return Array.isArray(value) ? formatList(value.map(String)) : String(value)
}

function stateText(change: ConfigurationChange): string | null {
  if (change.state === 'unavailable') return t(`ai.configurator.unavailable.${change.unavailable}`)
  if (change.state === 'applied') return t('ai.configurator.appliedAt', { when: relativeTime(change.appliedAt!) })
  if (change.state === 'dismissed') return t('ai.configurator.states.dismissed')
  return null
}

const lands = computed(() =>
  open.value?.changes.some((c) => c.state === 'applied' && c.spec.kind !== 'connector-drift-check'),
)
</script>

<template>
  <div class="max-w-4xl space-y-8">
    <form class="space-y-3" @submit.prevent="submit">
      <p class="text-muted-foreground text-sm">{{ t('ai.configurator.hint') }}</p>
      <label for="configurator-goal" class="sr-only">{{ t('ai.configurator.goalLabel') }}</label>
      <Textarea
        id="configurator-goal"
        v-model="goal"
        rows="3"
        maxlength="2000"
        :placeholder="t('ai.configurator.goalPlaceholder')"
        @keydown.meta.enter.prevent="submit"
        @keydown.ctrl.enter.prevent="submit"
      />
      <div class="flex flex-wrap items-center gap-3">
        <Button type="submit" :disabled="goal.trim().length < 5 || propose.isPending.value">
          <Sparkles class="size-4" />
          {{ propose.isPending.value ? t('ai.configurator.proposing') : t('ai.configurator.propose') }}
        </Button>
        <span v-if="propose.isPending.value" class="text-muted-foreground text-xs" role="status">
          {{ t('ai.configurator.reading') }}
        </span>
      </div>
      <p v-if="reply" class="bg-muted/50 rounded-md p-3 text-sm whitespace-pre-line" role="status">{{ reply }}</p>
    </form>

    <section v-if="open" class="space-y-4" :aria-label="t('ai.configurator.proposal')">
      <header class="space-y-1 border-b pb-3">
        <!-- The person's own words: a sentence, not a title, so it reads as one. -->
        <p class="font-medium">{{ open.goal }}</p>
        <p v-if="open.summary" class="text-muted-foreground text-sm whitespace-pre-line">{{ open.summary }}</p>
      </header>

      <ul class="divide-y">
        <li
          v-for="change in open.changes"
          :key="change.id"
          class="flex gap-3 py-4"
          :class="{ 'bg-destructive/5 -mx-3 rounded-md px-3': refused === change.id }"
        >
          <!-- Only a pending change is a choice; a settled one keeps the column. -->
          <span v-if="change.state !== 'pending'" class="w-4 shrink-0" aria-hidden="true" />
          <Checkbox
            v-else
            class="mt-1"
            :model-value="picked.has(change.id)"
            :disabled="!canApply"
            :aria-label="t('ai.configurator.pick', { target: change.target })"
            @update:model-value="toggle(change.id, !!$event)"
          />
          <div class="min-w-0 flex-1 space-y-2">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <component :is="KIND_ICON[change.spec.kind]" class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
              <span class="text-sm font-medium">{{ t(`ai.configurator.kinds.${change.spec.kind}`) }}</span>
              <span class="text-muted-foreground text-sm">·</span>
              <span class="truncate text-sm">{{ change.target }}</span>
              <Badge v-if="change.state !== 'pending'" variant="outline" class="ml-auto">
                {{ t(`ai.configurator.states.${change.state}`) }}
              </Badge>
            </div>
            <p v-if="change.reason" class="text-muted-foreground text-sm">{{ change.reason }}</p>
            <dl class="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr_1fr]">
              <div class="text-muted-foreground hidden text-xs sm:contents">
                <span />
                <span class="text-xs">{{ t('ai.configurator.today') }}</span>
                <span class="text-xs">{{ t('ai.configurator.proposed') }}</span>
              </div>
              <div v-for="row in change.diff" :key="row.field" class="flex flex-wrap items-baseline gap-x-3 sm:contents">
                <dt class="text-muted-foreground basis-full pt-1.5 text-xs sm:basis-auto sm:pt-0 sm:text-sm">{{ t(`ai.configurator.fields.${row.field}`) }}</dt>
                <!-- Below sm the column headings are gone, so each value names its side. -->
                <dd class="text-muted-foreground break-words">
                  <span class="text-xs sm:sr-only">{{ t('ai.configurator.today') }}: </span>{{ show(row.field, row.before) }}
                </dd>
                <dd class="font-medium break-words">
                  <span class="text-muted-foreground text-xs font-normal sm:sr-only">{{ t('ai.configurator.proposed') }}: </span>{{ show(row.field, row.after) }}
                </dd>
              </div>
            </dl>
            <p v-if="stateText(change)" class="text-muted-foreground text-xs">{{ stateText(change) }}</p>
          </div>
        </li>
      </ul>

      <div class="flex flex-wrap items-center gap-3">
        <template v-if="pending.length">
          <Button v-if="canApply" :disabled="!picked.size || apply.isPending.value" @click="applyPicked">
            {{ apply.isPending.value ? t('ai.configurator.applying') : t('ai.configurator.applySelected', { count: picked.size }) }}
          </Button>
          <Button variant="ghost" :disabled="dismiss.isPending.value" @click="dismissRest">
            {{ t('ai.configurator.dismissRest') }}
          </Button>
          <span v-if="!canApply" class="text-muted-foreground text-sm">{{ t('ai.configurator.adminApplies') }}</span>
        </template>
        <p class="text-muted-foreground w-full text-xs">
          {{ t('ai.configurator.landsOff') }}
          <RouterLink v-if="lands" to="/settings/ai/agents" class="text-primary ml-1 inline-flex items-center gap-1 hover:underline">
            {{ t('ai.configurator.openAgents') }} <ArrowRight class="size-3" />
          </RouterLink>
        </p>
      </div>
    </section>

    <section class="space-y-3">
      <h2 class="text-sm font-medium">{{ t('ai.configurator.history') }}</h2>
      <AiEmptyState
        v-if="list.isSuccess.value && !proposals.length"
        :icon="Sparkles"
        :title="t('ai.configurator.emptyTitle')"
        :body="t('ai.configurator.emptyBody')"
        :example="{ label: t('ai.configurator.examplesLabel'), lines: [t('ai.configurator.example1'), t('ai.configurator.example2')] }"
      />
      <ul v-else class="divide-y rounded-md border">
        <li v-for="p in proposals" :key="p.id">
          <button
            type="button"
            class="hover:bg-muted/50 focus-visible:ring-ring flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none"
            :class="{ 'bg-muted/50': p.id === openId }"
            :aria-current="p.id === openId ? 'true' : undefined"
            @click="openId = p.id"
          >
            <span class="min-w-0 flex-1 truncate">{{ p.goal }}</span>
            <span class="text-muted-foreground text-xs">
              {{ t('ai.configurator.changeCount', { count: p.changes.length }, p.changes.length) }} · {{ relativeTime(p.createdAt) }}
            </span>
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
