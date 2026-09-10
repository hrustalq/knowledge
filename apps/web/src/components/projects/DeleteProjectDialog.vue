<script setup lang="ts">
/**
 * Removing a project.
 *
 * Two ways out, and this dialog exists to make the difference legible before
 * either is taken.
 *
 * **Move** is the default and the shape the product is built for: documents are
 * never deleted anywhere else in it, so a project's contents are reassigned to
 * a sibling and the emptied project is then dropped. That makes the destination
 * the whole decision, which is why it is asked here rather than being something
 * you arrange yourself beforehand.
 *
 * **Delete everything** is the destructive path: pages, revisions, stored
 * files, merge requests, discussions and workflow runs, gone. It is offered
 * second, never preselected, and gated on typing the project's name — which
 * the server checks too, because an irreversible act should not be confirmable
 * only by the client that asked for it. The counts shown for it are the
 * argument: "12 pages" and "340 stored files" are different sentences.
 *
 * A dialog rather than `confirm()` — the precedent set in WorkflowSettingsPage:
 * this is workspace-shaping, the sentence explaining what actually happens is
 * too long to fit in a native confirm, and a native confirm cannot be
 * translated with the rest of the product. The string it replaced said "this
 * cannot be undone", which was also the opposite of the truth.
 *
 * The impact list carries no links. Every scope-shaped destination
 * (/settings/glossary, /settings/connectors) reads the *active* project, so a
 * link from here would land on a different project's vocabulary; and a link
 * inside a destructive dialog navigates away mid-decision, taking the dialog
 * with it. The list is a manifest, not a navigation surface.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  BookMarked,
  Eye,
  FileText,
  FileUp,
  Loader2,
  Plug,
  TriangleAlert,
  Workflow,
  type LucideIcon,
} from 'lucide-vue-next'
import type {
  DeleteProjectResponse,
  ProjectDeletionCounts,
  ProjectDeletionMode,
  ProjectDeletionPreview,
  ProjectSummary,
} from '@knowledge/contracts'
import { apiFetch } from '@/lib/api'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const { t } = useI18n()

const props = defineProps<{
  open: boolean
  project: ProjectSummary
  /** Every other project in the workspace — the candidate destinations. */
  siblings: ProjectSummary[]
}>()

const emit = defineEmits<{
  'update:open': [boolean]
  /**
   * Deleted. The whole result rather than just the destination: the page has to
   * say which of the two things happened, and `movedTo: null` alone cannot tell
   * an empty project apart from one that was destroyed.
   */
  deleted: [result: DeleteProjectResponse]
}>()

const preview = ref<ProjectDeletionPreview | null>(null)
const loading = ref(false)
const failed = ref<string | null>(null)
const target = ref('')
const working = ref(false)
/** Never preselected as `cascade`: the destructive option has to be chosen. */
const mode = ref<ProjectDeletionMode>('move')
/** The project name, typed back. Checked here and again on the server. */
const typedName = ref('')

/**
 * The preview is fetched twice on purpose.
 *
 * Opening asks "what is in here", which needs no destination. Choosing one asks
 * "and what does moving it *there* cost" — the glossary conflicts, which are a
 * property of the pair rather than of this project, so they cannot be known
 * until the question has a second half.
 */
async function load(withTarget?: string) {
  loading.value = true
  failed.value = null
  try {
    const q = withTarget ? `?target=${withTarget}` : ''
    preview.value = await apiFetch<ProjectDeletionPreview>(
      `/v1/projects/${props.project.projectId}/deletion-preview${q}`,
    )
  } catch (e) {
    failed.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    // Re-seeded per opening rather than kept: a project's holding changes while
    // the page is up, and a stale manifest is worse than a moment's spinner.
    preview.value = null
    target.value = ''
    mode.value = 'move'
    typedName.value = ''
    failed.value = null
    void load()
  },
  { immediate: true },
)

watch(target, (id) => {
  if (id) void load(id)
})

const counts = computed<ProjectDeletionCounts | null>(() => preview.value?.counts ?? null)

/**
 * One row per thing that actually exists. A zero is not information here — it
 * is a line the reader has to check and discard — so the manifest lists only
 * what is really about to move.
 */
