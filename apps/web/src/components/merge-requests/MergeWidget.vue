<script setup lang="ts">
// GitLab-style merge widget: readiness checklist + the merge/close/reopen
// controls in one card. 409 gate reasons (draft | approvals | diverged |
// breaking-api, see MergeGateConflictDetails) surface as toasts — divergence
// with a compare link. On a spec (#78) the checklist gains a breaking-change
// row: what the API tab found, what the workspace policy does about it, and an
// admin's acknowledgement, pinned to the source head it was given for. Where
// the page's styleguide lint is on (#74) a style row says what the check of the
// current head found; under `warn` it never holds the merge.
import { useI18n } from 'vue-i18n'
import { formatDateTime } from '@/lib/format'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { AlertTriangle, Check, CircleDashed, FileWarning, GitMerge, MessageSquare, ThumbsUp } from 'lucide-vue-next'
import type {
  MergeGateConflictDetails,
  MergeRequestApiChangesResponse,
  MergeRequestInfo,
  MergeStrategy,
} from '@knowledge/contracts'
import { useApiMutation, isApiRequestError } from '@/api/queries'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { actorLabel, mrIcon } from './mr-ui'
import { lintCheckView, useLintChecks } from './lint-check'

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

const { current: lintCheck, shown: lintShown, policy: lintPolicy, relint } = useLintChecks(
  computed(() => mr.value.mergeRequestId),
)
const lintView = computed(() => lintCheckView(lintCheck.value))
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

const busy = computed(
  () =>
    approve.isPending.value ||
    merge.isPending.value ||
    close.isPending.value ||
    reopen.isPending.value ||
    update.isPending.value ||
    ack.isPending.value ||
    unack.isPending.value,
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
          } else if (details.reason === 'breaking-api') {
            const n = details.breakingCount ?? 0
            toast.error(t('mr.api.blockedToast', { n }, n), {
              action: { label: t('mr.api.review'), onClick: () => emit('reviewApi') },
            })
            emit('changed')
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
        <CircleDashed v-if="mr.isDraft" class="size-4 text-amber-500" />
        <Check v-else class="size-4 text-emerald-500" />
        <span v-if="mr.isDraft">{{ t('mr.markedDraft') }}</span>
        <span v-else>{{ t('mr.readyNotDraft') }}</span>
      </p>
      <p class="flex items-center gap-2">
        <ThumbsUp class="size-4" :class="mr.approvedBy.length > 0 ? 'text-emerald-500' : 'text-muted-foreground/60'" />
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
        <MessageSquare class="size-4" :class="unresolvedThreads > 0 ? 'text-amber-500' : 'text-muted-foreground/60'" />
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
        <span v-if="lintCheck?.status === 'failed'" class="text-muted-foreground">· {{ t('mr.lint.warnOnly') }}</span>
        <Button
          v-if="canRelint && isOpen"
          variant="ghost"
          size="xs"
          class="ml-auto"
          :disabled="relint.isPending.value"
          @click="onRelint"
        >
          {{ t('mr.lint.recheck') }}
        </Button>
      </div>
      <!-- Breaking API changes (#78): amber under warn, the caution hue while
           a block holds, emerald once there is nothing to hold. -->
      <div v-if="api" class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <FileWarning
          v-if="api.breaking > 0"
          class="size-4 shrink-0"
          :class="api.blocked ? 'text-[color:var(--kn-panel-caution)]' : 'text-amber-500'"
        />
        <Check v-else class="size-4 shrink-0 text-emerald-500" />
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
        <Button size="sm" :disabled="busy || mr.isDraft || !!api?.blocked" @click="onMerge">
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
  </div>
</template>
