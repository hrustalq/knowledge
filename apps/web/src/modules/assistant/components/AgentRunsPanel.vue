<script setup lang="ts">
// Background agent runs (docs/features/20). A run proposes; it never writes.
// The one action here is Propose, which opens a merge request against the page
// a finding cites — still not a change to the live page, just one a person can
// review and merge. Or Dismiss (#70): the finding is wrong, hide it and tell
// the agent's next runs, optionally with a learning saying why. Or Add to
// glossary (#74), for a term the glossarist proposed.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import {
  BookA,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  FilePlus2,
  GitPullRequest,
  GraduationCap,
  Info,
  Link2,
  Loader2,
  OctagonAlert,
  TriangleAlert,
  X,
} from 'lucide-vue-next'
import { AGENT_LEARNING_MAX_CHARS } from '@knowledge/contracts'
import type {
  AddFindingTermResponse,
  AgentFinding,
  AgentRunSummary,
  DismissAgentFindingResponse,
  ListAgentRunsResponse,
  ListConnectorsResponse,
} from '@knowledge/contracts'
import { toast } from 'vue-sonner'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { Button } from '@/shared/ui/button'
import { getWorkspaceId } from '@/shared/api/api'
import { relativeTime } from '@/shared/api/api'
import { Badge } from '@/shared/ui/badge'
import { Skeleton } from '@/shared/ui/skeleton'
import { Checkbox } from '@/shared/ui/checkbox'
import { Textarea } from '@/shared/ui/textarea'
import { Input } from '@/shared/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { useAuthStore } from '@/stores/auth'
import { labelFor } from '@/shared/i18n/labels'
// The same chip the assistant cites with (docs/features/25). A finding's web
// sources are citations of exactly that kind, and rendering them a second way
// here would make one thing look like two.
import { SourceChip } from '@/entities/assistant'
import { AiEmptyState } from '@/shared/ui/empty-state'

const { t } = useI18n()

const workspaceId = getWorkspaceId()
const query = useQuery({
  ...apiQueryOptions('/v1/ai/agents/runs', { query: { workspaceId } }),
  // A run writes its stage as it goes (docs/features/29), which is only worth
  // anything if the page asks again. Polled while something is in flight and
  // not otherwise: a finished list is finished, and a background tab of settled
  // runs should not be re-fetching every five seconds forever.
  refetchInterval: (q) => {
    const runs = (q.state.data as ListAgentRunsResponse | undefined)?.runs ?? []
    return runs.some((r) => r.status === 'pending' || r.status === 'running') ? 5_000 : false
  },
})
const runs = computed<AgentRunSummary[]>(
  () => (query.data.value as ListAgentRunsResponse | undefined)?.runs ?? [],
)
const counts = computed(() => (query.data.value as ListAgentRunsResponse | undefined)?.counts)

const proposeFinding = useApiMutation('post', '/v1/ai/agents/runs/{id}/findings/{index}/propose', {
  invalidates: () => [['/v1/ai/agents/runs'], ['/v1/merge-requests']],
})
const applyRelations = useApiMutation('post', '/v1/ai/agents/runs/{id}/findings/{index}/apply-relations', {
  invalidates: () => [['/v1/ai/agents/runs'], ['/v1/merge-requests'], ['/v1/documents']],
})
const createPage = useApiMutation('post', '/v1/ai/agents/runs/{id}/findings/{index}/create-page', {
  invalidates: () => [['/v1/ai/agents/runs'], ['/v1/documents']],
})
const markOutdated = useApiMutation('post', '/v1/ai/agents/runs/{id}/findings/{index}/mark-outdated', {
  invalidates: () => [['/v1/ai/agents/runs'], ['/v1/documents'], ['/v1/knowledge-health']],
})
/** Which finding is mid-flight, so only its own button spins. */
const proposing = ref<string | null>(null)

/**
 * Which repository a run read (docs/features/31), by name. The run row carries
 * only the connector id; the connectors list is one query the settings page
 * already makes, and an id nobody can read is not a label.
 */
const connectorsQuery = useQuery(apiQueryOptions('/v1/connectors', { query: { workspaceId } }))
const repositoryName = (run: AgentRunSummary): string | null => {
  const id = run.input?.connectorId
  if (!id) return null
  const rows = (connectorsQuery.data.value as ListConnectorsResponse | undefined)?.connectors ?? []
  return rows.find((c) => c.id === id)?.name ?? null
}

