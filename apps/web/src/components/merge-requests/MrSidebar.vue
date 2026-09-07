<script setup lang="ts">
// The merge-request rail: one sticky panel, two tabs.
//
// It used to be four stacked cards — assignee, reviewers, AI check, revisions
// — which read as one repeated shape rather than a rail, and put the AI check
// in the middle where a long result pushed the revisions out of sight. Now
// the attributes are an attribute list (hairlines, not four borders) and the
// AI check gets a pane of its own with its actions docked at the bottom.
//
// Sticky against <main>, which is the app's scroll container (see App.vue).
// The height cap is measured rather than written in CSS, because the rail
// starts a long way down the page — under the title and the merge widget —
// and a `100vh` cap there hangs the docked actions below the fold until you
// scroll. `fit()` reads the panel's own top edge instead, which is the real
// top in both regimes: its natural position before the rail pins, and the
// clamped `top-6` after. The CSS cap stays as the pre-hydration fallback.
// Only from lg — stacked under the content on narrow screens, a capped panel
// with its own scrollbar would be worse than a full-height one.
//
// Both panes stay mounted (v-show, not v-if): switching to the findings and
// back must not throw away a half-picked reviewer set, and re-running the
// review because you looked at the assignee is not a thing anyone wants.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Check, Pencil, X } from 'lucide-vue-next'
import type { MergeRequestInfo } from '@knowledge/contracts'
import { useApiMutation } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import UserAvatar from './UserAvatar.vue'
import AiCheckPane from './AiCheckPane.vue'
import { useMembers } from './use-members'

const props = defineProps<{
  mergeRequest: MergeRequestInfo
  readonly?: boolean
  /** Findings can become a review thread only on an open MR you can write to. */
  canComment?: boolean
  /** A thread write is in flight in the parent. */
  busy?: boolean
}>()
const emit = defineEmits<{ changed: []; comment: [body: string] }>()

const { members, nameOf } = useMembers()
const mr = computed(() => props.mergeRequest)

const invalidates = () => [
  ['/v1/merge-requests/{id}', { id: mr.value.mergeRequestId }, null],
  ['/v1/merge-requests'],
]

// --- height ------------------------------------------------------------------
const panelEl = ref<HTMLElement | null>(null)
const maxHeight = ref<string | undefined>(undefined)
let scroller: HTMLElement | null = null
let frame = 0

/** Breathing room under the panel, matching the page's own bottom padding. */
const GUTTER = 24
/** Below this the panel is more cramped than useful; let it overflow instead. */
const MIN_HEIGHT = 220

function fit() {
  const el = panelEl.value
  if (!el) return
  if (!window.matchMedia('(min-width: 1024px)').matches) {
    maxHeight.value = undefined
    return
  }
  const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight
  const available = bottom - el.getBoundingClientRect().top - GUTTER
  maxHeight.value = `${Math.max(MIN_HEIGHT, Math.round(available))}px`
}

/** Scroll fires far faster than layout needs; one measurement per frame is plenty. */
function schedule() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    fit()
  })
}

onMounted(() => {
  scroller = panelEl.value?.closest('main') ?? null
  fit()
  scroller?.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', schedule)
})

onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame)
  scroller?.removeEventListener('scroll', schedule)
  window.removeEventListener('resize', schedule)
})

// --- tabs --------------------------------------------------------------------
type Pane = 'details' | 'ai'
const pane = ref<Pane>('details')
/** Result counts from the AI pane, so the tab can say what is waiting there. */
const aiCounts = ref<{ issues: number; errors: number } | null>(null)

// --- assignee ----------------------------------------------------------------
const editingAssignee = ref(false)
const updateMr = useApiMutation('patch', '/v1/merge-requests/{id}', { invalidates })

function setAssignee(userId: string | null) {
  updateMr.mutate(
    { path: { id: mr.value.mergeRequestId }, body: { assigneeId: userId } },
    {
      onSuccess: () => {
        editingAssignee.value = false
        emit('changed')
      },
      onError: (e) => toast.error(e.message),
    },
  )
}

// --- reviewers ---------------------------------------------------------------
const editingReviewers = ref(false)
const selected = ref<Set<string>>(new Set(props.mergeRequest.reviewers))
watch(
  () => props.mergeRequest.reviewers,
  (next) => (selected.value = new Set(next)),
)
const reviewersDirty = computed(
  () =>
    selected.value.size !== mr.value.reviewers.length ||
    mr.value.reviewers.some((id) => !selected.value.has(id)),
)