const rows = computed(() => {
  const c = counts.value
  if (!c) return []
  const all: { key: keyof ProjectDeletionCounts; icon: LucideIcon; n: number }[] = [
    { key: 'documents', icon: FileText, n: c.documents },
    { key: 'glossaryTerms', icon: BookMarked, n: c.glossaryTerms },
    { key: 'connectors', icon: Plug, n: c.connectors },
    { key: 'workflowDefinitions', icon: Workflow, n: c.workflowDefinitions },
    { key: 'activeWorkflowRuns', icon: Loader2, n: c.activeWorkflowRuns },
    { key: 'pendingImports', icon: FileUp, n: c.pendingImports },
    { key: 'watchers', icon: Eye, n: c.watchers },
  ]
  return all.filter((r) => r.n > 0)
})

/** Work that is running right now, which a move relocates mid-flight. */
const inFlight = computed(
  () => (counts.value?.activeWorkflowRuns ?? 0) + (counts.value?.pendingImports ?? 0),
)

const conflicts = computed(() => preview.value?.glossaryConflicts ?? [])
const cascade = computed(() => preview.value?.cascade ?? null)

/**
 * What "delete everything" actually costs, as rows. Zeroes are dropped for the
 * same reason they are in the move manifest — a line reading "0 merge requests"
 * is a line to check and discard.
 */
const cascadeRows = computed(() => {
  const c = cascade.value
  if (!c) return []
  return (
    [
      ['documents', c.documents],
      ['revisions', c.revisions],
      ['storedFiles', c.storedFiles],
      ['attachments', c.attachments],
      ['mergeRequests', c.mergeRequests],
      ['discussions', c.discussions],
      ['workflowRuns', c.workflowRuns],
    ] as const
  ).filter(([, n]) => n > 0)
})

const nameMatches = computed(() => typedName.value.trim() === props.project.name)
const empty = computed(() => preview.value?.empty === true)
const blocked = computed(() => preview.value?.lastInWorkspace === true)
/**
 * An empty project needs no destination; a move needs one; a cascade needs the
 * name typed back instead.
 */
const ready = computed(() => {
  if (!preview.value || blocked.value) return false
  if (empty.value) return true
  return mode.value === 'cascade' ? nameMatches.value : !!target.value
})

async function confirm() {
  if (!ready.value || working.value) return
  working.value = true
  try {
    const q = empty.value
      ? ''
      : mode.value === 'cascade'
        ? `?mode=cascade&confirm=${encodeURIComponent(props.project.name)}`
        : `?moveContentsTo=${target.value}`
    const res = await apiFetch<DeleteProjectResponse>(
      `/v1/projects/${props.project.projectId}${q}`,
      { method: 'DELETE' },
    )
    emit('deleted', res)
    emit('update:open', false)
  } catch (e) {
    // The API's own message names which invariant refused (last project, a
    // holding with no destination) — surfacing it verbatim beats a generic
    // failure, and it arrives already translated.
    failed.value = (e as Error).message
  } finally {
    working.value = false
  }
}
</script>

