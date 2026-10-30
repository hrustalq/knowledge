<script setup lang="ts">
// GitLab-style merge widget: readiness checklist + the merge/close/reopen
// controls in one card. 409 gate reasons (draft | approvals | conflict |
// diverged | breaking-api, see MergeGateConflictDetails) surface as toasts — a
// conflict with the way to resolve it. A branch row (#636) says whether the
// target moved: a clean 3-way merge offers "Update branch", a conflict opens
// the conflict view and holds the merge. On a spec (#78) the checklist gains a breaking-change
// row: what the API tab found, what the workspace policy does about it, and an
// admin's acknowledgement, pinned to the source head it was given for. Where
// the page's styleguide lint is on (#74) a style row says what the check of the
// current head found; under `warn` it never holds the merge, under `block` it
// holds while the check is to come or an error-severity thread is open, and an
// admin may override that one revision with a reason.
import { useI18n } from 'vue-i18n'
import { formatDateTime } from '@/shared/utils/format'
import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { AlertTriangle, Check, CircleDashed, FileWarning, GitBranch, GitMerge, MessageSquare, ThumbsUp } from 'lucide-vue-next'
import type {
  MergeGateConflictDetails,
  MergeRequestApiChangesResponse,
  MergeRequestConflictsResponse,
  MergeRequestInfo,
  MergeStrategy,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation, isApiRequestError } from '@/shared/api/queries'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Label } from '@/shared/ui/label'
import { Textarea } from '@/shared/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select'
import { mrIcon } from '@/entities/merge-request'
import { actorLabel } from '@/entities/person'
import { lintCheckView, useLintChecks } from '../model/lint-check'
import MergeConflictsDialog from './MergeConflictsDialog.vue'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    mergeRequest: MergeRequestInfo
    unresolvedThreads?: number
    /** GET …/api-changes; null until it loads, `applicable: false` on a page. */
    apiChanges?: MergeRequestApiChangesResponse | null
  }>(),
  { unresolvedThreads: 0, apiChanges: null },
)
const emit = defineEmits<{ changed: []; reviewApi: [] }>()

const router = useRouter()
const auth = useAuthStore()
const strategy = ref<MergeStrategy>('merge-commit')

const mr = computed(() => props.mergeRequest)
const id = computed(() => ({ path: { id: mr.value.mergeRequestId } }))
const isOpen = computed(() => mr.value.status === 'open')
const alreadyApproved = computed(() => !!auth.me && mr.value.approvedBy.includes(auth.me.userId))

const invalidates = () => [
  ['/v1/merge-requests/{id}', { id: mr.value.mergeRequestId }, null],
  ['/v1/merge-requests'],
  ['/v1/documents/{id}/merge-requests'],
]

const approve = useApiMutation('post', '/v1/merge-requests/{id}/approve', { invalidates })
const merge = useApiMutation('post', '/v1/merge-requests/{id}/merge', { invalidates })
const close = useApiMutation('post', '/v1/merge-requests/{id}/close', { invalidates })
const reopen = useApiMutation('post', '/v1/merge-requests/{id}/reopen', { invalidates })
const update = useApiMutation('patch', '/v1/merge-requests/{id}', { invalidates })
const apiInvalidates = () => [...invalidates(), ['/v1/merge-requests/{id}/api-changes'], ['/v1/activity']]
const ack = useApiMutation('post', '/v1/merge-requests/{id}/breaking-ack', { invalidates: apiInvalidates })
const unack = useApiMutation('delete', '/v1/merge-requests/{id}/breaking-ack', { invalidates: apiInvalidates })

/** The breaking-change row: shown on a spec whose workspace checks, once the diff has a verdict. */
const api = computed(() => {
  const a = props.apiChanges
  if (!a?.applicable || a.policy === 'off' || !a.diff) return null
  return { ...a, breaking: a.diff.summary.breaking }
})

const {
  current: lintCheck,
  shown: lintShown,
  policy: lintPolicy,
  gate: lintGate,
  relint,
  override: lintOverride,
  query: lintQuery,
} = useLintChecks(computed(() => mr.value.mergeRequestId))
const lintView = computed(() => lintCheckView(lintCheck.value))
/**
 * What the row says about the merge under `block`. Read from the gate's
 * counts rather than `blocked`, so a caller the gate is not enforced for (the
 * dev principal) still sees what it would hold.
 */