const saveReviewers = useApiMutation('put', '/v1/merge-requests/{id}/reviewers', { invalidates })

function toggleReviewer(userId: string) {
  const next = new Set(selected.value)
  if (next.has(userId)) next.delete(userId)
  else next.add(userId)
  selected.value = next
}
function submitReviewers() {
  saveReviewers.mutate(
    { path: { id: mr.value.mergeRequestId }, body: { reviewerIds: [...selected.value] } },
    {
      onSuccess: () => {
        editingReviewers.value = false
        toast.success('Reviewers updated')
        emit('changed')
      },
      onError: (e) => toast.error(e.message),
    },
  )
}
function cancelReviewers() {
  selected.value = new Set(mr.value.reviewers)
  editingReviewers.value = false
}

// --- revisions ---------------------------------------------------------------
/**
 * The four ids as a lineage rather than a list of hashes. An eight-character
 * hash on its own says nothing; paired with the branch it is the head of, it
 * says which side of the comparison you are looking at.
 */
const revisionRows = computed(() =>
  [
    { label: 'Source head', branch: mr.value.sourceBranch, id: mr.value.sourceHeadRevisionId },
    { label: 'Merge base', branch: null, id: mr.value.mergeBaseRevisionId },
    { label: 'Target head', branch: mr.value.targetBranch, id: mr.value.targetHeadRevisionId },
    { label: 'Merged as', branch: null, id: mr.value.mergedRevisionId },
  ].filter((r): r is { label: string; branch: string | null; id: string } => r.id !== null),
)
</script>

