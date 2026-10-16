<script setup lang="ts">
// One capture in the inbox (issue #73), shaped like a merge-request card: a
// kind mark, the title, then one line of where it came from — the agent, the
// repository at a commit, the branch, when, whose it is and the key that wrote
// it. The key narrows the inbox to everything it proposed (issue #235).
//
// The second line says what dedupe made of it, because that is what a reviewer
// is deciding about: a new page, an amendment to an existing one, or nothing
// at all because the base already says it.
//
// The body is agent-written, so it renders as text, never as markdown: a
// capture is read here before anyone has decided it belongs in the base.
import { useI18n } from 'vue-i18n'
import { computed, nextTick, ref } from 'vue'
import { toast } from 'vue-sonner'
import { ArrowUpRight, Check, ChevronDown, CircleAlert, GitPullRequestArrow, KeyRound, X } from 'lucide-vue-next'
import { CAPTURE_PAGE_KINDS } from '@knowledge/contracts'
import type {
  AnswerCapturePayload,
  CaptureInfo,
  DecisionCapturePayload,
  GlossaryCapturePayload,
  NoteCapturePayload,
  RelationCapturePayload,
} from '@knowledge/contracts'
import { useApiMutation } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { relativeTime } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Collapse } from '@/components/ui/collapse'
import UserChip from '@/components/people/UserChip.vue'
import {
  captureKindIcon,
  clientLabel,
  formatScore,
  isApprovable,
  isRejectable,
  repoAtCommit,
} from './capture-ui'

const { t } = useI18n()

const props = defineProps<{
  capture: CaptureInfo
  /** The project's name, when the roster knows it — the inbox spans the workspace. */
  projectName?: string
  /** Approve and reject are an editor's; a viewer reads the inbox and decides nothing. */
  canDecide: boolean
  /** Whether the key is offered as a filter: an editor's for any key, everyone's for their own (the API's rule). */
  canFilterKey: boolean
}>()

const emit = defineEmits<{ filterKey: [apiKeyId: string] }>()

const c = computed(() => props.capture)
const repo = computed(() => repoAtCommit(c.value.session))

/** The page an amendment or a duplicate points at, named from the dedupe hits it came out of. */
const targetTitle = computed(
  () => c.value.similar.find((s) => s.documentId === c.value.targetDocumentId)?.title ?? null,
)

/** The badge is the derived state, and only where it adds to the tab: merged and closed live under Proposed. */
const stateBadge = computed(() => {
  switch (c.value.state) {
    case 'merged':
      return { label: t('captures.state.merged'), variant: 'secondary' as const }
    case 'closed':
      return { label: t('captures.state.closed'), variant: 'outline' as const }
    default:
      return null
  }
})

/**
 * What became of it, in one phrase. A staged row with no outcome has not been
 * deduplicated yet — still in flight, or stranded and waiting for the sweeper,
 * which retries it on its own.
 */
const outcomeLine = computed(() => {
  const cap = c.value
  if (cap.state === 'duplicate') return t('captures.outcome.duplicate')
  switch (cap.outcome) {
    case 'new-page':
      return t('captures.outcome.newPage')
    case 'amend-page':
      return t('captures.outcome.amendPage')
    case 'glossary':
      return cap.state === 'staged' ? t('captures.outcome.termWaiting') : t('captures.outcome.term')
    case 'relation':
      return t('captures.outcome.relation')
    default:
      return cap.state === 'staged' ? t('captures.outcome.pending') : null
  }
})

// --- the body, by kind ------------------------------------------------------
const decision = computed(() => (c.value.kind === 'decision' ? (c.value.payload as DecisionCapturePayload) : null))
const note = computed(() =>
  ['gotcha', 'convention', 'howto'].includes(c.value.kind) ? (c.value.payload as NoteCapturePayload) : null,
)
const term = computed(() => (c.value.kind === 'glossary' ? (c.value.payload as GlossaryCapturePayload) : null))
const relation = computed(() => (c.value.kind === 'relation' ? (c.value.payload as RelationCapturePayload) : null))
const answer = computed(() => (c.value.kind === 'answer' ? (c.value.payload as AnswerCapturePayload) : null))