/**
 * Three verbs, because there are three kinds of fix.
 *
 * `propose` rewrites page prose, and the server refuses it for a finding whose
 * fix is a relation — an orphan page has nothing to rewrite. Those have a verb
 * of their own: a finding that carries relations is *applied*, editing only the
 * page's frontmatter. And a finding that carries a draft (docs/features/31)
 * cites source files, not pages, so there is nothing to rewrite or declare — it
 * is *created*, as a new page. A created finding then cites its page, which
 * is why a draft finding is never proposable even once it has a document.
 *
 * Except one: a sentinel finding (docs/features/35) carries a draft *and*
 * cites a page from the start — the draft is the corrected page, and proposing
 * publishes it as a merge request without a second model call. The two are
 * told apart by the claim: creating a page leaves `proposedAt` set for good.
 */
function canPropose(f: AgentFinding): boolean {
  if (f.mergeRequestId || f.kind === 'orphan' || f.kind === 'relation' || f.documentIds.length === 0) return false
  // A proposed glossary term is fixed in the glossary, not in the page it was found on.
  if (f.term) return false
  return !f.draft || !f.proposedAt
}

function canApplyRelations(f: AgentFinding): boolean {
  return !f.mergeRequestId && (f.relations?.length ?? 0) > 0 && f.documentIds.length > 0
}

/** A component draft (#236) opens as a merge request on its own, so it is never created directly. */
function canCreatePage(run: AgentRunSummary, f: AgentFinding): boolean {
  return !run.input?.component && !!f.draft && f.documentIds.length === 0 && !f.proposedAt
}

/**
 * A fourth verb, for a stale finding only (docs/features/39): declare the page
 * wrong without a fix. It sits beside Propose rather than replacing it — a
 * page can be marked outdated now and corrected later — and is offered once.
 */
function canMarkOutdated(f: AgentFinding): boolean {
  return f.kind === 'stale' && f.documentIds.length > 0 && !f.flaggedAt
}

async function outdate(run: AgentRunSummary, index: number) {
  proposing.value = `${run.id}:${index}:outdated`
  try {
    const res = (await markOutdated.mutateAsync({
      path: { id: run.id, index },
      query: { workspaceId },
    })) as { documentTitle: string }
    toast.success(t('ai.runs.markedOutdated', { title: res.documentTitle }))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    proposing.value = null
  }
}

async function create(run: AgentRunSummary, index: number) {
  proposing.value = `${run.id}:${index}`
  try {
    const res = (await createPage.mutateAsync({
      path: { id: run.id, index },
      query: { workspaceId },
    })) as { documentId: string; title: string }
    toast.success(t('ai.runs.pageCreated', { title: res.title }))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    proposing.value = null
  }
}

async function propose(run: AgentRunSummary, index: number) {
  proposing.value = `${run.id}:${index}`
  try {
    const res = await proposeFinding.mutateAsync({
      path: { id: run.id, index },
      query: { workspaceId },
    })
    toast.success(t('ai.runs.proposed', { title: (res as { title: string }).title }))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    proposing.value = null
  }
}

async function apply(run: AgentRunSummary, index: number) {
  proposing.value = `${run.id}:${index}`
  try {
    const res = (await applyRelations.mutateAsync({
      path: { id: run.id, index },
      query: { workspaceId },
    })) as { changed: boolean; title: string | null }
    // The page already declared everything the finding proposed — someone got
    // there first. Nothing was opened, and saying so beats a success toast
    // pointing at a merge request that does not exist.
    if (res.changed) toast.success(t('ai.runs.relationsApplied', { title: res.title ?? '' }))
    else toast.info(t('ai.runs.nothingToApply'))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    proposing.value = null
  }
}

/**
 * Dismiss (#70). Set once on the server; a dismissed finding is hidden unless
 * the reader asks to see them, and the agent's next runs are told about it.
 * "Remember why" turns the reason into a proposed learning an admin reviews.
 */
