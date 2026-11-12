<script setup lang="ts">
/**
 * /setup/purpose (#934): asks a workspace's admin what it is for, once, and
 * shows which sections that switches on and off before anything is saved.
 * The router sends the admin of a never-asked workspace here; Settings →
 * Features opens it again as "Ask me instead". Nothing is written until
 * Confirm (or, on the first visit, Skip — which only records that the
 * question was put).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-vue-next'
import { createActor } from 'xstate'
import { PURPOSE_INTERVIEW_MAX_ROUNDS, type WorkspaceUse } from '@knowledge/contracts'
import { Button } from '@knowledge/ui/button'
import { Input } from '@knowledge/ui/input'
import { PageLayout } from '@knowledge/ui/layout'
import { Textarea } from '@knowledge/ui/textarea'
import { PromptFields, answersOf, answerText, roundComplete, seedOf, submitOnEnter, type PromptValues } from '@/entities/assistant'
import { errorMessage } from '@/shared/api/errors'
import { ownPath } from '@/shared/utils/own-path'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'
import FeatureSections from '../components/FeatureSections.vue'
import PurposeUses from '../components/PurposeUses.vue'
import { usePurposeDraft } from '../model/purpose-draft'
import { purposeMachine, type PurposeContext, type PurposeEvent, type PurposeStep } from '../model/purpose-machine'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const features = useFeaturesStore()
const draft = usePurposeDraft()

/** Asked before: this is a re-run from Settings, so leaving writes nothing. */
const rerun = features.purposeAsked
const next = computed(() => ownPath(route.query.next, rerun ? '/settings/features' : '/documents'))

const actor = createActor(purposeMachine)
const snapshot = shallowRef(actor.getSnapshot())
const step = computed(() => snapshot.value.value as PurposeStep)
const context = computed<PurposeContext>(() => snapshot.value.context)
const send = (event: PurposeEvent) => actor.send(event)
actor.subscribe((snap) => (snapshot.value = snap))

const description = ref('')
onMounted(async () => {
  actor.start()
  // A re-run starts from the words already stored, so Confirm does not erase them.
  if (rerun && auth.canAdminWorkspace) description.value = (await features.loadPurpose().catch(() => null))?.description ?? ''
})
onBeforeUnmount(() => actor.stop())

/* ---------------------------------------------------------------- the rounds */

const answered = computed(() => context.value.rounds.filter((r) => r.answers))
const openRound = computed(() => (step.value === 'round' ? (context.value.rounds.at(-1) ?? null) : null))
const values = ref<PromptValues>({})
const others = ref<Record<string, string>>({})
const roundEl = ref<HTMLElement | null>(null)
watch(openRound, (round) => {
  const seed = round ? seedOf(round) : { values: {}, others: {} }
  values.value = seed.values
  others.value = seed.others
  // A run of suggestions is a run of Enter presses.
  if (round) void nextTick(() => roundEl.value?.querySelector<HTMLElement>('input:checked, input, textarea')?.focus({ preventScroll: true }))
})
const roundReady = computed(() => !!openRound.value && roundComplete(openRound.value.questions, values.value, others.value))
function answer() {
  if (openRound.value && roundReady.value) send({ type: 'ANSWER', answers: answersOf(openRound.value.questions, values.value, others.value) })
}

/* ---------------------------------------------------------------- the review */

const reasons = computed(() => Object.fromEntries(context.value.picks.map((p) => [p.use, p.reason])) as Partial<Record<WorkspaceUse, string>>)
const heading = ref<HTMLElement | null>(null)
watch(step, (now) => {
  if (now === 'review') {
    // The interview's picks join what is already stored; the admin unticks what is wrong.
    draft.reset()
    draft.uses.value = [...new Set([...draft.uses.value, ...context.value.picks.map((p) => p.use)])]
  }
  // Each step replaces the last: move focus to its heading so a screen reader hears where it is.
  if (now !== 'asking') void nextTick(() => heading.value?.focus({ preventScroll: true }))
})

const saving = ref<'confirm' | 'skip' | null>(null)
async function leave(how: 'confirm' | 'skip') {
  if (saving.value) return
  saving.value = how
  try {
    if (how === 'confirm') {
      await features.savePurpose({ uses: draft.uses.value, description: description.value.trim() || null, disabled: draft.off.value })
    } else if (!rerun) {
      // Skip on the first visit: the question was put, every section stays as it is.
      await features.savePurpose({ uses: [], description: null, disabled: features.disabled })
    }
    // The store already says "asked", so the guard lets this through.
    await router.replace(next.value)
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = null
  }
}
</script>