const lintHold = computed<'override' | 'blocking' | 'waiting' | 'clear' | null>(() => {
  const g = lintGate.value
  if (!g || g.policy !== 'block') return null
  if (g.overridden) return 'override'
  if (g.blockingCount > 0) return 'blocking'
  if (['missing', 'pending', 'running'].includes(g.checkStatus)) return 'waiting'
  return 'clear'
})
const canOverride = computed(
  () => auth.canAdminWorkspace && !!lintGate.value?.checkId && (lintHold.value === 'blocking' || lintHold.value === 'waiting'),
)
const overrideOpen = ref(false)
const overrideReason = ref('')
watch(overrideOpen, (open) => {
  if (open) overrideReason.value = ''
})

function onOverride() {
  const checkId = lintGate.value?.checkId
  const reason = overrideReason.value.trim()
  if (!checkId || !reason) return
  lintOverride.mutate(
    { path: { id: mr.value.mergeRequestId, checkId }, body: { reason } },
    {
      onSuccess: () => {
        overrideOpen.value = false
        toast.success(t('mr.lint.overridden'))
      },
      onError: (e) => toast.error(e.message),
    },
  )
}
/** A head can be checked again once its check has settled, while lint is on. */
const canRelint = computed(
  () =>
    auth.canEdit &&
    lintPolicy.value?.effective !== 'off' &&
    !['pending', 'running'].includes(lintCheck.value?.status ?? ''),
)

function onRelint() {
  relint.mutate(id.value, {
    onSuccess: () => toast.success(t('mr.lint.queued')),
    onError: (e) => toast.error(e.message),
  })
}

/** The 3-way state (#636): pages behind the target, and the conflicts among them. */
const branchQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/merge-requests/{id}/conflicts', { path: { id: mr.value.mergeRequestId } }),
    enabled: isOpen.value,
  })),
)
const branchState = computed(() => (branchQuery.data.value as MergeRequestConflictsResponse | undefined) ?? null)
const conflicted = computed(() => (branchState.value ? branchState.value.pages.length + branchState.value.hiddenPages : 0))
const resolveOpen = ref(false)
const updateBranch = useApiMutation('post', '/v1/merge-requests/{id}/update-branch', {
  invalidates: () => [
    ...invalidates(),
    ['/v1/merge-requests/{id}/conflicts', { id: mr.value.mergeRequestId }],
    ['/v1/merge-requests/{id}/diff'],
    ['/v1/merge-requests/{id}/checks'],
  ],
})

function onUpdateBranch() {
  updateBranch.mutate(
    { ...id.value, body: {} },
    {
      onSuccess: () => {
        toast.success(t('mr.branch.updated'))
        emit('changed')
      },
      onError: (e) => {
        toast.error(e.message)
        void branchQuery.refetch()
      },
    },
  )
}

const busy = computed(
  () =>
    approve.isPending.value ||
    updateBranch.isPending.value ||
    merge.isPending.value ||
    close.isPending.value ||
    reopen.isPending.value ||
    update.isPending.value ||
    ack.isPending.value ||
    unack.isPending.value ||
    lintOverride.isPending.value,
)

function onMerge() {
  merge.mutate(
    { ...id.value, body: { strategy: strategy.value } },
    {
      onSuccess: () => {
        toast.success(t('mr.merged'))
        emit('changed')
      },
      onError: (e) => {
        if (isApiRequestError(e) && e.status === 409) {
          const details = (e.payload.details ?? {}) as unknown as Partial<MergeGateConflictDetails>
          if (details.reason === 'approvals') {
            toast.error(t('mr.needsApprovals', { required: details.requiredApprovals, have: details.approvals }))
          } else if (details.reason === 'draft') {
            toast.error(t('mr.draftCannotMerge'))
          } else if (details.reason === 'lint') {
            const n = details.blockingCount ?? 0
            toast.error(n > 0 ? t('mr.lint.blockedToast', { n }, n) : t('mr.lint.pendingToast'))
            void lintQuery.refetch()
          } else if (details.reason === 'breaking-api') {
            const n = details.breakingCount ?? 0
            toast.error(t('mr.api.blockedToast', { n }, n), {
              action: { label: t('mr.api.review'), onClick: () => emit('reviewApi') },
            })
            emit('changed')
          } else if (details.reason === 'conflict') {
            void branchQuery.refetch()
            toast.error(t('mr.branch.conflictToast'), {
              action: { label: t('mr.branch.resolve'), onClick: () => (resolveOpen.value = true) },
            })
          } else if (details.comparisonUrl) {
            toast.error(t('mr.targetDiverged'), {
              action: { label: t('mr.compare'), onClick: () => void router.push(comparePagePath(details.comparisonUrl!)) },
            })
          } else {
            toast.error(e.message)
          }
        } else {
          toast.error(e.message)
        }
      },
    },
  )
}