<template>
  <AlertDialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
    <AlertDialogContent class="max-w-lg">
      <AlertDialogHeader>
        <AlertDialogTitle>
          {{ blocked ? t('project.delete.blockedTitle') : t('project.delete.title', { name: project.name }) }}
        </AlertDialogTitle>
        <AlertDialogDescription>
          <template v-if="blocked">{{ t('project.delete.blockedBody') }}</template>
          <template v-else-if="loading && !preview">{{ t('common.loading') }}</template>
          <template v-else-if="empty">{{ t('project.delete.emptyBody') }}</template>
          <template v-else-if="mode === 'cascade'">{{ t('project.delete.cascadeBody') }}</template>
          <template v-else>{{ t('project.delete.movingBody') }}</template>
        </AlertDialogDescription>
      </AlertDialogHeader>

      <div v-if="!blocked && preview" class="space-y-4">
        <!-- What moves. Counts only: this is the manifest, and the numbers are
             what decide whether the reader wants to go and look first. -->
        <ul v-if="rows.length" class="grid gap-1.5 rounded-md border bg-muted/40 p-3 sm:grid-cols-2">
          <li v-for="row in rows" :key="row.key" class="flex items-center gap-2 text-sm">
            <component :is="row.icon" class="size-4 shrink-0 text-muted-foreground" />
            <span>{{ t(`project.delete.count.${row.key}`, { n: row.n }, row.n) }}</span>
          </li>
        </ul>

        <p v-if="inFlight > 0 && mode === 'move'" class="text-muted-foreground flex items-start gap-2 text-xs">
          <Loader2 class="mt-0.5 size-3.5 shrink-0" />
          <span>{{ t('project.delete.inFlight') }}</span>
        </p>

        <!-- The choice itself. Move is first and preselected; the destructive
             option is reachable but never the default. -->
        <RadioGroup v-if="!empty" v-model="mode" class="gap-2">
          <div class="space-y-2 rounded-md border p-3" :class="mode === 'move' ? 'border-primary' : ''">
            <label class="flex items-start gap-2.5">
              <RadioGroupItem value="move" class="mt-0.5" />
              <span class="space-y-0.5">
                <span class="block text-sm font-medium">{{ t('project.delete.modeMove') }}</span>
                <span class="text-muted-foreground block text-xs">{{ t('project.delete.modeMoveHint') }}</span>
              </span>
            </label>

            <div v-if="mode === 'move'" class="space-y-1.5 pl-6">
              <Select v-model="target">
                <SelectTrigger class="w-full">
                  <SelectValue :placeholder="t('project.delete.destinationPlaceholder')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="p in siblings" :key="p.projectId" :value="p.projectId">
                    {{ p.name }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p v-if="!target" class="text-muted-foreground text-xs">
                {{ t('project.delete.pickFirst') }}
              </p>
            </div>
          </div>

          <div
            class="space-y-2 rounded-md border p-3"
            :class="mode === 'cascade' ? 'border-destructive bg-destructive/5' : ''"
          >
            <label class="flex items-start gap-2.5">
              <RadioGroupItem value="cascade" class="mt-0.5" />
              <span class="space-y-0.5">
                <span class="block text-sm font-medium">{{ t('project.delete.modeCascade') }}</span>
                <span class="text-muted-foreground block text-xs">{{ t('project.delete.modeCascadeHint') }}</span>
              </span>
            </label>

            <div v-if="mode === 'cascade'" class="space-y-2.5 pl-6">
              <!-- What it costs, in the units that make the decision: pages is
                   the number people expect, stored files is the one they do not. -->
              <ul class="grid gap-1 sm:grid-cols-2">
                <li
                  v-for="[key, n] in cascadeRows"
                  :key="key"
                  class="text-destructive flex items-center gap-2 text-xs"
                >
                  <TriangleAlert class="size-3.5 shrink-0" />
                  <span>{{ t(`project.delete.destroyed.${key}`, { n }, n) }}</span>
                </li>
              </ul>
              <p class="text-xs font-medium">{{ t('project.delete.irreversible') }}</p>
              <label class="block space-y-1">
                <span class="text-muted-foreground text-xs">
                  {{ t('project.delete.typeName', { name: project.name }) }}
                </span>
                <Input v-model="typedName" :placeholder="project.name" autocomplete="off" />
              </label>
            </div>
          </div>
        </RadioGroup>

        <!-- Said before the press, not discovered after it: a term defined in
             both projects cannot survive the move, because a project defines
             each term exactly once. -->
        <div
          v-if="conflicts.length && mode === 'move'"
          class="border-destructive/30 bg-destructive/5 space-y-1 rounded-md border p-3"
        >
          <p class="flex items-center gap-2 text-sm font-medium">
            <TriangleAlert class="size-4 shrink-0 text-destructive" />
            {{ t('project.delete.conflictsTitle', { n: conflicts.length }, conflicts.length) }}
          </p>
          <p class="text-muted-foreground text-xs">
            {{ t('project.delete.conflictsBody', { terms: conflicts.join(', ') }) }}
          </p>
        </div>

        <p v-if="failed" class="text-destructive text-sm">{{ failed }}</p>
      </div>

      <p v-else-if="failed" class="text-destructive text-sm">{{ failed }}</p>

      <AlertDialogFooter>
        <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
        <AlertDialogAction
          v-if="!blocked"
          class="bg-destructive text-white hover:bg-destructive/90"
          :disabled="!ready || working"
          @click.prevent="confirm"
        >
          {{
            working
              ? t(mode === 'cascade' ? 'project.delete.deleting' : 'project.delete.working')
              : empty
                ? t('project.delete.confirmEmpty')
                : mode === 'cascade'
                  ? t('project.delete.confirmCascade')
                  : t('project.delete.confirm')
          }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