<template>
  <aside class="lg:sticky lg:top-6 lg:self-start">
    <div
      ref="panelEl"
      class="flex flex-col overflow-hidden rounded-lg border bg-card lg:max-h-[calc(100vh-8.75rem)]"
      :style="{ maxHeight }"
    >
      <!-- Segmented header. Two panes only, so tabs sit inside the panel's
           frame rather than borrowing the page's underline tab style. -->
      <div role="tablist" class="flex shrink-0 gap-1 border-b bg-muted/30 p-1">
        <button
          v-for="p in (['details', 'ai'] as Pane[])"
          :key="p"
          role="tab"
          :aria-selected="pane === p"
          class="flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
          :class="pane === p
            ? 'bg-card text-foreground shadow-xs ring-1 ring-border'
            : 'text-muted-foreground hover:text-foreground'"
          @click="pane = p"
        >
          {{ p === 'details' ? 'Details' : 'AI check' }}
          <span
            v-if="p === 'ai' && aiCounts"
            class="grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] tabular-nums"
            :class="aiCounts.errors > 0
              ? 'bg-red-500/15 text-red-600'
              : aiCounts.issues > 0
                ? 'bg-amber-500/15 text-amber-600'
                : 'bg-emerald-500/15 text-emerald-600'"
            :aria-label="aiCounts.issues > 0 ? `${aiCounts.issues} findings` : 'Passed'"
          >
            <template v-if="aiCounts.issues > 0">{{ aiCounts.issues }}</template>
            <Check v-else class="size-3" />
          </span>
        </button>
      </div>

      <!-- Details: assignee → reviewers → revisions, one list of attributes -->
      <div v-show="pane === 'details'" class="quiet-scroll min-h-0 flex-1 divide-y overflow-y-auto">
        <!-- assignee -->
        <section class="px-3 py-3">
          <div class="flex items-center gap-2">
            <h3 class="text-xs font-medium text-muted-foreground">Assignee</h3>
            <button
              v-if="!readonly"
              class="ml-auto text-muted-foreground transition-colors hover:text-foreground"
              :aria-label="editingAssignee ? 'Stop editing assignee' : 'Edit assignee'"
              @click="editingAssignee = !editingAssignee"
            >
              <component :is="editingAssignee ? X : Pencil" class="size-3" />
            </button>
          </div>

          <div v-if="!editingAssignee" class="mt-2 flex items-center gap-2 text-sm">
            <template v-if="mr.assigneeId">
              <UserAvatar :user-id="mr.assigneeId" :name="nameOf(mr.assigneeId)" size="sm" />
              <span class="truncate">{{ nameOf(mr.assigneeId) }}</span>
            </template>
            <span v-else class="text-xs text-muted-foreground">Unassigned</span>
          </div>

          <div v-else class="mt-2 space-y-0.5">
            <button
              class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-muted"
              :class="mr.assigneeId === null ? 'bg-muted/70' : ''"
              :disabled="updateMr.isPending.value"
              @click="setAssignee(null)"
            >
              <span class="size-5" />
              <span class="text-muted-foreground">Unassigned</span>
            </button>
            <button
              v-for="m in members"
              :key="m.userId"
              class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-muted"
              :class="mr.assigneeId === m.userId ? 'bg-muted/70' : ''"
              :disabled="updateMr.isPending.value"
              @click="setAssignee(m.userId)"
            >
              <UserAvatar :user-id="m.userId" :name="m.displayName" size="sm" />
              <span class="truncate">{{ m.displayName }}</span>
              <Check v-if="mr.assigneeId === m.userId" class="ml-auto size-3.5 text-primary" />
            </button>
          </div>
        </section>

        <!-- reviewers -->
        <section class="px-3 py-3">
          <div class="flex items-center gap-2">
            <h3 class="text-xs font-medium text-muted-foreground">
              Reviewers
              <span v-if="mr.reviewers.length > 0" class="text-muted-foreground/70">
                · {{ mr.reviewers.length }}
              </span>
            </h3>
            <button
              v-if="!readonly"
              class="ml-auto text-muted-foreground transition-colors hover:text-foreground"
              :aria-label="editingReviewers ? 'Stop editing reviewers' : 'Edit reviewers'"
              @click="editingReviewers ? cancelReviewers() : (editingReviewers = true)"
            >
              <component :is="editingReviewers ? X : Pencil" class="size-3" />
            </button>
          </div>

          <div v-if="!editingReviewers" class="mt-2 space-y-1.5">
            <p v-if="mr.reviewers.length === 0" class="text-xs text-muted-foreground">
              No reviewers requested
            </p>
            <div v-for="id in mr.reviewers" :key="id" class="flex items-center gap-2 text-sm">
              <UserAvatar :user-id="id" :name="nameOf(id)" size="sm" />
              <span class="truncate">{{ nameOf(id) }}</span>
              <span
                v-if="mr.approvedBy.includes(id)"
                class="ml-auto flex items-center gap-0.5 text-[11px] text-emerald-600"
              >
                <Check class="size-3" /> approved
              </span>
            </div>
          </div>

          <div v-else class="mt-2 space-y-0.5">
            <p v-if="members.length === 0" class="text-xs text-muted-foreground">
              No workspace members to request.
            </p>
            <Label
              v-for="m in members"
              :key="m.userId"
              class="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm font-normal transition-colors hover:bg-muted"
            >
              <Checkbox
                :model-value="selected.has(m.userId)"
                :disabled="saveReviewers.isPending.value"
                @update:model-value="toggleReviewer(m.userId)"
              />
              <UserAvatar :user-id="m.userId" :name="m.displayName" size="sm" />
              <span class="truncate">{{ m.displayName }}</span>
            </Label>
            <div v-if="reviewersDirty" class="flex gap-1.5 pt-1.5">
              <Button size="xs" :disabled="saveReviewers.isPending.value" @click="submitReviewers">
                Save
              </Button>
              <Button size="xs" variant="ghost" :disabled="saveReviewers.isPending.value" @click="cancelReviewers">
                Cancel
              </Button>
            </div>
          </div>
        </section>

        <!-- revisions -->
        <section class="px-3 py-3">
          <h3 class="text-xs font-medium text-muted-foreground">Revisions</h3>
          <dl class="mt-2 space-y-1.5">
            <div v-for="row in revisionRows" :key="row.label" class="flex items-baseline gap-2 text-xs">
              <dt class="shrink-0 text-muted-foreground">{{ row.label }}</dt>
              <dd class="ml-auto flex min-w-0 items-baseline gap-1.5">
                <span v-if="row.branch" class="truncate font-mono text-[11px] text-muted-foreground">
                  {{ row.branch }}
                </span>
                <RouterLink
                  :to="`/documents/${mr.documentId}?tab=revisions`"
                  class="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-primary transition-colors hover:bg-accent"
                >{{ row.id.slice(0, 8) }}</RouterLink>
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <!-- AI check: its own pane, actions docked -->
      <AiCheckPane
        v-show="pane === 'ai'"
        :merge-request="mr"
        :can-comment="canComment"
        :busy="busy"
        @comment="(b: string) => emit('comment', b)"
        @result="(c) => (aiCounts = c)"
      />
    </div>
  </aside>
</template>
