<script setup lang="ts">
/**
 * A source-backed page's extraction recipe (#674, phase 2), laid out as a
 * workbench: the recipe card on the left, what it makes of the last fetched
 * version on the right (as tall as the recipe, scrolling inside), and one
 * action dock pinned to the bottom that says whether it can be saved and saves it. What asks for a person leads as a
 * banner; the steady state stays quiet. In a column narrower than
 * 56rem the two cards share it and a switch picks one, so the bar is reachable from either.
 *
 * Nothing here is saved until Approve / Save, and the server refuses a recipe
 * whose checks fail — the disabled button only says so first. Selectors are
 * editable while a review is open (a draft waits, or a version is held);
 * normalization rules always are.
 *
 * The same workbench edits a crawled tree's recipe (phase 3b) at
 * /settings/connectors/:id/recipe: every page without its own reads with it.
 * The preview runs on one crawled page, the root unless another is picked,
 * and selectors are always editable there — writing one is the point.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  CloudOff,
  ExternalLink,
  LayoutTemplate,
  ListTree,
  LoaderCircle,
  Pause,
  Plus,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-vue-next'
import {
  SOURCE_HEADING_TAGS,
  SOURCE_RECIPE_RULE_KINDS,
  type CompareResponse,
  type DocumentSourceInfo,
  type DocumentSourceRecipeState,
  type SourceRecipe,
  type SourceRecipePreview,
  type SourceRecipeRule,
  type SourceTreeRecipeState,
} from '@knowledge/contracts'
import { lineDiff } from '@/core/line-diff'
import { DiffView, MarkdownView } from '@/entities/document'
import { api, apiQueryOptions } from '@/shared/api/queries'
import { relativeTime } from '@/shared/api/api'
import { errorMessage } from '@/shared/api/errors'
import { PageLayout, PageState } from '@/shared/layout'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { useAuthStore } from '@/stores/auth'
import { appliedChecks, blankRule, cleanRecipe, cloneRecipe, recipeAttention } from '../model/source-recipe'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const queryClient = useQueryClient()

/** A crawled tree's recipe (the connector's), rather than one page's. */
const tree = computed(() => route.path.startsWith('/settings/connectors/'))
/** The page id, or for a tree the connector id. */
const id = computed(() => String(route.params.id))
const path = () => ({ path: { id: id.value } })
const sourceOptions = computed(() => apiQueryOptions('/v1/documents/{id}/source', path()))
const sourceQuery = useQuery(computed(() => ({ ...sourceOptions.value, enabled: !tree.value })))
const treeOptions = computed(() => apiQueryOptions('/v1/connectors/{id}/source/recipe', path()))
const treeQuery = useQuery(computed(() => ({ ...treeOptions.value, enabled: tree.value })))
const loadError = computed(() => (tree.value ? treeQuery : sourceQuery).error.value)

const pageSource = computed(() => sourceQuery.data.value as DocumentSourceInfo | undefined)
const treeState = computed(() => treeQuery.data.value as SourceTreeRecipeState | undefined)
/** The crawled page the tree's preview reads; the root (listed first) until another is picked. */
const pickedId = ref<string | null>(null)
const picked = computed(() => treeState.value?.pages.find((p) => p.documentId === pickedId.value) ?? treeState.value?.pages[0] ?? null)
/** What the head reads: the page's source, or the tree's root URL. */
const source = computed(() => {
  if (!tree.value) return pageSource.value
  const s = treeState.value
  return s ? { url: s.url, host: s.host, pausedAt: null as string | null } : undefined
})
/** A tree has no held version or layout note of its own: those are each page's. */
const state = computed<DocumentSourceRecipeState | undefined>(() => {
  if (!tree.value) return pageSource.value?.recipe
  const s = treeState.value
  return s && { active: s.active, proposal: s.proposal, heldAt: null, heldReasons: [], heldDetail: null, structureChangedAt: null, hasBody: !!picked.value?.hasBody }
})
const attention = computed(() => recipeAttention(state.value))
const canEdit = computed(() => auth.canEdit)
const selectorsEditable = computed(() => canEdit.value && (tree.value || attention.value === 'held' || attention.value === 'proposal'))
/** Where the person goes once the recipe is saved: the page, or the tree's root. */
const home = computed(() =>
  tree.value ? (treeState.value?.rootDocumentId ? `/documents/${treeState.value.rootDocumentId}` : `/settings/connectors/${id.value}`) : `/documents/${id.value}`,
)

// ---------------------------------------------------------------- the working copy