<template>
  <PageLayout variant="prose">
    <p v-if="!auth.canAdminWorkspace" class="text-sm text-muted-foreground">{{ t('features.adminOnly') }}</p>

    <div v-else class="flex flex-col gap-6" :aria-busy="step === 'asking' || undefined">
      <header class="space-y-1">
        <h1 ref="heading" tabindex="-1" class="font-display text-2xl font-bold tracking-tight outline-none">
          {{ step === 'review' ? t('purposeSetup.reviewTitle') : t('purposeSetup.title') }}
        </h1>
        <p class="kn-measure text-sm text-muted-foreground">
          {{ step === 'review' ? t('purposeSetup.reviewBody') : t('purposeSetup.body') }}
        </p>
      </header>

      <!-- 1. In their own words. Optional: the interview can start from nothing. -->
      <form v-if="step === 'describe'" class="flex max-w-2xl flex-col gap-4" @submit.prevent="send({ type: 'START', description })">
        <div class="space-y-1.5">
          <label for="purpose-words" class="text-sm font-medium">{{ t('purposeSetup.describeLabel') }}</label>
          <Textarea
            id="purpose-words"
            v-model="description"
            class="min-h-28"
            maxlength="2000"
            :placeholder="t('features.purpose.descriptionPlaceholder')"
            aria-describedby="purpose-words-hint"
          />
          <p id="purpose-words-hint" class="kn-measure text-xs text-muted-foreground">{{ t('purposeSetup.describeHint') }}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" class="gap-1.5">{{ t('purposeSetup.start') }} <ArrowRight class="size-3.5" /></Button>
          <Button type="button" variant="outline" size="sm" @click="send({ type: 'CHECKLIST', description })">
            {{ t('purposeSetup.chooseMyself') }}
          </Button>
        </div>
      </form>

      <!-- 2. The interview: what was said, then the open round. -->
      <template v-else-if="step !== 'review'">
        <ul v-if="context.description || answered.length" class="kn-measure space-y-1 border-l pl-3 text-sm leading-snug">
          <li v-if="context.description" class="line-clamp-3 whitespace-pre-line">{{ context.description }}</li>
          <template v-for="(round, i) in answered" :key="i">
            <li v-for="q in round.questions" :key="q.name">
              <span class="text-muted-foreground">{{ q.label }}</span>
              <span class="text-muted-foreground" aria-hidden="true"> — </span>
              <span class="font-medium">{{ answerText(q, round.answers?.[q.name], t('chat.flowSkipped')) }}</span>
            </li>
          </template>
        </ul>

        <p v-if="step === 'asking'" class="inline-flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {{ t(context.finish ? 'purposeSetup.picking' : 'purposeSetup.thinking') }}
        </p>

        <form
          v-else-if="openRound"
          ref="roundEl"
          class="kn-measure space-y-4 rounded-xl border border-primary/25 bg-primary/[0.04] p-4"
          :aria-label="t('scaffold.describe.round', { n: context.rounds.length, max: PURPOSE_INTERVIEW_MAX_ROUNDS })"
          @submit.prevent="answer"
          @keydown.enter="(e: KeyboardEvent) => submitOnEnter(e, answer)"
        >
          <div v-for="q in openRound.questions" :key="q.name" class="space-y-2">
            <p class="text-sm leading-relaxed font-medium">{{ q.label }}</p>
            <PromptFields v-model:values="values" :fields="[q]" :question="q.label" />
            <!-- The escape hatch: the options are the model's guess at the answer, and it may be wrong. -->
            <Input
              v-if="q.type !== 'text'"
              v-model="others[q.name]"
              :placeholder="t('chat.answerInOwnWords')"
              :aria-label="`${q.label} — ${t('chat.somethingElse')}`"
              class="h-9 text-ui"
            />
          </div>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <Button type="submit" size="sm" class="gap-1.5" :disabled="!roundReady">
              {{ t('scaffold.describe.continue') }} <ArrowRight class="size-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="sm" @click="send({ type: 'FINISH' })">{{ t('purposeSetup.pickNow') }}</Button>
            <p class="ml-auto text-xs font-medium whitespace-nowrap text-muted-foreground tabular-nums">
              {{ t('scaffold.describe.round', { n: context.rounds.length, max: PURPOSE_INTERVIEW_MAX_ROUNDS }) }}
            </p>
          </div>
        </form>
      </template>

      <!-- 3. What it is for, and what that does to the sections. -->
      <form v-else class="flex max-w-2xl flex-col gap-6" @submit.prevent="leave('confirm')">
        <p v-if="context.fallback" role="status" class="kn-measure text-sm text-muted-foreground">
          {{ t(`purposeSetup.fallback.${context.fallback}`) }}
        </p>
        <p v-else-if="!context.picks.length && context.rounds.length" role="status" class="kn-measure text-sm text-muted-foreground">
          {{ t('purposeSetup.nothingPicked') }}
        </p>
        <section class="space-y-2" aria-labelledby="setup-uses">
          <h2 id="setup-uses" class="text-base font-semibold">{{ t('features.purpose.title') }}</h2>
          <PurposeUses v-model="draft.uses.value" :reasons="reasons" />
        </section>
        <section class="space-y-2" aria-labelledby="setup-sections">
          <h2 id="setup-sections" class="text-base font-semibold">{{ t('features.sectionsTitle') }}</h2>
          <p class="kn-measure text-sm text-muted-foreground">
            {{ t(draft.uses.value.length ? 'purposeSetup.sectionsBody' : 'purposeSetup.sectionsNoUse') }}
          </p>
          <FeatureSections :off="draft.off.value" :suggested="draft.suggested.value" @toggle="draft.toggle" />
        </section>
        <div class="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" :disabled="!!saving">
            <Loader2 v-if="saving === 'confirm'" class="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {{ t('purposeSetup.confirm') }}
          </Button>
        </div>
      </form>

      <!-- Leaving is always on offer; on the first visit it records that the question was put. -->
      <footer class="flex max-w-2xl flex-wrap items-center gap-2 border-t pt-4">
        <Button v-if="step !== 'describe'" type="button" variant="ghost" size="sm" class="gap-1.5" :disabled="!!saving" @click="send({ type: 'BACK' })">
          <ArrowLeft class="size-3.5" /> {{ t('purposeSetup.startOver') }}
        </Button>
        <Button type="button" variant="ghost" size="sm" class="ml-auto" :disabled="!!saving" @click="leave('skip')">
          {{ rerun ? t('common.cancel') : t('purposeSetup.skip') }}
        </Button>
        <p v-if="!rerun" class="w-full text-right text-xs text-muted-foreground">{{ t('purposeSetup.skipNote') }}</p>
      </footer>
    </div>
  </PageLayout>
</template>