/**
 * A term waiting on a decision opens with its definition showing: approving
 * something unread is not a review. Everything else starts folded, because the
 * merge request is where a page capture is read in full.
 */
const open = ref(isApprovable(props.capture))

// --- decisions --------------------------------------------------------------
const invalidates = () => [['/v1/captures']]
const approve = useApiMutation('post', '/v1/captures/{id}/approve', { invalidates })
const reject = useApiMutation('post', '/v1/captures/{id}/reject', { invalidates })

const rejecting = ref(false)
const reason = ref('')
const reasonEl = ref<InstanceType<typeof Input> | null>(null)

function startReject() {
  rejecting.value = true
  void nextTick(() => (reasonEl.value?.$el as HTMLInputElement | undefined)?.focus())
}

async function doApprove() {
  try {
    await approve.mutateAsync({ path: { id: c.value.captureId } })
    toast.success(t('captures.approved', { term: c.value.title }))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function doReject() {
  try {
    const why = reason.value.trim()
    await reject.mutateAsync({ path: { id: c.value.captureId }, body: why ? { reason: why } : {} })
    rejecting.value = false
    toast.success(t('captures.rejected', { title: c.value.title }))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

/**
 * Only page text is compared by vector: a term is matched on its folded
 * spelling and a relation on the edge itself, so for those an empty "compared
 * with" list would read as "nothing came close" when nothing was compared.
 */
const vectorDeduped = computed(() => CAPTURE_PAGE_KINDS.has(c.value.kind))

const busy = computed(() => approve.isPending.value || reject.isPending.value)
const bodyId = computed(() => `kn-capture-${c.value.captureId}`)
</script>

<template>
  <article class="rounded-lg border bg-card p-3 transition-colors" :aria-busy="busy">
    <!-- Actions share the title's line from `sm`; on a phone they drop to their
         own line, or they squeeze the provenance into a one-word column. -->
    <div class="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <component
        :is="captureKindIcon(c.kind)"
        class="mt-0.5 size-4 shrink-0 text-muted-foreground"
        :title="t(`captures.kind.${c.kind}`)"
        aria-hidden="true"
      />

      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 class="min-w-0 truncate text-sm font-medium">{{ c.title }}</h3>
          <span class="text-xs text-muted-foreground">{{ t(`captures.kind.${c.kind}`) }}</span>
          <Badge v-if="stateBadge" :variant="stateBadge.variant" class="text-xs">{{ stateBadge.label }}</Badge>
        </div>

        <!-- Where it came from. Every field is the agent's own report. -->
        <p class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          <span class="font-medium text-foreground/80">{{ clientLabel(c.session.client, t) }}</span>
          <template v-if="repo">
            <span aria-hidden="true">·</span>
            <code class="font-mono text-[0.6875rem]" :title="c.session.repo">{{ repo }}</code>
          </template>
          <template v-if="c.session.branch">
            <span aria-hidden="true">·</span>
            <code class="max-w-48 truncate font-mono text-[0.6875rem]" :title="c.session.branch">{{ c.session.branch }}</code>
          </template>
          <template v-if="projectName">
            <span aria-hidden="true">·</span>
            <span>{{ projectName }}</span>
          </template>
          <span aria-hidden="true">·</span>
          <time :datetime="c.createdAt">{{ relativeTime(c.createdAt) }}</time>
          <span aria-hidden="true">·</span>
          <UserChip :user-id="c.createdBy" size="sm" />
          <template v-if="c.apiKey">
            <span aria-hidden="true">·</span>
            <component
              :is="canFilterKey ? 'button' : 'span'"
              :type="canFilterKey ? 'button' : undefined"
              class="inline-flex min-w-0 items-center gap-1"
              :class="canFilterKey && 'rounded hover:text-foreground hover:underline'"
              :title="canFilterKey ? t('captures.key.filterBy', { name: c.apiKey.name }) : c.apiKey.name"
              @click="canFilterKey && emit('filterKey', c.apiKey.id)"
            >
              <KeyRound class="size-3 shrink-0" aria-hidden="true" />
              <span class="max-w-40 truncate">{{ c.apiKey.name }}</span>
              <code class="font-mono text-[0.6875rem]">{{ c.apiKey.prefix }}…</code>
              <span v-if="c.apiKey.revoked" class="text-destructive">{{ t('captures.key.revoked') }}</span>
            </component>
          </template>
        </p>

        <p v-if="outcomeLine" class="mt-1.5 text-xs">
          <span class="text-muted-foreground">{{ outcomeLine }}</span>
          <RouterLink
            v-if="c.targetDocumentId && (c.state === 'duplicate' || c.outcome === 'amend-page')"
            :to="`/documents/${c.targetDocumentId}`"
            class="ml-1 font-medium text-primary hover:underline"
          >{{ targetTitle ?? t('captures.openPage') }}</RouterLink>
        </p>

        <p v-if="c.error" class="mt-1.5 flex items-start gap-1.5 text-xs text-destructive">
          <CircleAlert class="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>{{ c.error }}</span>
        </p>
      </div>

      <!-- What can be done with it from here. A page or relation capture is
           decided on its merge request, so it gets a link, not a button that
           would only ever answer 409. -->
      <div class="col-span-2 flex items-center justify-end gap-1.5 empty:hidden sm:col-span-1">
        <Button
          v-if="c.mergeRequestId"
          as-child
          variant="outline"
          size="sm"
        >
          <RouterLink :to="`/merge-requests/${c.mergeRequestId}`">
            <GitPullRequestArrow class="size-3.5" aria-hidden="true" />
            {{ t('captures.openMergeRequest') }}
          </RouterLink>
        </Button>
        <template v-if="canDecide && !rejecting">
          <Button v-if="isRejectable(c)" variant="ghost" size="sm" :disabled="busy" @click="startReject">
            {{ t('captures.reject') }}
          </Button>
          <Button v-if="isApprovable(c)" size="sm" :disabled="busy" @click="doApprove">
            <Check class="size-3.5" aria-hidden="true" />
            {{ approve.isPending.value ? t('captures.approving') : t('captures.approve') }}
          </Button>
        </template>
      </div>
    </div>

    <!-- Reject asks why, inline: the reason goes to the activity log, and a
         dialog would interrupt for what is one optional line. -->
    <form v-if="rejecting" class="mt-3 flex flex-wrap items-center gap-2 pl-7" @submit.prevent="doReject">
      <Input
        ref="reasonEl"
        v-model="reason"
        class="h-8 min-w-0 flex-1 text-sm"
        maxlength="500"
        :placeholder="t('captures.reasonPlaceholder')"
        :aria-label="t('captures.reason')"
        @keydown.esc.prevent="rejecting = false"
      />
      <Button type="submit" size="sm" variant="destructive" :disabled="busy">
        {{ reject.isPending.value ? t('captures.rejecting') : t('captures.confirmReject') }}
      </Button>
      <Button type="button" size="sm" variant="ghost" :disabled="busy" @click="rejecting = false">
        <X class="size-3.5" aria-hidden="true" />
        <span class="sr-only">{{ t('common.cancel') }}</span>
      </Button>
    </form>

    <div class="mt-2 pl-7">
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        :aria-expanded="open"
        :aria-controls="bodyId"
        @click="open = !open"
      >
        <ChevronDown class="size-3.5 transition-transform duration-200" :class="open ? 'rotate-0' : '-rotate-90'" aria-hidden="true" />
        {{ open ? t('captures.hideDetails') : t('captures.showDetails') }}
        <span v-if="!open && vectorDeduped && c.similar.length" class="tabular-nums">· {{ t('captures.similarCount', { n: c.similar.length }, c.similar.length) }}</span>
      </button>

      <Collapse :open="open">
        <div :id="bodyId" class="grid gap-4 pt-3" :class="vectorDeduped && 'lg:grid-cols-[minmax(0,1fr)_16rem]'">
          <!-- What it says. -->
          <dl class="kn-capture-body min-w-0 space-y-2.5 text-sm">
            <template v-if="decision">
              <div><dt>{{ t('captures.field.context') }}</dt><dd>{{ decision.context }}</dd></div>
              <div><dt>{{ t('captures.field.decision') }}</dt><dd>{{ decision.decision }}</dd></div>
              <div v-if="decision.consequences"><dt>{{ t('captures.field.consequences') }}</dt><dd>{{ decision.consequences }}</dd></div>
              <div v-if="decision.alternatives?.length">
                <dt>{{ t('captures.field.alternatives') }}</dt>
                <dd><ul class="list-disc space-y-0.5 pl-4"><li v-for="a in decision.alternatives" :key="a">{{ a }}</li></ul></dd>
              </div>
            </template>
            <template v-else-if="note">
              <div><dd>{{ note.body }}</dd></div>
              <div v-if="note.appliesTo?.length">
                <dt>{{ t('captures.field.appliesTo') }}</dt>
                <dd class="flex flex-wrap gap-1">
                  <code v-for="p in note.appliesTo" :key="p" class="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem]">{{ p }}</code>
                </dd>
              </div>
            </template>
            <template v-else-if="term">
              <div>
                <dt>{{ t('captures.field.term') }}</dt>
                <dd>
                  <span class="font-medium">{{ term.term }}</span>
                  <span v-if="term.aliases?.length" class="text-muted-foreground"> · {{ term.aliases.join(', ') }}</span>
                </dd>
              </div>
              <div><dt>{{ t('captures.field.definition') }}</dt><dd>{{ term.definition }}</dd></div>
              <div v-if="term.documentId">
                <dt>{{ t('captures.field.definedIn') }}</dt>
                <dd><RouterLink :to="`/documents/${term.documentId}`" class="text-primary hover:underline">{{ t('captures.openPage') }}</RouterLink></dd>
              </div>
            </template>
            <template v-else-if="relation">
              <div>
                <dt>{{ t('captures.field.relation') }}</dt>
                <dd>
                  <RouterLink :to="`/documents/${relation.documentId}`" class="text-primary hover:underline">{{ t('captures.thisPage') }}</RouterLink>
                  <code class="mx-1.5 font-mono text-xs">{{ relation.type }}</code>
                  <code class="font-mono text-xs">{{ relation.targetKey }}</code>
                </dd>
              </div>
              <div><dt>{{ t('captures.field.rationale') }}</dt><dd>{{ relation.rationale }}</dd></div>
            </template>
            <template v-else-if="answer">
              <div><dt>{{ t('captures.field.question') }}</dt><dd>{{ answer.question }}</dd></div>
              <div><dt>{{ t('captures.field.answer') }}</dt><dd>{{ answer.answer }}</dd></div>
            </template>

            <div v-if="c.session.files?.length">
              <dt>{{ t('captures.field.files') }}</dt>
              <dd class="flex flex-wrap gap-1">
                <code v-for="f in c.session.files" :key="f" class="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem]">{{ f }}</code>
              </dd>
            </div>
          </dl>

          <!-- What dedupe compared it with — the evidence for the outcome line. -->
          <aside v-if="vectorDeduped" class="min-w-0 border-t pt-3 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4">
            <h4 class="text-xs font-medium text-muted-foreground">{{ t('captures.similarTitle') }}</h4>
            <p v-if="!c.similar.length" class="mt-1.5 text-xs text-muted-foreground">{{ t('captures.similarNone') }}</p>
            <ol v-else class="mt-1.5 space-y-1">
              <li v-for="s in c.similar" :key="s.documentId" class="flex items-baseline gap-2 text-xs">
                <span class="w-8 shrink-0 text-right font-medium tabular-nums" :title="t('captures.scoreTitle')">{{ formatScore(s.score) }}</span>
                <RouterLink :to="`/documents/${s.documentId}`" class="group min-w-0 truncate hover:text-primary">
                  {{ s.title }}
                  <ArrowUpRight class="inline size-3 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
                </RouterLink>
              </li>
            </ol>
          </aside>
        </div>
      </Collapse>
    </div>
  </article>
</template>

<style scoped>
.kn-capture-body dt {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--muted-foreground);
}
/* Agent prose, shown as written: line breaks are the agent's, never markdown. */
.kn-capture-body dd {
  margin-top: 0.125rem;
  max-width: 72ch;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
