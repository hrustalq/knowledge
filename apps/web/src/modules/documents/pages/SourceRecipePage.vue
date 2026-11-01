<script setup lang="ts">
/**
 * A source-backed page's extraction recipe (#674, phase 2): the drafted or
 * current recipe on the left, what it makes of the last fetched version on
 * the right, and the one action that publishes it.
 *
 * Nothing here is saved until Approve / Save, and the server refuses a recipe
 * whose checks fail — the disabled button only says so first. Selectors are
 * editable while a review is open (a draft waits, or a version is held);
 * normalization rules always are.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ArrowLeft, Bot, Check, ChevronRight, Plus, Sparkles, X } from 'lucide-vue-next'
import {
  SOURCE_HEADING_TAGS,
  SOURCE_RECIPE_RULE_KINDS,
  type CompareResponse,
  type DocumentSourceInfo,
  type SourceRecipe,
  type SourceRecipePreview,
  type SourceRecipeRule,
} from '@knowledge/contracts'
import { lineDiff } from '@/core/line-diff'
import { DiffView, MarkdownView } from '@/entities/document'
import { api, apiQueryOptions } from '@/shared/api/queries'
import { relativeTime } from '@/shared/api/api'
import { errorMessage } from '@/shared/api/errors'
import { PageLayout } from '@/shared/layout'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { useAuthStore } from '@/stores/auth'
import { appliedChecks, blankRule, cleanRecipe, cloneRecipe, recipeAttention } from '../model/source-recipe'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const queryClient = useQueryClient()

const documentId = computed(() => String(route.params.id))
const path = () => ({ path: { id: documentId.value } })
const sourceOptions = computed(() => apiQueryOptions('/v1/documents/{id}/source', path()))
const sourceQuery = useQuery(sourceOptions)
const docQuery = useQuery(computed(() => apiQueryOptions('/v1/documents/{id}', path())))

const source = computed(() => sourceQuery.data.value as DocumentSourceInfo | undefined)
const state = computed(() => source.value?.recipe)
const attention = computed(() => recipeAttention(state.value))
const pageTitle = computed(() => docQuery.data.value?.document.title ?? '')
const canEdit = computed(() => auth.canEdit)
const selectorsEditable = computed(() => canEdit.value && (attention.value === 'held' || attention.value === 'proposal'))

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
    const next = await api.post('/v1/documents/{id}/source/recipe/preview', { ...path(), body: { recipe: cleanRecipe(draft.value) } })
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
watch(() => state.value?.hasBody, (has) => has && runPreview(), { immediate: true })
onBeforeUnmount(() => clearTimeout(timer))

const view = ref<'changes' | 'page'>('changes')
const compare = computed<CompareResponse | null>(() => {
  if (!preview.value) return null
  const { hunks, additions, deletions } = lineDiff(preview.value.before, preview.value.after)
  return {
    documentId: documentId.value,
    from: { revisionId: `${documentId.value}:head`, revisionNumber: 0, branch: null, contentHash: null },
    to: { revisionId: `${documentId.value}:recipe`, revisionNumber: 0, branch: null, contentHash: null },
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

const busy = ref<'save' | 'dismiss' | 'draft' | null>(null)
const blockedReason = computed(() => {
  if (!state.value?.hasBody) return t('sources.recipe.blocked.noBody')
  if (previewing.value || !preview.value) return t('sources.recipe.blocked.previewing')
  if (previewError.value) return previewError.value
  if (failing.value) return t('sources.recipe.blocked.checks')
  if (!dirty.value && !state.value.proposal && !state.value.heldAt) return t('sources.recipe.blocked.unchanged')
  return null
})

async function act(name: NonNullable<typeof busy.value>, run: () => Promise<DocumentSourceInfo>, done: string, leave = false) {
  if (busy.value) return
  busy.value = name
  try {
    const next = await run()
    queryClient.setQueryData(sourceOptions.value.queryKey, next)
    toast.success(t(done))
    if (leave) await router.push(`/documents/${documentId.value}`)
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = null
  }
}
const save = () =>
  act(
    'save',
    () =>
      api.put('/v1/documents/{id}/source/recipe', {
        ...path(),
        body: { recipe: cleanRecipe(draft.value), ...(state.value?.proposal ? { proposalId: state.value.proposal.id } : {}) },
      }),
    state.value?.proposal ? 'sources.recipe.approved' : 'sources.recipe.saved',
    true,
  )
const dismiss = () => act('dismiss', () => api.post('/v1/documents/{id}/source/recipe/dismiss', path()), 'sources.recipe.dismissed')
const redraft = () => act('draft', () => api.post('/v1/documents/{id}/source/recipe/draft', path()), 'sources.recipe.drafted')
</script>

<template>
  <PageLayout variant="list" :title="t('sources.recipe.heading')">
    <RouterLink
      :to="`/documents/${documentId}`"
      class="-mt-3 mb-5 inline-flex max-w-full items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <ArrowLeft class="size-3.5 shrink-0" aria-hidden="true" />
      <span class="truncate">{{ pageTitle || t('sources.recipe.backToPage') }}</span>
      <span v-if="source" class="shrink-0">· {{ source.host }}</span>
    </RouterLink>

    <p v-if="sourceQuery.isError.value" role="alert" class="text-sm [overflow-wrap:anywhere] text-destructive">
      {{ errorMessage(sourceQuery.error.value, t) }}
    </p>

    <template v-else-if="source && state">
      <!-- One status line: what is asked of the person, most urgent first. -->
      <div class="mb-6 flex items-start gap-2.5 text-sm" role="status">
        <span
          class="mt-[0.4rem] size-1.5 shrink-0 rounded-full"
          :class="attention === 'held' ? 'bg-panel-caution' : attention === 'changed' ? 'bg-panel-warning' : attention === 'proposal' ? 'bg-panel-important' : 'bg-panel-tip'"
          aria-hidden="true"
        />
        <div class="kn-measure min-w-0 space-y-1">
          <p v-if="attention === 'held'" class="font-medium">
            {{ t('sources.recipe.status.held', { checks: state.heldReasons.map((r) => t(`sources.recipe.check.${r}`)).join(', ') }) }}
          </p>
          <p v-else-if="attention === 'proposal'" class="font-medium">{{ t('sources.recipe.status.proposal') }}</p>
          <p v-else-if="attention === 'changed'" class="font-medium">
            {{ t('sources.recipe.status.changed', { when: relativeTime(state.structureChangedAt!) }) }}
          </p>
          <p v-else class="font-medium">
            {{ state.active ? t('sources.recipe.status.active', { n: state.active.version }) : t('sources.recipe.status.implicit') }}
          </p>
          <p v-if="state.proposal" class="flex items-start gap-1.5 text-muted-foreground">
            <Bot class="mt-0.5 size-3.5 shrink-0 text-panel-important" :aria-label="t('sources.recipe.byAgent')" />
            <span class="[overflow-wrap:anywhere]">{{ state.proposal.note || t('sources.recipe.noNote') }}</span>
          </p>
          <p v-else-if="attention === 'held'" class="text-muted-foreground">{{ t('sources.recipe.status.heldHint') }}</p>
          <p v-if="source.pausedAt" class="text-muted-foreground">{{ t('sources.recipe.paused') }}</p>
        </div>
      </div>

      <div class="grid gap-8 lg:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)]">
        <!-- The recipe -->
        <form class="min-w-0 space-y-6" novalidate @submit.prevent="save">
          <fieldset v-for="list in (['content', 'strip', 'landmarks'] as const)" :key="list" class="min-w-0 space-y-2">
            <legend class="text-sm font-medium">{{ t(`sources.recipe.${list}.label`) }}</legend>
            <p class="text-xs text-muted-foreground">{{ t(`sources.recipe.${list}.hint`) }}</p>
            <template v-if="selectorsEditable">
              <div v-for="(_, i) in draft[list]" :key="i" class="flex items-center gap-1.5">
                <Input
                  v-model="draft[list][i]"
                  spellcheck="false"
                  autocomplete="off"
                  class="h-8 min-w-0 flex-1 font-mono text-ui"
                  :aria-label="t(`sources.recipe.${list}.row`, { n: i + 1 })"
                  :placeholder="t(`sources.recipe.${list}.placeholder`)"
                />
                <span
                  v-if="draft[list][i]!.trim() && hits(draft[list][i]!) !== null"
                  class="shrink-0 text-right text-caption whitespace-nowrap tabular-nums"
                  :class="hits(draft[list][i]!) ? 'text-muted-foreground' : 'text-panel-caution-ink'"
                >{{ hits(draft[list][i]!) ? t('sources.recipe.matches', { n: hits(draft[list][i]!) }, hits(draft[list][i]!)!) : t('sources.recipe.noMatch') }}</span>
                <Button type="button" size="icon-sm" variant="ghost" :aria-label="t('sources.recipe.remove')" @click="removeAt(draft[list], i)">
                  <X class="size-3.5" />
                </Button>
              </div>
              <Button type="button" size="sm" variant="ghost" class="-ml-2" @click="addSelector(list)">
                <Plus class="size-3.5" /> {{ t('sources.recipe.addSelector') }}
              </Button>
            </template>
            <template v-else>
              <ul v-if="draft[list].length" class="space-y-1">
                <li v-for="s in draft[list]" :key="s" class="flex items-center gap-2">
                  <code class="min-w-0 truncate font-mono text-ui" :title="s">{{ s }}</code>
                  <span
                    v-if="hits(s) !== null"
                    class="shrink-0 text-caption tabular-nums"
                    :class="hits(s) ? 'text-muted-foreground' : 'text-panel-caution-ink'"
                  >{{ hits(s) ? t('sources.recipe.matches', { n: hits(s) }, hits(s)!) : t('sources.recipe.noMatch') }}</span>
                </li>
              </ul>
              <p v-else class="text-ui text-muted-foreground">{{ t(`sources.recipe.${list}.none`) }}</p>
            </template>
          </fieldset>

          <details class="group min-w-0" :open="headingCount > 0 || undefined">
            <summary
              class="flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden"
            >
              <ChevronRight class="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
              {{ t('sources.recipe.headings.label') }}
              <span v-if="headingCount" class="text-caption font-normal text-muted-foreground">· {{ t('sources.recipe.headings.count', { n: headingCount }, headingCount) }}</span>
            </summary>
            <p class="mt-2 text-xs text-muted-foreground">{{ t('sources.recipe.headings.hint') }}</p>
            <div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              <label v-for="tag in SOURCE_HEADING_TAGS" :key="tag" class="flex items-center gap-2 text-ui">
                <code class="w-6 font-mono">{{ tag }}</code>
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
          </details>

          <fieldset class="min-w-0 space-y-2">
            <legend class="text-sm font-medium">{{ t('sources.recipe.rules.label') }}</legend>
            <p class="text-xs text-muted-foreground">{{ t('sources.recipe.rules.hint') }}</p>
            <p v-if="!draft.rules.length" class="text-ui text-muted-foreground">{{ t('sources.recipe.rules.none') }}</p>
            <div v-for="(rule, i) in draft.rules" :key="i" class="space-y-1.5 rounded-lg border p-2.5">
              <div class="flex items-center gap-1.5">
                <Select :model-value="rule.kind" :disabled="!canEdit" @update:model-value="setKind(i, $event)">
                  <SelectTrigger size="sm" class="min-w-0 flex-1" :aria-label="t('sources.recipe.rules.kind', { n: i + 1 })"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="kind in SOURCE_RECIPE_RULE_KINDS" :key="kind" :value="kind">{{ t(`sources.recipe.rules.kinds.${kind}`) }}</SelectItem>
                  </SelectContent>
                </Select>
                <Button v-if="canEdit" type="button" size="icon-sm" variant="ghost" :aria-label="t('sources.recipe.remove')" @click="removeAt(draft.rules, i)">
                  <X class="size-3.5" />
                </Button>
              </div>
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
            <Button v-if="canEdit" type="button" size="sm" variant="ghost" class="-ml-2" @click="draft.rules.push(blankRule('drop-section'))">
              <Plus class="size-3.5" /> {{ t('sources.recipe.rules.add') }}
            </Button>
          </fieldset>

          <div v-if="canEdit" class="space-y-2 border-t pt-4">
            <div class="flex flex-wrap items-center gap-2">
              <Button type="submit" :disabled="!!blockedReason || busy !== null" :aria-describedby="blockedReason ? 'recipe-blocked' : undefined">
                {{ busy === 'save' ? t('sources.recipe.saving') : state.proposal ? t('sources.recipe.approve') : t('sources.recipe.save') }}
              </Button>
              <Button v-if="state.proposal || attention === 'changed'" type="button" variant="ghost" :disabled="busy !== null" @click="dismiss">
                {{ state.proposal ? t('sources.recipe.reject') : t('sources.recipe.keep') }}
              </Button>
              <Button v-if="state.hasBody" type="button" variant="ghost" :disabled="busy !== null" :aria-busy="busy === 'draft'" @click="redraft">
                <Sparkles class="size-3.5" :class="busy === 'draft' && 'motion-safe:animate-pulse'" />
                {{ busy === 'draft' ? t('sources.recipe.drafting') : state.proposal ? t('sources.recipe.redraft') : t('sources.recipe.draft') }}
              </Button>
            </div>
            <p v-if="blockedReason" id="recipe-blocked" class="text-xs [overflow-wrap:anywhere] text-muted-foreground">{{ blockedReason }}</p>
          </div>
          <p v-else class="border-t pt-4 text-xs text-muted-foreground">{{ t('sources.recipe.viewerHint') }}</p>
        </form>

        <!-- What the recipe makes of the last fetched version -->
        <section class="min-w-0 space-y-3" :aria-label="t('sources.recipe.preview')" :aria-busy="previewing">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-sm font-medium">{{ t('sources.recipe.preview') }}</h2>
            <div class="inline-flex rounded-md border p-0.5" role="group" :aria-label="t('sources.recipe.previewAs')">
              <button
                v-for="v in (['changes', 'page'] as const)"
                :key="v"
                type="button"
                class="rounded-sm px-2.5 py-1 text-ui outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                :class="view === v ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'"
                :aria-pressed="view === v"
                @click="view = v"
              >{{ t(`sources.recipe.view.${v}`) }}</button>
            </div>
          </div>

          <ul v-if="preview" class="flex flex-wrap gap-x-4 gap-y-1 text-ui">
            <li v-for="c in checks" :key="c.kind" class="flex items-center gap-1.5" :class="c.ok ? 'text-muted-foreground' : 'text-panel-caution-ink'">
              <component :is="c.ok ? Check : X" class="size-3.5 shrink-0" aria-hidden="true" />
              <span>{{ t(`sources.recipe.check.${c.kind}`) }}</span>
              <span class="sr-only">{{ c.ok ? t('sources.recipe.checkPasses') : t('sources.recipe.checkFails') }}</span>
            </li>
          </ul>

          <p v-if="!state.hasBody" class="kn-measure rounded-lg border p-4 text-sm text-muted-foreground">{{ t('sources.recipe.noBody') }}</p>
          <p v-else-if="!canEdit" class="kn-measure rounded-lg border p-4 text-sm text-muted-foreground">{{ t('sources.recipe.viewerPreview') }}</p>
          <p v-else-if="previewError" role="alert" class="rounded-lg border p-4 text-sm [overflow-wrap:anywhere] text-destructive">{{ previewError }}</p>
          <div v-else-if="!preview" class="h-48 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" aria-hidden="true" />
          <div v-else :class="previewing && 'opacity-60 transition-opacity motion-reduce:transition-none'">
            <DiffView v-if="view === 'changes' && compare" :compare="compare" />
            <div v-else-if="preview.after.trim()" class="rounded-lg border bg-card p-5">
              <MarkdownView :markdown="preview.after" />
            </div>
            <p v-else class="rounded-lg border p-4 text-sm text-muted-foreground">{{ t('sources.recipe.emptyResult') }}</p>
          </div>
        </section>
      </div>
    </template>

    <div v-else class="h-64 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" aria-hidden="true" />
  </PageLayout>
</template>
