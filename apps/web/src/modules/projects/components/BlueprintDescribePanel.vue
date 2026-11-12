<script setup lang="ts">
/**
 * Start → Describe it (#716 phase 5, #731): the person says what the project
 * is for, optionally picks a blueprint to start from, and the `scaffolder`
 * interviews them in rounds before it drafts an outline
 * (`POST /v1/blueprints/generate`). It looks facts up in the workspace's tree
 * and search under the person's own access, and asks only for decisions.
 * Nothing is written until Create. The card is hidden when `assistant` is
 * off, so this panel never opens without it.
 *
 * The interview is stateless on the server: every call carries the brief and
 * every round so far. The wizard keeps them (`interview` in its context) so a
 * reload reopens the same round and Back from Shape the finished interview.
 *
 * Shape's anatomy, full bleed: the brief and the rounds fill the main pane;
 * the starting points, then the outline and terms so far, sit in the side
 * pane with Draft now at its foot.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, ArrowRight, Check, FilePlus, Loader2, Sparkles } from 'lucide-vue-next'
import {
  BLUEPRINT_INTERVIEW_MAX_ROUNDS,
  blueprintText,
  type Blueprint,
  type BlueprintEntry,
  type BlueprintInterviewRound,
  type Locale,
} from '@knowledge/contracts'
import { api } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@knowledge/ui/button'
import { Input } from '@knowledge/ui/input'
import { Textarea } from '@knowledge/ui/textarea'
import { PromptFields, submitOnEnter, type PromptValues } from '@/entities/assistant'
import BlueprintTreePreview from '@/modules/projects/components/BlueprintTreePreview.vue'
import { cloneJson, countPages } from '@/modules/projects/model/blueprint-tree'
import {
  answersOf,
  answerText,
  freshInterview,
  roundComplete,
  seedOf,
  withTerms,
  type DescribeInterview,
} from '@/modules/projects/model/interview'
import type { ScaffoldOrigin } from '@/modules/projects/model/scaffold-machine'

const props = defineProps<{
  entries: BlueprintEntry[]
  locale: Locale
  canEdit: boolean
  /** The interview so far, from the wizard's context. */
  initial?: DescribeInterview | null
  /** A snapshot saved before #731 has the brief only. */
  initialBrief?: string
}>()
const emit = defineEmits<{
  back: []
  pick: [blueprint: Blueprint, origin: ScaffoldOrigin]
  /** The interview after each reply, for the wizard to keep. */
  update: [interview: DescribeInterview]
}>()

const { t } = useI18n()

/** The server's bounds (`GenerateBlueprintDto`). */
const BRIEF_MIN = 10
const BRIEF_MAX = 4000
const TIPS = ['covers', 'readers', 'grows', 'exists'] as const

const state = ref<DescribeInterview>(props.initial ? cloneJson(props.initial) : freshInterview(props.initialBrief))
function commit(patch: Partial<DescribeInterview>) {
  state.value = { ...state.value, ...patch }
  emit('update', cloneJson(state.value))
}

const brief = ref(state.value.brief)
/** A listed blueprint's key to adapt, or '' for nothing. */
const startKey = ref(state.value.startKey)
const starts = computed(() => props.entries.filter((e) => e.blueprint.tree.length))
const start = computed(() => starts.value.find((e) => e.key === startKey.value) ?? null)

/**
 * What is reopened with Change: -1 the brief, k round k. Every round after it
 * shows as dropped until the reopened one is sent; Cancel puts them back.
 */
const reopen = ref<number | null>(null)
const pending = ref<'asking' | 'drafting' | null>(null)
const failure = ref<{ message: string; drafting: boolean; retry: () => void } | null>(null)