const auth = useAuthStore()
const dismissFinding = useApiMutation('post', '/v1/ai/agents/runs/{id}/findings/{index}/dismiss', {
  invalidates: () => [['/v1/ai/agents/runs'], ['/v1/ai/agents/learnings']],
})
const dismissing = ref<{ run: AgentRunSummary; index: number } | null>(null)
const dismissForm = ref({ learning: '', allAgents: false })
const dismissOpen = computed({
  get: () => dismissing.value !== null,
  set: (open: boolean) => {
    if (!open) dismissing.value = null
  },
})
function askDismiss(run: AgentRunSummary, index: number) {
  dismissForm.value = { learning: '', allAgents: false }
  dismissing.value = { run, index }
}
async function confirmDismiss() {
  const target = dismissing.value
  if (!target) return
  const learning = dismissForm.value.learning.trim()
  try {
    const res = (await dismissFinding.mutateAsync({
      path: { id: target.run.id, index: target.index },
      query: { workspaceId },
      body: { ...(learning ? { learning, allAgents: dismissForm.value.allAgents } : {}) },
    })) as DismissAgentFindingResponse
    toast.success(res.learningId ? t('ai.runs.dismissedWithLearning') : t('ai.runs.dismissedToast'))
    dismissing.value = null
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/**
 * Add to glossary (#74). The glossarist drafted the entry; this opens it in a
 * dialog so a person can correct the model before it becomes vocabulary. The
 * project is not offered: the term lands where its page lives.
 */
const addTerm = useApiMutation('post', '/v1/ai/agents/runs/{id}/findings/{index}/add-term', {
  invalidates: () => [['/v1/ai/agents/runs'], ['/v1/glossary']],
})
const addingTerm = ref<{ run: AgentRunSummary; index: number } | null>(null)
const termForm = ref({ term: '', aliases: '', definition: '' })
const addTermOpen = computed({
  get: () => addingTerm.value !== null,
  set: (open: boolean) => {
    if (!open) addingTerm.value = null
  },
})
function canAddTerm(f: AgentFinding): boolean {
  return auth.canEdit && !!f.term && !f.termId && !f.dismissedAt
}
function askAddTerm(run: AgentRunSummary, index: number) {
  const proposed = run.findings[index]?.term
  if (!proposed) return
  termForm.value = { term: proposed.term, aliases: proposed.aliases.join(', '), definition: proposed.definition }
  addingTerm.value = { run, index }
}
async function confirmAddTerm() {
  const target = addingTerm.value
  const f = termForm.value
  if (!target || !f.term.trim() || !f.definition.trim()) return
  try {
    const res = (await addTerm.mutateAsync({
      path: { id: target.run.id, index: target.index },
      query: { workspaceId },
      body: {
        term: f.term.trim(),
        definition: f.definition.trim(),
        aliases: f.aliases.split(',').map((a) => a.trim()).filter(Boolean),
      },
    })) as AddFindingTermResponse
    toast.success(t('ai.runs.termAdded', { term: res.term }))
    addingTerm.value = null
  } catch (e) {
    toast.error((e as Error).message)
  }
}

const showDismissed = ref(false)
/** The findings to list, each with its index in the run — every verb addresses a finding by it. */
function findingRows(run: AgentRunSummary): Array<{ f: AgentFinding; i: number }> {
  return run.findings.map((f, i) => ({ f, i })).filter(({ f }) => showDismissed.value || !f.dismissedAt)
}
const dismissedCount = (run: AgentRunSummary) => run.findings.filter((f) => f.dismissedAt).length

const expanded = ref<string | null>(null)
function toggle(id: string) {
  expanded.value = expanded.value === id ? null : id
}

const STATUS_ICON = {
  pending: Clock,
  running: Loader2,
  succeeded: CircleCheck,
  failed: CircleAlert,
  // Its own shape: a cancelled run is not a failed one, and the icon is what
  // a reader scans the list by.
  cancelled: CircleSlash,
} as const

// Info is not a check mark: a tick next to a finding reads as "resolved".
const SEVERITY_ICON = { info: Info, warning: TriangleAlert, error: CircleAlert } as const
const severityClass = (f: AgentFinding) =>
  f.severity === 'error'
    ? 'text-destructive dark:text-destructive-foreground'
    : f.severity === 'warning'
      ? 'text-panel-warning-ink'
      : 'text-muted-foreground'
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <p class="text-muted-foreground text-sm">{{ t('ai.runs.subtitle') }}</p>
      <div v-if="counts" class="flex flex-wrap gap-1.5">
        <Badge v-for="(n, status) in counts" :key="status" variant="outline" class="font-normal">
          {{ t(`ai.runs.status.${status}`) }} {{ n }}
        </Badge>
      </div>
    </div>

    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-12 w-full" />
    </div>

    <AiEmptyState
      v-else-if="runs.length === 0"
      :icon="Clock"
      :title="t('ai.runs.emptyTitle')"
      :body="t('ai.runs.emptyBody')"
    />

    <ul v-else class="space-y-2">
      <li v-for="run in runs" :key="run.id" class="rounded-md border">
        <button
          class="flex w-full items-start gap-3 p-3 text-left"
          :aria-expanded="expanded === run.id"
          @click="toggle(run.id)"
        >
          <!-- The status is said, not only drawn: the icon is the one place a
               run's outcome shows in the row. -->
          <component
            :is="STATUS_ICON[run.status]"
            class="mt-0.5 size-4 shrink-0"
            role="img"
            :aria-label="t(`ai.runs.status.${run.status}`)"
            :class="[
              run.status === 'failed' && 'text-destructive dark:text-destructive-foreground',
              run.status === 'succeeded' && 'text-panel-tip-ink',
              run.status === 'running' && 'animate-spin',
            ]"
          />
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-center gap-2">
              <span class="font-medium">{{ run.agentName }}</span>
              <!-- What started it. An event run names its event (#70) in place
                   of the generic "on event", which said the same thing twice. -->
              <Badge variant="secondary" class="font-normal">
                {{
                  run.input?.event
                    ? t(`ai.triggers.events.${run.input.event.type}`)
                    : t(`ai.runs.trigger.${run.trigger}`)
                }}
              </Badge>
              <Badge v-if="repositoryName(run)" variant="outline" class="font-normal">{{ repositoryName(run) }}</Badge>
              <!-- The change a sentinel run checked (docs/features/35). Text, not
                   a link: this sits inside the row's toggle button, where a link
                   is invalid markup — each finding's source chip links out. -->
              <Badge v-if="run.input?.pullRequest" variant="outline" class="max-w-64 font-normal">
                <span class="truncate">#{{ run.input.pullRequest.number }} {{ run.input.pullRequest.title }}</span>
              </Badge>
              <span v-if="run.findingCount" class="text-muted-foreground text-xs">
                {{ t('ai.runs.findings', { count: run.findingCount }) }}
              </span>
            </span>
            <span class="text-muted-foreground mt-0.5 block text-xs">
              {{ run.summary || run.error || t('ai.runs.noSummary') }}
            </span>
            <!-- What it is doing, while it is doing it (docs/features/29).
                 Only while it runs: a finished run's last stage is noise next to
                 the summary, which says what it actually did. The stage is free
                 text from the executor, so it resolves through labelFor and
                 falls back to itself rather than rendering a message key. -->
            <span v-if="run.status === 'running' && run.stage" class="mt-1.5 flex items-center gap-2">
              <span class="text-muted-foreground text-caption">{{ labelFor(t, 'ai.runs.stage', run.stage) }}</span>
              <span v-if="run.progress !== null" class="bg-muted h-1 w-20 overflow-hidden rounded-full">
                <span
                  class="bg-primary block h-full rounded-full transition-[width] duration-500"
                  :style="{ width: `${Math.round(run.progress * 100)}%` }"
                />
              </span>
            </span>
          </span>
          <span class="text-muted-foreground shrink-0 text-xs">{{ relativeTime(run.createdAt) }}</span>
        </button>

        <!-- What degraded without failing the run (docs/features/29). On expand
             rather than in the row: it qualifies the findings, and a run that
             warned is still a run that succeeded — putting it in the row would
             read as a failure. -->
        <ul v-if="expanded === run.id && run.warnings.length" class="space-y-1 border-t px-3 py-2">
          <li v-for="(w, i) in run.warnings" :key="i" class="flex gap-2 text-caption text-panel-warning-ink">
            <TriangleAlert class="mt-0.5 size-3 shrink-0" />
            <span>{{ w }}</span>
          </li>
        </ul>

        <!-- Dismissed findings are hidden by default (#70); one switch shows them. -->
        <label
          v-if="expanded === run.id && dismissedCount(run) > 0"
          class="text-muted-foreground flex cursor-pointer items-center gap-2 border-t px-3 py-2 text-xs"
        >
          <Checkbox :model-value="showDismissed" @update:model-value="showDismissed = $event === true" />
          {{ t('ai.runs.showDismissed', { count: dismissedCount(run) }) }}
        </label>

        <ul v-if="expanded === run.id && findingRows(run).length" class="space-y-2 border-t px-3 py-3">
          <li v-for="{ f, i } in findingRows(run)" :key="i" class="flex gap-2.5" :class="f.dismissedAt && 'opacity-60'">
            <component :is="SEVERITY_ICON[f.severity]" class="mt-0.5 size-3.5 shrink-0" :class="severityClass(f)" />
            <div class="min-w-0">
              <p class="text-sm font-medium">
                {{ f.title }}
                <Badge v-if="f.dismissedAt" variant="outline" class="ml-1 align-middle font-normal">
                  {{ t('ai.runs.dismissed') }}
                </Badge>
              </p>
              <p class="text-muted-foreground text-xs leading-relaxed">{{ f.detail }}</p>
              <!-- The page this finding would become (docs/features/31), named
                   so a reader knows what Create page creates before pressing it.
                   Once created, the page link below replaces it. -->
              <p v-if="f.draft && f.documentIds.length === 0" class="mt-1 text-xs">
                <FilePlus2 class="mr-1 inline size-3 align-[-2px]" />{{ t('ai.runs.proposedPage', { title: f.draft.title }) }}
              </p>
              <!-- The citation is the point: a finding that names no page is
                   dropped server-side, so every one of these resolves. -->
              <p class="mt-1 flex flex-wrap gap-1">
                <RouterLink
                  v-for="(id, n) in f.documentIds"
                  :key="id"
                  :to="`/documents/${id}`"
                  class="text-primary text-caption hover:underline"
                >
                  {{ f.documentTitles[n] ?? id }}
                </RouterLink>
              </p>
              <!-- Pages on the open web the finding rests on (docs/features/29).
                   The same chip the assistant cites with, so one kind of thing
                   reads one way wherever it appears — and it carries its host
                   out loud, because clicking it leaves the product. -->
              <p v-if="f.sources?.length" class="mt-1 flex flex-wrap gap-1">
                <SourceChip v-for="s in f.sources" :key="s.url" :source="s" />
              </p>
            </div>
            <div class="ml-auto flex shrink-0 flex-col items-end gap-1">
              <!-- Already acted on: the link replaces the button, so the same
                   finding cannot open a second merge request. -->
              <RouterLink
                v-if="f.mergeRequestId"
                :to="`/merge-requests/${f.mergeRequestId}`"
                class="text-primary inline-flex items-center gap-1 text-caption hover:underline"
              >
                <GitPullRequest class="size-3" /> {{ t('ai.runs.viewProposal') }}
              </RouterLink>
              <Button
                v-else-if="canApplyRelations(f)"
                variant="outline"
                size="sm"
                :disabled="proposing !== null"
                @click="apply(run, i)"
              >
                <Loader2 v-if="proposing === `${run.id}:${i}`" class="size-3.5 animate-spin" />
                <Link2 v-else class="size-3.5" />
                {{ t('ai.runs.applyRelations') }}
              </Button>
              <Button
                v-else-if="canPropose(f)"
                variant="outline"
                size="sm"
                :disabled="proposing !== null"
                @click="propose(run, i)"
              >
                <Loader2 v-if="proposing === `${run.id}:${i}`" class="size-3.5 animate-spin" />
                <GitPullRequest v-else class="size-3.5" />
                {{ t('ai.runs.propose') }}
              </Button>
              <Button
                v-else-if="canCreatePage(run, f)"
                variant="outline"
                size="sm"
                :disabled="proposing !== null"
                @click="create(run, i)"
              >
                <Loader2 v-if="proposing === `${run.id}:${i}`" class="size-3.5 animate-spin" />
                <FilePlus2 v-else class="size-3.5" />
                {{ t('ai.runs.createPage') }}
              </Button>
              <RouterLink
                v-if="f.termId"
                :to="`/settings/glossary?term=${f.termId}`"
                class="text-primary inline-flex items-center gap-1 text-caption hover:underline"
              >
                <BookA class="size-3" /> {{ t('ai.runs.viewTerm') }}
              </RouterLink>
              <Button
                v-else-if="canAddTerm(f)"
                variant="outline"
                size="sm"
                :disabled="proposing !== null"
                @click="askAddTerm(run, i)"
              >
                <BookA class="size-3.5" />
                {{ t('ai.runs.addTerm') }}
              </Button>
              <Button
                v-if="canMarkOutdated(f)"
                variant="ghost"
                size="sm"
                :disabled="proposing !== null"
                @click="outdate(run, i)"
              >
                <Loader2 v-if="proposing === `${run.id}:${i}:outdated`" class="size-3.5 animate-spin" />
                <OctagonAlert v-else class="size-3.5" />
                {{ t('ai.runs.markOutdated') }}
              </Button>
              <span v-else-if="f.flaggedAt" class="text-muted-foreground text-caption">
                {{ t('ai.runs.outdatedMarked') }}
              </span>
              <Button
                v-if="auth.canEdit && !f.dismissedAt && !f.mergeRequestId && !f.termId"
                variant="ghost"
                size="sm"
                class="text-muted-foreground"
                :disabled="proposing !== null"
                @click="askDismiss(run, i)"
              >
                <X class="size-3.5" /> {{ t('ai.runs.dismiss') }}
              </Button>
              <RouterLink
                v-else-if="f.learningId"
                to="/settings/ai/learnings"
                class="text-primary inline-flex items-center gap-1 text-caption hover:underline"
              >
                <GraduationCap class="size-3" /> {{ t('ai.runs.learningProposed') }}
              </RouterLink>
            </div>
          </li>
        </ul>
      </li>
    </ul>

    <Dialog v-model:open="addTermOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ t('ai.runs.addTermTitle') }}</DialogTitle>
          <DialogDescription>
            {{ t('ai.runs.addTermDesc', { page: addingTerm?.run.findings[addingTerm.index]?.documentTitles[0] ?? '' }) }}
          </DialogDescription>
        </DialogHeader>
        <form id="kn-add-finding-term" class="space-y-3" @submit.prevent="confirmAddTerm">
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('glossary.term') }}</span>
            <Input v-model="termForm.term" required maxlength="80" />
          </label>
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('glossary.aliases') }}</span>
            <Input v-model="termForm.aliases" :placeholder="t('glossary.aliasesPlaceholder')" />
          </label>
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('glossary.definition') }}</span>
            <Textarea v-model="termForm.definition" required rows="4" maxlength="2000" />
          </label>
        </form>
        <DialogFooter>
          <Button variant="outline" @click="addingTerm = null">{{ t('common.cancel') }}</Button>
          <Button type="submit" form="kn-add-finding-term" :disabled="addTerm.isPending.value">
            <Loader2 v-if="addTerm.isPending.value" class="size-3.5 animate-spin" />
            {{ t('ai.runs.addTerm') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="dismissOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ t('ai.runs.dismissTitle') }}</DialogTitle>
          <DialogDescription>
            {{ t('ai.runs.dismissDesc', { agent: dismissing?.run.agentName ?? '' }) }}
          </DialogDescription>
        </DialogHeader>
        <form id="kn-dismiss-finding" class="space-y-3" @submit.prevent="confirmDismiss">
          <p v-if="dismissing" class="bg-muted/50 rounded-md px-3 py-2 text-sm font-medium">
            {{ dismissing.run.findings[dismissing.index]?.title }}
          </p>
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.runs.rememberWhy') }}</span>
            <Textarea
              v-model="dismissForm.learning"
              rows="3"
              :maxlength="AGENT_LEARNING_MAX_CHARS"
              :placeholder="t('ai.runs.rememberWhyPlaceholder')"
            />
            <span class="text-muted-foreground block text-caption">{{ t('ai.runs.rememberWhyHint') }}</span>
          </label>
          <label v-if="dismissForm.learning.trim()" class="flex items-center gap-2 text-sm">
            <Checkbox
              :model-value="dismissForm.allAgents"
              @update:model-value="dismissForm.allAgents = $event === true"
            />
            {{ t('ai.runs.teachEveryAgent', { agent: dismissing?.run.agentName ?? '' }) }}
          </label>
        </form>
        <DialogFooter>
          <Button variant="outline" @click="dismissing = null">{{ t('common.cancel') }}</Button>
          <Button type="submit" form="kn-dismiss-finding" :disabled="dismissFinding.isPending.value">
            <Loader2 v-if="dismissFinding.isPending.value" class="size-3.5 animate-spin" />
            {{ t('ai.runs.dismiss') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