const draft = ref<SourceRecipe>(cloneRecipe(null))
/** Reseeded when the recipe under review changes, never while a person types. */
watch(
  () => [state.value?.proposal?.id, state.value?.active?.id] as const,
  () => {
    draft.value = cloneRecipe(state.value?.proposal?.recipe ?? state.value?.active?.recipe)
  },
  { immediate: true },
)
const baseline = computed(() => JSON.stringify(cleanRecipe(cloneRecipe(state.value?.proposal?.recipe ?? state.value?.active?.recipe))))
const dirty = computed(() => JSON.stringify(cleanRecipe(draft.value)) !== baseline.value)

function addSelector(list: 'content' | 'strip' | 'landmarks') {
  draft.value[list].push('')
}
function removeAt<T>(items: T[], index: number) {
  items.splice(index, 1)
}
function setKind(index: number, kind: unknown) {
  draft.value.rules[index] = blankRule(kind as SourceRecipeRule['kind'])
}
function setHeading(tag: (typeof SOURCE_HEADING_TAGS)[number], value: unknown) {
  if (value === 'keep') delete draft.value.headings[tag]
  else draft.value.headings[tag] = Number(value)
}
const headingCount = computed(() => Object.keys(draft.value.headings).length)

// ---------------------------------------------------------------- the preview

/** The tree routes' page argument: the picked page, or nothing for the root. */
const pageArg = () => (picked.value ? { documentId: picked.value.documentId } : {})
/** Pages that read with the tree's recipe: those without their own. */
const treeReaders = computed(() => treeState.value?.pages.filter((p) => !p.ownRecipe).length ?? 0)

const preview = ref<SourceRecipePreview | null>(null)
const previewError = ref<string | null>(null)
const previewing = ref(false)
let previewSeq = 0
let timer: ReturnType<typeof setTimeout> | undefined

async function runPreview() {
  if (!canEdit.value || !state.value?.hasBody) return
  const seq = ++previewSeq
  previewing.value = true
  try {
    const recipe = cleanRecipe(draft.value)
    const next = tree.value
      ? await api.post('/v1/connectors/{id}/source/recipe/preview', { ...path(), body: { recipe, ...pageArg() } })
      : await api.post('/v1/documents/{id}/source/recipe/preview', { ...path(), body: { recipe } })
    if (seq !== previewSeq) return
    preview.value = next
    previewError.value = null
  } catch (e) {
    if (seq === previewSeq) previewError.value = errorMessage(e, t)
  } finally {
    if (seq === previewSeq) previewing.value = false
  }
}
watch(
  draft,
  () => {
    clearTimeout(timer)
    timer = setTimeout(runPreview, 600)
  },
  { deep: true },
)
watch(() => [state.value?.hasBody, picked.value?.documentId] as const, ([has]) => has && runPreview(), { immediate: true })
onBeforeUnmount(() => clearTimeout(timer))

const view = ref<'changes' | 'page'>('changes')
const compare = computed<CompareResponse | null>(() => {
  if (!preview.value) return null
  const { hunks, additions, deletions } = lineDiff(preview.value.before, preview.value.after)
  return {
    documentId: picked.value?.documentId ?? id.value,
    from: { revisionId: `${id.value}:head`, revisionNumber: 0, branch: null, contentHash: null },
    to: { revisionId: `${id.value}:recipe`, revisionNumber: 0, branch: null, contentHash: null },
    comparisonMode: 'direct',
    mergeBaseRevisionId: null,
    summary: { additions, deletions },
    hunks,
    structural: null,
    semantic: null,
  }
})
const checks = computed(() =>
  appliedChecks(cleanRecipe(draft.value)).map((kind) => ({ kind, ok: !preview.value?.failures.includes(kind) })),
)
const failing = computed(() => (preview.value?.failures.length ?? 0) > 0)
/** A selector's match count, once the preview that counted it is in. */
function hits(selector: string): number | null {
  const n = preview.value?.hits[selector.trim()]
  return n === undefined ? null : n
}

// ---------------------------------------------------------------- actions

/** Below `lg` the two cards share one column; this picks which one shows. */
const pane = ref<'recipe' | 'preview'>('recipe')