const rounds = computed(() => state.value.rounds)
/** The brief is the form while nothing has been asked, or while it is reopened. */
const briefOpen = computed(() => reopen.value === -1 || (!rounds.value.length && reopen.value === null))
/** The round with live controls: the reopened one, else the last one, while unanswered. */
const openIndex = computed(() => {
  if (reopen.value !== null) return reopen.value
  const last = rounds.value.length - 1
  return last >= 0 && !rounds.value[last]!.answers ? last : -1
})
const openRound = computed(() => (openIndex.value >= 0 ? rounds.value[openIndex.value]! : null))
const dropped = (i: number) => reopen.value !== null && i > reopen.value
/** The rounds the next call would carry as answered: those before whatever is open. */
const answered = computed(() => {
  const upTo = reopen.value ?? (openIndex.value >= 0 ? openIndex.value : rounds.value.length)
  return rounds.value.slice(0, Math.max(upTo, 0)).filter((r) => r.answers)
})
/** Rounds have been asked and none is open: the interview drafted, or a reply never came. */
const settled = computed(() => !briefOpen.value && !openRound.value && !pending.value)

const values = ref<PromptValues>({})
const others = ref<Record<string, string>>({})
watch(
  openRound,
  (round) => {
    const seed = round ? seedOf(round) : { values: {}, others: {} }
    values.value = seed.values
    others.value = seed.others
  },
  { immediate: true },
)

const briefReady = computed(() => props.canEdit && brief.value.trim().length >= BRIEF_MIN && !pending.value)
const roundReady = computed(
  () => !!openRound.value && props.canEdit && !pending.value && roundComplete(openRound.value.questions, values.value, others.value),
)

const briefField = ref<InstanceType<typeof Textarea> | null>(null)
const roundEl = ref<HTMLElement | null>(null)
const setRoundEl = (el: unknown) => (roundEl.value = el as HTMLElement | null)
const focusBrief = () => void nextTick(() => (briefField.value?.$el as HTMLTextAreaElement | undefined)?.focus())
/** A new round takes focus on its first suggestion, so a run of suggestions is a run of Enter presses. */
function focusRound() {
  void nextTick(() => {
    const el = roundEl.value?.querySelector<HTMLElement>('input:checked') ?? roundEl.value?.querySelector<HTMLElement>('input, textarea')
    el?.focus({ preventScroll: true })
    roundEl.value?.scrollIntoView({ block: 'nearest' })
  })
}
onMounted(() => (briefOpen.value ? focusBrief() : focusRound()))

// Back while a call is out leaves the panel: a late reply must not pull the wizard into Shape.
let left = false
onBeforeUnmount(() => (left = true))

/**
 * One call. `rounds: null` is the one-shot draft from the brief alone. An
 * asking call keeps the brief and the answers before it goes out, so a reload
 * while it runs still has them (and offers Continue); a draft changes nothing
 * until it lands.
 */
async function call(next: BlueprintInterviewRound[] | null, draft: boolean) {
  const text = brief.value.trim()
  const run = () => void call(next, draft)
  pending.value = draft ? 'drafting' : 'asking'
  failure.value = null
  if (!draft) {
    commit({ brief: text, startKey: startKey.value, rounds: next ?? [], drafted: false })
    reopen.value = null
  }
  try {
    const res = await api.post('/v1/blueprints/generate', {
      body: {
        workspaceId: getWorkspaceId(),
        brief: text,
        // The DTO cannot name the contracts types; the server parses both with its own readers.
        ...(start.value ? { blueprint: cloneJson(start.value.blueprint) as unknown as Record<string, unknown> } : {}),
        ...(next ? { rounds: cloneJson(next) as unknown as Record<string, unknown>[], ...(draft ? { draft: true } : {}) } : {}),
      },
    })
    if (left) return
    if (res.status === 'asking') {
      commit({ rounds: [...(next ?? []), res.round], outline: res.outline, terms: res.terms })
      focusRound()
      return
    }
    commit({ brief: text, startKey: startKey.value, rounds: next ?? [], drafted: true })
    reopen.value = null
    emit('pick', withTerms(res.blueprint, res.glossary), { kind: 'described', brief: text })
  } catch (e) {
    if (!left) failure.value = { message: errorMessage(e, t), drafting: draft, retry: run }
  } finally {
    pending.value = null
  }
}