/** API comparison URL → the document revisions tab, which hosts the compare UI. */
function comparePagePath(apiUrl: string): string {
  const m = /\/v1\/documents\/([^/]+)\/compare/.exec(apiUrl)
  return m ? `/documents/${m[1]}?tab=revisions` : '/documents'
}

function act(mutation: typeof close, label: string) {
  mutation.mutate(id.value, {
    onSuccess: () => {
      toast.success(label)
      emit('changed')
    },
    onError: (e) => toast.error(e.message),
  })
}

function setAck(on: boolean) {
  ;(on ? ack : unack).mutate(id.value, {
    onSuccess: () => toast.success(on ? t('mr.api.acknowledged') : t('mr.api.withdrawn')),
    onError: (e) => toast.error(e.message),
  })
}

function toggleDraft() {
  update.mutate(
    { ...id.value, body: { isDraft: !mr.value.isDraft } },
    { onSuccess: () => emit('changed'), onError: (e) => toast.error(e.message) },
  )
}
</script>

<template>
  <div class="rounded-lg border bg-card">
    <!-- readiness checklist (open MRs) -->
    <div v-if="isOpen" class="space-y-2 border-b px-4 py-3 text-sm">
      <p class="flex items-center gap-2" :class="mr.isDraft ? 'text-muted-foreground' : ''">
        <CircleDashed v-if="mr.isDraft" class="size-4 text-panel-warning" />
        <Check v-else class="size-4 text-panel-tip" />
        <span v-if="mr.isDraft">{{ t('mr.markedDraft') }}</span>
        <span v-else>{{ t('mr.readyNotDraft') }}</span>
      </p>
      <p class="flex items-center gap-2">
        <ThumbsUp class="size-4" :class="mr.approvedBy.length > 0 ? 'text-panel-tip' : 'text-muted-foreground/60'" />
        <span v-if="mr.approvedBy.length > 0">
          {{ t('mr.approvedBy', { names: mr.approvedBy.map((a) => actorLabel(a)).join(', ') }) }}
        </span>
        <span v-else class="text-muted-foreground">{{ t('mr.noApprovals') }}</span>
        <Button
          v-if="auth.canEdit"
          variant="outline"
          size="xs"
          class="ml-auto"
          :disabled="busy || alreadyApproved"
          @click="act(approve, t('mr.approved'))"
        >
          {{ alreadyApproved ? t('mr.approvedTick') : t('mr.approve') }}
        </Button>
      </p>
      <p class="flex items-center gap-2">
        <MessageSquare class="size-4" :class="unresolvedThreads > 0 ? 'text-panel-warning' : 'text-muted-foreground/60'" />
        <span v-if="unresolvedThreads > 0">
          {{ t('count.unresolvedThreads', { n: unresolvedThreads }, unresolvedThreads) }}
        </span>
        <span v-else class="text-muted-foreground">{{ t('mr.allThreadsResolved') }}</span>
      </p>
      <!-- Style lint (#74): the check of the current head. Violations are
           threads in the discussion; under `warn` they inform, never hold. -->
      <div v-if="lintShown" class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <component :is="lintView.icon" class="size-4 shrink-0" :class="lintView.tone" />
        <span :class="lintCheck?.status === 'failed' ? '' : 'text-muted-foreground'">
          {{ t(lintView.label, lintView.args ?? {}, lintView.count ?? 1) }}
        </span>
        <span v-if="lintView.unresolved > 0" class="text-muted-foreground">
          — {{ t('mr.lint.unresolved', { n: lintView.unresolved }, lintView.unresolved) }}
        </span>
        <template v-if="lintHold === 'override' && lintCheck?.override">
          <span class="text-muted-foreground" :title="lintCheck.override.reason">
            · {{ t('mr.lint.overriddenBy', { name: actorLabel(lintCheck.override.by) }) }}
          </span>
        </template>
        <template v-else-if="lintHold === 'blocking'">
          <span class="font-medium text-panel-caution">
            · {{ t('mr.lint.blocking', { n: lintGate!.blockingCount }, lintGate!.blockingCount) }}
          </span>
          <span v-if="lintGate?.blocked" class="text-muted-foreground">— {{ t('mr.lint.blocksMerge') }}</span>
        </template>
        <span v-else-if="lintHold === 'waiting' && lintGate?.blocked" class="text-muted-foreground">
          · {{ t('mr.lint.waitsMerge') }}
        </span>
        <span v-else-if="lintHold === 'clear' && lintCheck?.status === 'failed'" class="text-muted-foreground">
          · {{ t('mr.lint.noneBlocking') }}
        </span>
        <span v-else-if="lintCheck?.status === 'failed'" class="text-muted-foreground">· {{ t('mr.lint.warnOnly') }}</span>
        <span class="ml-auto flex items-center gap-1">
          <Button v-if="canOverride && isOpen" variant="outline" size="xs" :disabled="busy" @click="overrideOpen = true">
            {{ t('mr.lint.override') }}
          </Button>
          <Button
            v-if="canRelint && isOpen"
            variant="ghost"
            size="xs"
            :disabled="relint.isPending.value"
            @click="onRelint"
          >
            {{ t('mr.lint.recheck') }}
          </Button>
        </span>
        <p
          v-if="lintGate?.blocked && !auth.canAdminWorkspace && lintHold === 'blocking'"
          class="w-full pl-6 text-xs text-muted-foreground"
        >
          {{ t('mr.lint.adminHint') }}
        </p>
      </div>
      <!-- Breaking API changes (#78): amber under warn, the caution hue while
           a block holds, emerald once there is nothing to hold. -->
      <div v-if="api" class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <FileWarning
          v-if="api.breaking > 0"
          class="size-4 shrink-0"
          :class="api.blocked ? 'text-panel-caution' : 'text-panel-warning'"
        />
        <Check v-else class="size-4 shrink-0 text-panel-tip" />
        <span v-if="api.breaking === 0" class="text-muted-foreground">{{ t('mr.api.noneBreaking') }}</span>
        <span v-else class="min-w-0">
          <button type="button" class="font-medium underline-offset-2 hover:underline" @click="emit('reviewApi')">
            {{ t('mr.api.breaking', { n: api.breaking }, api.breaking) }}
          </button>
          <span class="text-muted-foreground"> — </span>
          <span v-if="api.ack?.current" class="text-muted-foreground">{{ t('mr.api.ackedBy', { name: actorLabel(api.ack.by) }) }}</span>
          <span v-else-if="api.ack" class="text-muted-foreground">{{ t('mr.api.ackStale', { name: actorLabel(api.ack.by) }) }}</span>
          <span v-else-if="api.blocked" class="text-muted-foreground">{{ t('mr.api.blocked') }}</span>
          <span v-else class="text-muted-foreground">{{ t('mr.api.warnOnly') }}</span>
        </span>
        <template v-if="api.breaking > 0 && api.policy === 'block'">
          <Button
            v-if="auth.canAdminWorkspace && !api.ack?.current"
            variant="outline"
            size="xs"
            class="ml-auto"
            :disabled="busy"
            @click="setAck(true)"
          >
            {{ t('mr.api.acknowledge') }}
          </Button>
          <Button
            v-else-if="auth.canAdminWorkspace"
            variant="ghost"
            size="xs"
            class="ml-auto"
            :disabled="busy"
            @click="setAck(false)"
          >
            {{ t('mr.api.withdraw') }}
          </Button>
          <span v-else-if="api.blocked" class="ml-auto text-xs text-muted-foreground">{{ t('mr.api.ackHint') }}</span>
        </template>
      </div>
      <!-- The branch against its target (#636): hidden while up to date. A
           clean 3-way merge needs no update; a conflict holds the merge. -->
      <div v-if="branchState && branchState.behind > 0" class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <template v-if="conflicted > 0">
          <AlertTriangle class="size-4 shrink-0 text-panel-caution" />
          <span class="font-medium">{{ t('mr.branch.conflicts', { n: conflicted }, conflicted) }}</span>
          <Button
            v-if="auth.canEdit && branchState.pages.length > 0"
            variant="outline"
            size="xs"
            class="ml-auto"
            :disabled="busy"
            @click="resolveOpen = true"
          >
            {{ t('mr.branch.resolve') }}
          </Button>
          <p class="w-full pl-6 text-xs text-muted-foreground">
            <template v-if="branchState.hiddenPages > 0">
              {{ t('mr.branch.hidden', { n: branchState.hiddenPages }, branchState.hiddenPages) }}.
            </template>
            {{ t('mr.branch.conflictsHint') }}
          </p>
        </template>
        <template v-else>
          <GitBranch class="size-4 shrink-0 text-panel-tip" />
          <span class="text-muted-foreground">
            {{ t('mr.branch.behind', { n: branchState.behind, target: mr.targetBranch }, branchState.behind) }}
          </span>
          <Button v-if="auth.canEdit" variant="ghost" size="xs" class="ml-auto" :disabled="busy" @click="onUpdateBranch">
            {{ t('mr.branch.update') }}
          </Button>
        </template>
      </div>
    </div>

    <!-- terminal-state summary -->
    <div v-else class="flex items-center gap-2 border-b px-4 py-3 text-sm">
      <component :is="mrIcon(mr).icon" class="size-4" :class="mrIcon(mr).class" />
      <span v-if="mr.status === 'merged'">
        {{ t('mr.mergedAt', { when: mr.mergedAt ? formatDateTime(mr.mergedAt) : '' }) }}{{ mr.strategy ? ` (${mr.strategy})` : '' }}
      </span>
      <span v-else>
        {{ t('mr.closedAt', { when: mr.closedAt ? formatDateTime(mr.closedAt) : '' }) }}
      </span>
      <RouterLink
        v-if="mr.mergedRevisionId"
        :to="`/documents/${mr.documentId}?tab=revisions`"
        class="ml-auto font-mono text-xs text-primary hover:underline"
      >
        {{ mr.mergedRevisionId.slice(0, 8) }}
      </RouterLink>
    </div>

    <!-- controls -->
    <div v-if="auth.canEdit" class="flex flex-wrap items-center gap-2 px-4 py-3">
      <template v-if="isOpen">
        <Select v-model="strategy" :disabled="busy">
          <SelectTrigger size="sm" class="text-xs" :aria-label="t('mr.mergeStrategy')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="merge-commit">{{ t('mr.mergeCommit') }}</SelectItem>
            <SelectItem value="squash">{{ t('mr.squash') }}</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" :disabled="busy || mr.isDraft || !!api?.blocked || !!lintGate?.blocked || conflicted > 0" @click="onMerge">
          <GitMerge class="size-3.5" /> {{ t('mr.merge') }}
        </Button>
        <Button size="sm" variant="ghost" :disabled="busy" @click="toggleDraft">
          {{ mr.isDraft ? t('mr.markAsReady') : t('mr.markAsDraft') }}
        </Button>
        <Button size="sm" variant="ghost" class="text-destructive" :disabled="busy" @click="act(close, t('mr.closed'))">
          {{ t('mr.close') }}
        </Button>
      </template>
      <Button
        v-else-if="mr.status === 'closed'"
        size="sm"
        variant="outline"
        :disabled="busy"
        @click="act(reopen, t('mr.reopened'))"
      >
        {{ t('mr.reopen') }}
      </Button>
      <p v-else class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <AlertTriangle class="size-3.5" /> {{ t('mr.mergedFinal') }}
      </p>
    </div>

    <MergeConflictsDialog
      v-if="branchState && branchState.pages.length > 0"
      v-model:open="resolveOpen"
      :merge-request-id="mr.mergeRequestId"
      :pages="branchState.pages"
      :hidden-pages="branchState.hiddenPages"
      :target-branch="mr.targetBranch"
      :source-branch="mr.sourceBranch"
      @updated="emit('changed')"
    />

    <Dialog v-model:open="overrideOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('mr.lint.overrideTitle') }}</DialogTitle>
          <DialogDescription>{{ t('mr.lint.overrideHint') }}</DialogDescription>
        </DialogHeader>
        <div class="space-y-2">
          <Label for="kn-lint-override-reason">{{ t('mr.lint.reasonLabel') }}</Label>
          <Textarea id="kn-lint-override-reason" v-model="overrideReason" rows="3" maxlength="500" />
        </div>
        <DialogFooter>
          <Button variant="outline" @click="overrideOpen = false">{{ t('common.cancel') }}</Button>
          <Button :disabled="!overrideReason.trim() || lintOverride.isPending.value" @click="onOverride">
            {{ t('mr.lint.override') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