/** The banner's tone and icon follow what is asked of the person; the steady state has none. */
const BANNER = {
  held: { icon: ShieldAlert, box: 'border-panel-caution/40 bg-panel-caution/8', ink: 'text-panel-caution-ink' },
  proposal: { icon: Bot, box: 'border-panel-important/35 bg-panel-important/8', ink: 'text-panel-important-ink' },
  changed: { icon: LayoutTemplate, box: 'kn-callout-warning', ink: 'text-panel-warning-ink' },
} as const
const banner = computed(() => (attention.value ? BANNER[attention.value] : null))
/** What the recipe card is reading with, as its header's one fact. */
const readingWith = computed(() =>
  state.value?.proposal
    ? t('sources.recipe.rail.proposal')
    : state.value?.active
      ? t(state.value.active.connectorScope && !tree.value ? 'sources.recipe.rail.activeTree' : 'sources.recipe.rail.active', { n: state.value.active.version })
      : t('sources.recipe.rail.implicit'),
)

const busy = ref<'save' | 'dismiss' | 'draft' | null>(null)

/**
 * The dock's one line: what stands between this recipe and Save, or that
 * nothing does. Read in the same order as `blockedReason`, which stays the
 * single answer to whether Save is enabled.
 */
const TONE = {
  muted: 'bg-muted text-muted-foreground',
  caution: 'bg-panel-caution/12 text-panel-caution-ink',
  tip: 'bg-panel-tip/12 text-panel-tip-ink',
} as const
const dock = computed(() => {
  const s = state.value
  if (!s) return null
  if (busy.value === 'save') return { icon: LoaderCircle, spin: true, chip: TONE.muted, title: t('sources.recipe.saving'), detail: null }
  if (!s.hasBody) return { icon: CloudOff, spin: false, chip: TONE.muted, title: t('sources.recipe.dock.noBody'), detail: t('sources.recipe.blocked.noBody') }
  if (previewError.value) return { icon: CircleAlert, spin: false, chip: TONE.caution, title: t('sources.recipe.dock.previewFailed'), detail: previewError.value }
  if (previewing.value || !preview.value) return { icon: LoaderCircle, spin: true, chip: TONE.muted, title: t('sources.recipe.dock.checking'), detail: null }
  if (failing.value) {
    const n = preview.value.failures.length
    return { icon: CircleX, spin: false, chip: TONE.caution, title: t('sources.recipe.dock.failing', { n }, n), detail: t('sources.recipe.blocked.checks') }
  }
  if (blockedReason.value) return { icon: CircleDashed, spin: false, chip: TONE.muted, title: t('sources.recipe.dock.unchanged'), detail: blockedReason.value }
  return {
    icon: CircleCheck,
    spin: false,
    chip: TONE.tip,
    title: s.proposal ? t('sources.recipe.dock.readyApprove') : t('sources.recipe.dock.ready'),
    detail: dirty.value ? `${t('sources.recipe.unsaved')} · ${t('sources.recipe.ready')}` : t('sources.recipe.ready'),
  }
})
const blockedReason = computed(() => {
  if (!state.value?.hasBody) return t('sources.recipe.blocked.noBody')
  if (previewing.value || !preview.value) return t('sources.recipe.blocked.previewing')
  if (previewError.value) return previewError.value
  if (failing.value) return t('sources.recipe.blocked.checks')
  if (!dirty.value && !state.value.proposal && !state.value.heldAt) return t('sources.recipe.blocked.unchanged')
  return null
})

async function act(name: NonNullable<typeof busy.value>, run: () => Promise<DocumentSourceInfo | SourceTreeRecipeState>, done: string, leave = false) {
  if (busy.value) return
  busy.value = name
  try {
    const next = await run()
    queryClient.setQueryData((tree.value ? treeOptions : sourceOptions).value.queryKey, next as never)
    toast.success(t(done))
    if (leave) await router.push(home.value)
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = null
  }
}
const save = () => {
  const body = { recipe: cleanRecipe(draft.value), ...(state.value?.proposal ? { proposalId: state.value.proposal.id } : {}) }
  return act(
    'save',
    () =>
      tree.value
        ? api.put('/v1/connectors/{id}/source/recipe', { ...path(), body: { ...body, ...pageArg() } })
        : api.put('/v1/documents/{id}/source/recipe', { ...path(), body }),
    tree.value ? 'sources.recipe.treeSaved' : state.value?.proposal ? 'sources.recipe.approved' : 'sources.recipe.saved',
    true,
  )
}
const dismiss = () =>
  act(
    'dismiss',
    () => (tree.value ? api.post('/v1/connectors/{id}/source/recipe/dismiss', path()) : api.post('/v1/documents/{id}/source/recipe/dismiss', path())),
    'sources.recipe.dismissed',
  )