/** The brief, sent or re-sent: the interview starts over from it. */
function ask() {
  if (briefReady.value) void call([], false)
}

function answer() {
  const round = openRound.value
  if (!roundReady.value || !round) return
  const sent = { questions: round.questions, answers: answersOf(round.questions, values.value, others.value) }
  void call([...rounds.value.slice(0, openIndex.value), sent], false)
}

function draftNow() {
  if (pending.value || !props.canEdit || brief.value.trim().length < BRIEF_MIN) return
  // From the brief alone this is the one-shot draft (#716).
  const sent = reopen.value === -1 ? [] : answered.value
  void call(sent.length ? sent : null, true)
}

function change(at: number) {
  reopen.value = at
  failure.value = null
  if (at === -1) focusBrief()
  else focusRound()
}

function cancelChange() {
  reopen.value = null
  brief.value = state.value.brief
  startKey.value = state.value.startKey
}

function onBriefKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    ask()
  }
}

const questionText = (q: BlueprintInterviewRound['questions'][number], round: BlueprintInterviewRound) =>
  answerText(q, round.answers?.[q.name], t('chat.flowSkipped'))
</script>

<template>
  <div
    class="grid h-full min-h-0 content-start overflow-y-auto lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:content-stretch lg:overflow-hidden"
    :aria-busy="!!pending || undefined"
  >
    <!-- The interview: the main pane. -->
    <!-- min-h-0 only side by side: stacked, each pane keeps its full height and the whole step scrolls. -->
    <section class="flex flex-col gap-4 px-4 py-4 lg:min-h-0 lg:overflow-y-auto lg:px-6">
      <div class="space-y-1">
        <Button variant="ghost" size="sm" class="text-muted-foreground -ml-2 gap-1.5" @click="emit('back')">
          <ArrowLeft class="size-4" /> {{ t('scaffold.derive.back') }}
        </Button>
        <h2 class="text-lg font-semibold">{{ t('scaffold.describe.title') }}</h2>
        <p class="kn-measure text-muted-foreground text-sm leading-relaxed">{{ t('scaffold.describe.body') }}</p>
      </div>

      <!-- The brief, as a form: nothing asked yet, or reopened. -->
      <form v-if="briefOpen" class="flex flex-col gap-4" :class="rounds.length ? '' : 'lg:min-h-0 lg:flex-1'" @submit.prevent="ask">
        <label class="flex min-h-0 flex-1 flex-col gap-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('scaffold.describe.label') }}</span>
          <Textarea
            ref="briefField"
            v-model="brief"
            class="kn-brief min-h-40 flex-1 resize-none text-sm leading-relaxed"
            :maxlength="BRIEF_MAX"
            :placeholder="t('scaffold.describe.placeholder')"
            :disabled="!!pending || !canEdit"
            :aria-invalid="!!failure || undefined"
            aria-describedby="kn-describe-hint"
            @keydown="onBriefKey"
          />
        </label>
        <p id="kn-describe-hint" class="text-muted-foreground kn-measure text-caption leading-snug">{{ t('scaffold.describe.hint') }}</p>

        <div class="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center">
          <p class="text-muted-foreground text-caption sm:mr-auto" aria-live="polite">
            <template v-if="pending">{{ t(`scaffold.describe.${pending}`) }}</template>
            <span v-else class="max-sm:hidden">{{ t('scaffold.describe.shortcut') }}</span>
          </p>
          <Button v-if="reopen === -1" type="button" variant="ghost" :disabled="!!pending" @click="cancelChange">
            {{ t('common.cancel') }}
          </Button>
          <Button type="submit" class="gap-1.5" :disabled="!briefReady">
            <Loader2 v-if="pending === 'asking'" class="size-4 animate-spin" />
            <ArrowRight v-else class="size-4" />
            {{ t('scaffold.describe.submit') }}
          </Button>
        </div>
      </form>

      <!-- The brief, sent. -->
      <div v-else class="kn-said kn-measure">
        <div class="flex items-baseline gap-2">
          <h3 class="text-muted-foreground text-xs font-medium">{{ t('scaffold.describe.briefLabel') }}</h3>
          <Button v-if="!pending && canEdit" variant="ghost" size="sm" class="ml-auto h-7" @click="change(-1)">
            {{ t('chat.flowChange') }}
          </Button>
        </div>
        <p class="kn-measure text-ui leading-relaxed whitespace-pre-line line-clamp-6">{{ state.brief }}</p>
      </div>

      <!-- Answered rounds, one line per question. -->
      <ol v-if="rounds.length" class="space-y-3" :aria-label="t('scaffold.describe.roundsLabel')">
        <template v-for="(round, i) in rounds" :key="i">
          <li v-if="i !== openIndex && round.answers" class="kn-said kn-measure" :class="dropped(i) || reopen === -1 ? 'kn-dropped' : ''">
            <div class="flex items-baseline gap-2">
              <h3 class="text-muted-foreground text-xs font-medium">{{ t('scaffold.describe.roundDone', { n: i + 1 }) }}</h3>
              <span v-if="dropped(i) || reopen === -1" class="text-muted-foreground text-xs font-medium">{{ t('chat.flowDropped') }}</span>
              <Button v-else-if="!pending && canEdit" variant="ghost" size="sm" class="ml-auto h-7" @click="change(i)">
                {{ t('chat.flowChange') }}
              </Button>
            </div>
            <ul class="space-y-1">
              <li v-for="q in round.questions" :key="q.name" class="kn-measure text-ui leading-snug">
                <span class="kn-q text-muted-foreground">{{ q.label }}</span>
                <span class="text-muted-foreground" aria-hidden="true"> — </span>
                <span class="kn-a font-medium">{{ questionText(q, round) }}</span>
              </li>
            </ul>
          </li>
          <!-- The open round in its place, so a reopened round sits above the ones it drops. -->
          <li v-else-if="i === openIndex && openRound && !pending">
            <!-- Tinted, like the chat's questions, so it reads as the thing to act on. -->
            <form
              :ref="setRoundEl"
              class="kn-measure space-y-4 rounded-xl border border-primary/25 bg-primary/[0.04] p-4"
              :aria-label="t('scaffold.describe.round', { n: openIndex + 1, max: BLUEPRINT_INTERVIEW_MAX_ROUNDS })"
              @submit.prevent="answer"
              @keydown.enter="(e: KeyboardEvent) => submitOnEnter(e, answer)"
            >
              <div v-for="q in openRound.questions" :key="q.name" class="space-y-2">
                <p class="text-sm leading-relaxed font-medium">{{ q.label }}</p>
                <PromptFields v-model:values="values" :fields="[q]" :question="q.label" :disabled="!canEdit" />
                <!-- The escape hatch: the options are the scaffolder's guess at the answer, and it may be wrong. -->
                <Input
                  v-if="q.type !== 'text'"
                  v-model="others[q.name]"
                  :placeholder="t('chat.answerInOwnWords')"
                  :aria-label="`${q.label} — ${t('chat.somethingElse')}`"
                  :disabled="!canEdit"
                  class="h-9 text-ui"
                  @keydown.esc.stop="others[q.name] = ''"
                />
              </div>

              <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <Button type="submit" size="sm" class="gap-1.5" :disabled="!roundReady">
                  {{ t('scaffold.describe.continue') }}
                  <ArrowRight class="size-3.5" />
                </Button>
                <Button v-if="reopen !== null" type="button" variant="ghost" size="sm" @click="cancelChange">
                  {{ t('common.cancel') }}
                </Button>
                <p v-if="canEdit && !roundReady" class="text-muted-foreground text-caption">{{ t('scaffold.describe.answerEach') }}</p>
                <p class="text-muted-foreground ml-auto text-xs font-medium whitespace-nowrap tabular-nums">
                  {{ t('scaffold.describe.round', { n: openIndex + 1, max: BLUEPRINT_INTERVIEW_MAX_ROUNDS }) }}
                </p>
              </div>
            </form>
          </li>
        </template>
      </ol>

      <!-- Where the next round will appear. -->
      <p v-if="pending && !briefOpen" class="text-muted-foreground inline-flex items-center gap-2 text-ui" aria-live="polite">
        <Loader2 class="size-4 animate-spin" aria-hidden="true" />
        {{ t(`scaffold.describe.${pending}`) }}
      </p>

      <div v-if="failure" role="alert" class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p class="text-destructive text-sm">{{ t(failure.drafting ? 'scaffold.describe.failed' : 'scaffold.describe.askFailed') }} {{ failure.message }}</p>
        <Button variant="outline" size="sm" @click="failure.retry()">{{ t('common.retry') }}</Button>
      </div>

      <!-- Every round answered and no reply open: drafted already, or a reply that never came. -->
      <div v-else-if="settled" class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p v-if="state.drafted" class="text-muted-foreground inline-flex items-center gap-1.5 text-ui">
          <Check class="text-panel-tip size-3.5" aria-hidden="true" />
          {{ t('scaffold.describe.drafted') }}
        </p>
        <Button v-else size="sm" class="gap-1.5" :disabled="!canEdit" @click="call(rounds, false)">
          {{ t('scaffold.describe.resume') }}
          <ArrowRight class="size-3.5" />
        </Button>
      </div>
    </section>

    <!-- Where it starts from, then what the answers have shaped so far. -->
    <aside class="flex flex-col border-t lg:min-h-0 lg:border-t-0 lg:border-l">
      <div class="flex-1 lg:min-h-0 lg:overflow-y-auto">
        <template v-if="briefOpen">
          <fieldset :disabled="!!pending || !canEdit">
            <legend class="text-muted-foreground px-4 pt-4 pb-2 text-xs font-medium lg:px-6">{{ t('scaffold.describe.startFrom') }}</legend>
            <div class="divide-y border-y">
              <label class="kn-start-row">
                <input v-model="startKey" type="radio" name="kn-describe-start" value="" class="sr-only" />
                <span class="kn-start-icon"><FilePlus class="size-4" /></span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium">{{ t('scaffold.describe.nothing') }}</span>
                  <span class="text-muted-foreground block truncate text-caption">{{ t('scaffold.describe.nothingMeta') }}</span>
                </span>
                <Check v-if="!startKey" class="text-primary size-4 shrink-0" aria-hidden="true" />
              </label>
              <label v-for="entry in starts" :key="entry.key" class="kn-start-row">
                <input v-model="startKey" type="radio" name="kn-describe-start" :value="entry.key" class="sr-only" />
                <span class="kn-start-icon" aria-hidden="true">{{ entry.blueprint.icon ?? '' }}</span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium">{{ blueprintText(entry.blueprint.name, locale) }}</span>
                  <span class="text-muted-foreground block truncate text-caption tabular-nums">
                    {{ t('scaffold.start.pages', { count: countPages(entry.blueprint.tree) }, countPages(entry.blueprint.tree)) }}
                  </span>
                </span>
                <Check v-if="startKey === entry.key" class="text-primary size-4 shrink-0" aria-hidden="true" />
              </label>
            </div>
          </fieldset>

          <section class="px-4 py-4 lg:px-6" aria-live="polite">
            <template v-if="start">
              <h3 class="text-muted-foreground mb-2 text-xs font-medium">{{ t('scaffold.describe.adapts') }}</h3>
              <BlueprintTreePreview :tree="start.blueprint.tree" :locale="locale" :max="30" />
            </template>
            <template v-else>
              <h3 class="text-muted-foreground mb-2 text-xs font-medium">{{ t('scaffold.describe.tipsTitle') }}</h3>
              <ul class="text-muted-foreground space-y-2 text-ui leading-snug">
                <li v-for="tip in TIPS" :key="tip" class="flex gap-2">
                  <span class="bg-border mt-[0.45em] size-1.5 shrink-0 rounded-full" aria-hidden="true" />
                  {{ t(`scaffold.describe.tips.${tip}`) }}
                </li>
              </ul>
            </template>
          </section>
        </template>

        <template v-else>
          <p v-if="start" class="text-muted-foreground border-b px-4 py-3 text-caption lg:px-6">
            {{ t('scaffold.describe.startingFrom', { name: blueprintText(start.blueprint.name, locale) }) }}
          </p>
          <section class="space-y-2 px-4 py-4 lg:px-6" aria-live="polite">
            <h3 class="text-muted-foreground text-xs font-medium">{{ t('scaffold.describe.outline') }}</h3>
            <BlueprintTreePreview v-if="state.outline.length" :tree="state.outline" :locale="locale" :max="40" />
            <p v-else class="text-muted-foreground text-ui">{{ t('scaffold.describe.outlineEmpty') }}</p>
          </section>
          <section v-if="state.terms.length" class="space-y-2 border-t px-4 py-4 lg:px-6">
            <h3 class="text-muted-foreground text-xs font-medium">{{ t('scaffold.describe.terms') }}</h3>
            <dl class="space-y-1.5">
              <div v-for="term in state.terms" :key="term.term" class="text-ui leading-snug">
                <dt class="inline font-medium">{{ term.term }}</dt>
                <span class="text-muted-foreground" aria-hidden="true"> — </span>
                <dd class="text-muted-foreground inline">{{ term.definition }}</dd>
              </div>
            </dl>
          </section>
        </template>
      </div>

      <!-- Draft now ends the interview at any point; from the brief alone it is the one-shot draft. -->
      <div class="space-y-1.5 border-t px-4 py-3 lg:px-6">
        <Button
          variant="outline"
          class="w-full gap-1.5"
          :disabled="!!pending || !canEdit || brief.trim().length < BRIEF_MIN"
          @click="draftNow"
        >
          <Loader2 v-if="pending === 'drafting'" class="size-4 animate-spin" />
          <Sparkles v-else class="size-4" />
          {{ t(state.drafted ? 'scaffold.describe.draftAgain' : 'scaffold.describe.draftNow') }}
        </Button>
        <p class="text-muted-foreground text-caption leading-snug">
          {{ t(rounds.length && reopen !== -1 ? 'scaffold.describe.draftNowNote' : 'scaffold.describe.draftNowBrief') }}
        </p>
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* The shared Textarea grows with its content; here it fills the pane instead. */
.kn-brief {
  field-sizing: fixed;
}
/* What has been said: the brief and answered rounds, quiet so the open round leads. */
.kn-said {
  display: grid;
  gap: 0.375rem;
  border-radius: 0.75rem;
  border: 1px solid var(--border);
  padding: 0.5rem 0.75rem 0.75rem 0.875rem;
}
.kn-dropped .kn-q,
.kn-dropped .kn-a {
  text-decoration: line-through;
  color: var(--muted-foreground);
}
.kn-start-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 1rem;
  cursor: pointer;
  transition: background-color 120ms;
}
@media (min-width: 64rem) {
  .kn-start-row {
    padding-inline: 1.5rem;
  }
}
.kn-start-row:hover {
  background: var(--accent);
}
.kn-start-row:has(:checked) {
  background: color-mix(in oklab, var(--primary) 8%, transparent);
}
.kn-start-row:has(:focus-visible) {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
fieldset:disabled .kn-start-row {
  cursor: not-allowed;
  opacity: 0.55;
}
.kn-start-icon {
  display: grid;
  width: 2rem;
  height: 2rem;
  flex-shrink: 0;
  place-items: center;
  border-radius: 0.5rem;
  background: var(--muted);
  color: var(--muted-foreground);
  font-size: 1rem;
}
@media (prefers-reduced-motion: reduce) {
  .kn-start-row {
    transition-duration: 0.01ms;
  }
}
</style>