const redraft = () =>
  act(
    'draft',
    () =>
      tree.value
        ? api.post('/v1/connectors/{id}/source/recipe/draft', { ...path(), body: pageArg() })
        : api.post('/v1/documents/{id}/source/recipe/draft', path()),
    'sources.recipe.drafted',
  )
</script>

<template>
  <PageLayout
    variant="list"
    :title="tree ? t('sources.recipe.tree.heading') : t('sources.recipe.heading')"
    :subtitle="tree ? t('sources.recipe.tree.subtitle') : t('sources.recipe.subtitle')"
  >
    <!-- The standard head: what it reads with as a badge, the source as the one action. Breadcrumbs lead back to the page. -->
    <template v-if="state" #status>
      <Badge variant="outline">{{ readingWith }}</Badge>
      <Badge v-if="tree" variant="outline" class="tabular-nums">{{ t('sources.recipe.tree.pages', { n: treeReaders }, treeReaders) }}</Badge>
      <Badge v-if="source?.pausedAt" variant="outline" class="gap-1 text-muted-foreground"><Pause class="size-3" aria-hidden="true" />{{ t('sources.state.paused') }}</Badge>
    </template>
    <template v-if="source" #actions>
      <Button v-if="tree && treeState?.rootDocumentId" as-child size="sm" variant="outline">
        <RouterLink :to="`/documents/${treeState.rootDocumentId}`">
          <ListTree class="size-3.5" aria-hidden="true" /> {{ t('sources.recipe.tree.openRoot') }}
        </RouterLink>
      </Button>
      <Button as-child size="sm" variant="outline">
        <a :href="source.url" target="_blank" rel="noopener noreferrer" :title="source.url">
          <ExternalLink class="size-3.5" aria-hidden="true" /> {{ t('sources.recipe.openSource', { host: source.host }) }}
        </a>
      </Button>
    </template>

    <PageState v-if="loadError" state="error" :error="loadError" />

    <template v-else-if="source && state">
      <!-- What is asked of the person, when anything is. The steady state has no banner. -->
      <div v-if="banner" class="flex flex-wrap items-start gap-x-3 gap-y-2.5 rounded-xl border px-4 py-3.5 text-sm" :class="banner.box" role="status">
        <component :is="banner.icon" class="mt-0.5 size-4 shrink-0" :class="banner.ink" aria-hidden="true" />
        <div class="kn-measure min-w-0 flex-1 basis-60 space-y-1 text-foreground">
          <p v-if="attention === 'held'" class="font-medium">
            {{ t('sources.recipe.status.held', { checks: state.heldReasons.map((r) => t(`sources.recipe.check.${r}`)).join(', ') }) }}
          </p>
          <p v-else-if="attention === 'proposal'" class="font-medium">{{ t('sources.recipe.status.proposal') }}</p>
          <p v-else class="font-medium">{{ t('sources.recipe.status.changed', { when: relativeTime(state.structureChangedAt!) }) }}</p>
          <p v-if="state.proposal" class="text-muted-foreground [overflow-wrap:anywhere]">
            <span class="sr-only">{{ t('sources.recipe.byAgent') }}: </span>{{ state.proposal.note || t('sources.recipe.noNote') }}
          </p>
          <p v-else-if="attention === 'held'" class="text-muted-foreground">{{ t('sources.recipe.status.heldHint') }}</p>
          <p v-if="source.pausedAt" class="text-muted-foreground">{{ t('sources.recipe.paused') }}</p>
        </div>
        <!-- The banner asks the question, so it carries the "no"; the dock carries Save / Approve. -->
        <Button
          v-if="canEdit && (state.proposal || attention === 'changed')"
          type="button"
          size="sm"
          variant="outline"
          class="ml-auto shrink-0 bg-card"
          :disabled="busy !== null"
          @click="dismiss"
        >
          {{ state.proposal ? t('sources.recipe.reject') : t('sources.recipe.keep') }}
        </Button>
      </div>
      <p v-else-if="source.pausedAt" class="kn-measure text-sm text-muted-foreground">{{ t('sources.recipe.paused') }}</p>

      <!-- The workbench answers to its own width, not the window's: with the
           sidebar open a 1280px screen leaves too little for two panes. -->
      <div class="@container flex min-w-0 flex-col gap-4">
        <!-- Narrow: one card at a time. -->
        <div class="grid grid-cols-2 rounded-lg border bg-muted/40 p-1 @4xl:hidden" role="group" :aria-label="t('sources.recipe.pane')">
          <button
            v-for="p in (['recipe', 'preview'] as const)"
            :key="p"
            type="button"
            class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            :class="pane === p ? 'bg-card text-foreground shadow-xs dark:bg-accent dark:text-accent-foreground' : 'text-muted-foreground hover:text-foreground'"
            :aria-pressed="pane === p"
            @click="pane = p"
          >
            {{ p === 'recipe' ? t('sources.recipe.card.title') : t('sources.recipe.preview') }}
            <span v-if="p === 'preview' && preview" class="size-1.5 rounded-full" :class="failing ? 'bg-panel-caution' : 'bg-panel-tip'" aria-hidden="true" />
          </button>
        </div>

        <div class="grid gap-6 @4xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] @6xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
          <!-- The recipe -->
          <Card class="min-w-0 gap-0 py-0" :class="pane !== 'recipe' && '@max-4xl:hidden'">
            <form id="recipe-form" class="min-w-0 divide-y" novalidate @submit.prevent="save">
              <header class="space-y-1 px-5 py-4">
                <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h2 class="font-display text-base font-semibold tracking-tight">{{ t('sources.recipe.card.title') }}</h2>
                  <span v-if="dirty" class="text-caption text-muted-foreground">{{ t('sources.recipe.unsaved') }}</span>
                </div>
                <p class="text-xs text-muted-foreground">{{ t('sources.recipe.card.lede') }}</p>
              </header>

              <fieldset v-for="list in (['content', 'strip', 'landmarks'] as const)" :key="list" class="min-w-0 space-y-2.5 px-5 py-4">
                <div class="space-y-0.5">
                  <legend class="text-sm font-medium">{{ t(`sources.recipe.${list}.label`) }}</legend>
                  <p class="text-xs text-muted-foreground">{{ t(`sources.recipe.${list}.hint`) }}</p>
                </div>
                <template v-if="selectorsEditable">
                  <ul v-if="draft[list].length" class="space-y-1.5">
                    <li v-for="(_, i) in draft[list]" :key="i" class="flex items-center gap-1.5">
                      <Input
                        v-model="draft[list][i]"
                        spellcheck="false"
                        autocomplete="off"
                        class="h-8 min-w-0 flex-1 font-mono text-ui"
                        :aria-label="t(`sources.recipe.${list}.row`, { n: i + 1 })"
                        :placeholder="t(`sources.recipe.${list}.placeholder`)"
                      />
                      <!-- One fixed slot on every row, so the inputs line up and "no match" never runs into Remove. -->
                      <span
                        class="w-24 shrink-0 truncate text-right text-caption max-sm:w-auto whitespace-nowrap tabular-nums"
                        :class="hits(draft[list][i]!) ? 'text-muted-foreground' : 'text-panel-caution-ink'"
                      ><template v-if="draft[list][i]!.trim() && hits(draft[list][i]!) !== null">{{ hits(draft[list][i]!) ? t('sources.recipe.matches', { n: hits(draft[list][i]!) }, hits(draft[list][i]!)!) : t('sources.recipe.noMatch') }}</template></span>
                      <Button type="button" size="icon-sm" variant="ghost" class="kn-hit shrink-0" :aria-label="t('sources.recipe.remove')" @click="removeAt(draft[list], i)">
                        <X class="size-3.5" />
                      </Button>
                    </li>
                  </ul>
                  <Button type="button" size="sm" variant="outline" class="border-dashed" @click="addSelector(list)">
                    <Plus class="size-3.5" /> {{ t('sources.recipe.addSelector') }}
                  </Button>
                </template>
                <template v-else>
                  <ul v-if="draft[list].length" class="divide-y rounded-lg border">
                    <li v-for="s in draft[list]" :key="s" class="flex items-center gap-3 px-3 py-2">
                      <code class="min-w-0 flex-1 truncate font-mono text-ui" :title="s">{{ s }}</code>
                      <span
                        v-if="hits(s) !== null"
                        class="shrink-0 text-caption tabular-nums"
                        :class="hits(s) ? 'text-muted-foreground' : 'text-panel-caution-ink'"
                      >{{ hits(s) ? t('sources.recipe.matches', { n: hits(s) }, hits(s)!) : t('sources.recipe.noMatch') }}</span>
                    </li>
                  </ul>
                  <p v-else class="rounded-lg border border-dashed px-3 py-2 text-ui text-muted-foreground">{{ t(`sources.recipe.${list}.none`) }}</p>
                </template>
              </fieldset>

              <details class="group min-w-0" :open="headingCount > 0 || undefined">
                <summary
                  class="flex min-h-12 cursor-pointer list-none items-center gap-2 px-5 text-sm font-medium outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset [&::-webkit-details-marker]:hidden"
                >
                  <span class="flex-1">{{ t('sources.recipe.headings.label') }}</span>
                  <span v-if="headingCount" class="text-caption font-normal text-muted-foreground">{{ t('sources.recipe.headings.count', { n: headingCount }, headingCount) }}</span>
                  <ChevronRight class="size-4 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                </summary>
                <div class="space-y-2.5 px-5 pb-4">
                  <p class="text-xs text-muted-foreground">{{ t('sources.recipe.headings.hint') }}</p>
                  <div class="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
                    <label v-for="tag in SOURCE_HEADING_TAGS" :key="tag" class="flex min-w-0 items-center gap-2 text-ui">
                      <code class="w-5 shrink-0 font-mono text-muted-foreground">{{ tag }}</code>
                      <Select
                        :model-value="draft.headings[tag] ? String(draft.headings[tag]) : 'keep'"
                        :disabled="!selectorsEditable"
                        @update:model-value="setHeading(tag, $event)"
                      >
                        <SelectTrigger size="sm" class="min-w-0 flex-1" :aria-label="t('sources.recipe.headings.row', { tag })"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="keep">{{ t('sources.recipe.headings.keep') }}</SelectItem>
                          <SelectItem v-for="n in 6" :key="n" :value="String(n)">{{ t('sources.recipe.headings.level', { n }) }}</SelectItem>
                        </SelectContent>
                      </Select>
                    </label>
                  </div>
                </div>
              </details>

              <fieldset class="min-w-0 space-y-2.5 px-5 py-4">
                <div class="space-y-0.5">
                  <legend class="text-sm font-medium">{{ t('sources.recipe.rules.label') }}</legend>
                  <p class="text-xs text-muted-foreground">{{ t('sources.recipe.rules.hint') }}</p>
                </div>
                <ol v-if="draft.rules.length" class="divide-y rounded-lg border">
                  <li v-for="(rule, i) in draft.rules" :key="i" class="space-y-2 p-2.5">
                    <div class="flex items-center gap-2">
                      <span class="w-4 shrink-0 text-center text-caption text-muted-foreground tabular-nums" aria-hidden="true">{{ i + 1 }}</span>
                      <Select :model-value="rule.kind" :disabled="!canEdit" @update:model-value="setKind(i, $event)">
                        <SelectTrigger size="sm" class="min-w-0 flex-1" :aria-label="t('sources.recipe.rules.kind', { n: i + 1 })"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="kind in SOURCE_RECIPE_RULE_KINDS" :key="kind" :value="kind">{{ t(`sources.recipe.rules.kinds.${kind}`) }}</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button v-if="canEdit" type="button" size="icon-sm" variant="ghost" class="kn-hit shrink-0" :aria-label="t('sources.recipe.remove')" @click="removeAt(draft.rules, i)">
                        <X class="size-3.5" />
                      </Button>
                    </div>
                    <div class="pl-6">
                      <Input
                        v-if="rule.kind === 'drop-section'"
                        v-model="rule.heading"
                        :readonly="!canEdit"
                        class="h-8 text-ui"
                        :aria-label="t('sources.recipe.rules.heading')"
                        :placeholder="t('sources.recipe.rules.heading')"
                      />
                      <div v-else class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
                        <Input
                          v-model="rule.from"
                          :readonly="!canEdit"
                          class="h-8 text-ui"
                          :class="rule.kind === 'rewrite-links' && 'font-mono'"
                          :aria-label="t(`sources.recipe.rules.from.${rule.kind}`)"
                          :placeholder="t(`sources.recipe.rules.from.${rule.kind}`)"
                        />
                        <span class="text-muted-foreground" aria-hidden="true">→</span>
                        <Input
                          v-model="rule.to"
                          :readonly="!canEdit"
                          class="h-8 text-ui"
                          :class="rule.kind === 'rewrite-links' && 'font-mono'"
                          :aria-label="t(`sources.recipe.rules.to.${rule.kind}`)"
                          :placeholder="t(`sources.recipe.rules.to.${rule.kind}`)"
                        />
                      </div>
                    </div>
                  </li>
                </ol>
                <p v-else class="rounded-lg border border-dashed px-3 py-2 text-ui text-muted-foreground">{{ t('sources.recipe.rules.none') }}</p>
                <Button v-if="canEdit" type="button" size="sm" variant="outline" class="border-dashed" @click="draft.rules.push(blankRule('drop-section'))">
                  <Plus class="size-3.5" /> {{ t('sources.recipe.rules.add') }}
                </Button>
              </fieldset>

              <p v-if="!canEdit" class="px-5 py-4 text-xs text-muted-foreground">{{ t('sources.recipe.viewerHint') }}</p>
            </form>
          </Card>

          <!-- What the recipe makes of the last fetched version: beside the recipe and as tall as it, scrolling inside. -->
          <Card
            class="min-w-0 gap-0 overflow-hidden py-0 @4xl:relative @4xl:min-h-[24rem]"
            :class="pane !== 'preview' && '@max-4xl:hidden'"
          >
            <!-- Absolute from 56rem up, so the row is as tall as the recipe and the preview scrolls inside it. -->
            <section class="flex min-h-0 flex-1 flex-col @4xl:absolute @4xl:inset-0" :aria-labelledby="'recipe-preview-title'" :aria-busy="previewing">
              <header class="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b px-5 py-4">
                <div class="min-w-0 space-y-1">
                  <h2 id="recipe-preview-title" class="font-display text-base font-semibold tracking-tight">{{ t('sources.recipe.preview') }}</h2>
                  <p class="text-xs text-muted-foreground">{{ t('sources.recipe.previewLede', { host: source.host }) }}</p>
                </div>
                <div class="inline-flex shrink-0 rounded-lg border bg-muted/40 p-0.5" role="group" :aria-label="t('sources.recipe.previewAs')">
                  <button
                    v-for="v in (['changes', 'page'] as const)"
                    :key="v"
                    type="button"
                    class="inline-flex min-h-8 items-center gap-1.5 rounded-md px-3 text-ui outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    :class="view === v ? 'bg-card text-foreground shadow-xs dark:bg-accent dark:text-accent-foreground' : 'text-muted-foreground hover:text-foreground'"
                    :aria-pressed="view === v"
                    @click="view = v"
                  >
                    {{ t(`sources.recipe.view.${v}`) }}
                    <span v-if="v === 'changes' && compare" class="text-caption tabular-nums">
                      <span class="text-panel-tip-ink">+{{ compare.summary.additions }}</span>
                      <span class="text-panel-caution-ink"> −{{ compare.summary.deletions }}</span>
                    </span>
                  </button>
                </div>
              </header>

              <!-- A tree previews on one crawled page at a time: the root unless another is picked. -->
              <div v-if="tree && treeState?.pages.length" class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-2.5 text-ui">
                <label for="recipe-page" class="shrink-0 text-muted-foreground">{{ t('sources.recipe.tree.previewOn') }}</label>
                <Select :model-value="picked?.documentId" @update:model-value="pickedId = String($event)">
                  <SelectTrigger id="recipe-page" size="sm" class="min-w-0 flex-1 basis-48"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="p in treeState.pages" :key="p.documentId" :value="p.documentId">
                      {{ p.title }}<template v-if="p.documentId === treeState.rootDocumentId"> · {{ t('sources.recipe.tree.root') }}</template>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p v-if="picked?.ownRecipe" class="basis-full text-caption text-muted-foreground">{{ t('sources.recipe.tree.ownRecipe') }}</p>
                <p v-else-if="picked?.heldAt" class="basis-full text-caption text-panel-caution-ink">{{ t('sources.recipe.tree.held') }}</p>
              </div>

              <ul v-if="preview" class="flex flex-wrap gap-x-5 gap-y-1.5 border-b bg-muted/30 px-5 py-2.5 text-ui">
                <li v-for="c in checks" :key="c.kind" class="flex items-center gap-1.5" :class="c.ok ? 'text-muted-foreground' : 'font-medium text-panel-caution-ink'">
                  <component :is="c.ok ? Check : X" class="size-3.5 shrink-0" :class="c.ok && 'text-panel-tip-ink'" aria-hidden="true" />
                  <span>{{ t(`sources.recipe.check.${c.kind}`) }}</span>
                  <span class="sr-only">{{ c.ok ? t('sources.recipe.checkPasses') : t('sources.recipe.checkFails') }}</span>
                </li>
              </ul>

              <div class="min-h-0 flex-1 overflow-auto" tabindex="0" :aria-label="t('sources.recipe.preview')">
                <p v-if="!state.hasBody" class="kn-measure p-5 text-sm text-muted-foreground">{{ t('sources.recipe.noBody') }}</p>
                <p v-else-if="!canEdit" class="kn-measure p-5 text-sm text-muted-foreground">{{ t('sources.recipe.viewerPreview') }}</p>
                <p v-else-if="previewError" role="alert" class="p-5 text-sm [overflow-wrap:anywhere] text-destructive">{{ previewError }}</p>
                <div v-else-if="!preview" class="space-y-3 p-5" aria-hidden="true">
                  <div v-for="(w, i) in ['w-2/3', 'w-full', 'w-5/6', 'w-full', 'w-3/4', 'w-1/2']" :key="i" class="h-3 animate-pulse rounded bg-muted motion-reduce:animate-none" :class="w" />
                </div>
                <div v-else class="p-5" :class="previewing && 'opacity-60 transition-opacity motion-reduce:transition-none'">
                  <!-- Nothing to diff is an answer, not an empty pane: say so and offer the page. -->
                  <div v-if="view === 'changes' && compare && !compare.hunks.length" class="grid min-h-48 place-items-center text-center">
                    <div class="space-y-3">
                      <p class="text-sm text-muted-foreground">{{ t('sources.recipe.sameResult') }}</p>
                      <Button type="button" size="sm" variant="outline" @click="view = 'page'">{{ t('sources.recipe.showPage') }}</Button>
                    </div>
                  </div>
                  <DiffView v-else-if="view === 'changes' && compare" :compare="compare" />
                  <MarkdownView v-else-if="preview.after.trim()" :markdown="preview.after" />
                  <p v-else class="text-sm text-muted-foreground">{{ t('sources.recipe.emptyResult') }}</p>
                </div>
              </div>
            </section>
          </Card>
        </div>

        <!-- The one place a recipe is published from, reachable whichever card is showing:
             what stands between the recipe and Save on the left, the actions on the right. -->
        <div
          v-if="canEdit && dock"
          class="sticky bottom-3 z-10 flex min-h-14 items-center gap-3 rounded-xl border bg-card py-2 pr-2 pl-2.5 shadow-[0_16px_48px_-12px] shadow-foreground/20 dark:shadow-black/60"
        >
          <span class="grid size-9 shrink-0 place-items-center rounded-lg" :class="dock.chip" aria-hidden="true">
            <component :is="dock.icon" class="size-4" :class="dock.spin && 'motion-safe:animate-spin'" />
          </span>
          <div class="min-w-0 flex-1" aria-live="polite">
            <p class="truncate text-sm font-medium" :title="dock.title">{{ dock.title }}</p>
            <p v-if="dock.detail" id="recipe-blocked" class="truncate text-caption text-muted-foreground max-sm:sr-only" :title="dock.detail">{{ dock.detail }}</p>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <Button
              v-if="state.hasBody"
              type="button"
              variant="ghost"
              class="max-sm:w-9 max-sm:px-0"
              :disabled="busy !== null"
              :aria-busy="busy === 'draft'"
              :title="state.proposal ? t('sources.recipe.redraft') : t('sources.recipe.draft')"
              @click="redraft"
            >
              <Sparkles class="size-4" :class="busy === 'draft' && 'motion-safe:animate-pulse'" aria-hidden="true" />
              <!-- Icon-only below 40rem so the dock keeps one row; the name stays for a screen reader. -->
              <span class="max-sm:sr-only">{{ busy === 'draft' ? t('sources.recipe.drafting') : state.proposal ? t('sources.recipe.redraft') : t('sources.recipe.draft') }}</span>
            </Button>
            <Button
              type="submit"
              form="recipe-form"
              class="max-sm:w-9 max-sm:px-0"
              :disabled="!!blockedReason || busy !== null"
              :aria-describedby="dock.detail ? 'recipe-blocked' : undefined"
              :title="state.proposal ? t('sources.recipe.approve') : t('sources.recipe.save')"
            >
              <LoaderCircle v-if="busy === 'save'" class="size-4 sm:hidden motion-safe:animate-spin" aria-hidden="true" />
              <Check v-else class="size-4 sm:hidden" aria-hidden="true" />
              <!-- Icon-only below 40rem, like Draft beside it; the name stays for a screen reader. -->
              <span class="max-sm:sr-only">{{ busy === 'save' ? t('sources.recipe.saving') : state.proposal ? t('sources.recipe.approve') : t('sources.recipe.save') }}</span>
            </Button>
          </div>
        </div>
      </div>
    </template>

    <PageState v-else state="loading" :rows="2" row-class="h-64" />
  </PageLayout>
</template>
