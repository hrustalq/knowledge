<script setup lang="ts">
// The assistant asking the user something, rendered as controls rather than
// as a paragraph of options to answer in prose.
//
// Two shapes. A form collects an answer and sends it as the next turn — one
// click where the alternative is retyping "the second one, and also the
// third". A mode-switch hands over the toggle the assistant needs rather than
// telling the user to go and find it.
//
// A prompt is live only while it is the newest thing in the thread. Once it
// has been answered the controls go quiet: still readable as the record of a
// question, no longer inviting a second answer to one already settled — and
// showing what was picked, which is the part anyone scrolling back is looking
// for. Nothing persists that selection: `compose()` writes it into a user
// message and the message is all that survives, so the answered state is read
// back out of that message (see `parseAnswer`). Local state would not do it —
// the transcript is virtualized, so a prompt scrolled out of view and back is
// a fresh instance, as is every prompt after a reload.
//
// A step of a question flow (#425) is the exception that does not parse: its
// answer is stored structured on the user message, so `flowStep` carries the
// value itself. An answered step collapses to one line, so a three-question
// flow does not stack three cards, and the step answered just before the open
// question can be reopened with "Change".
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ArrowRight, Check, Sparkles, Wand2 } from 'lucide-vue-next'
import type { AssistantFlowAnswer, AssistantPrompt, AssistantPromptField } from '@knowledge/contracts'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import type { FlowStep } from '@/modules/assistant/model/flow-steps'

const { t } = useI18n()

const props = defineProps<{
  prompt: AssistantPrompt
  /** False for a prompt further up the thread, or while a turn is in flight. */
  active: boolean
  /** The user turn this prompt was answered with, when it has been answered. */
  answer?: string
  /** Set when the prompt is one step of a question flow. */
  flowStep?: FlowStep
}>()

const emit = defineEmits<{
  /** The composed answer, to send as the next user turn — structured too, for a flow step. */
  answer: [text: string, answer?: AssistantFlowAnswer]
  /** Accepted the switch to Agent mode, with the intent to re-send. */
  switchMode: [string]
}>()

const form = computed(() => (props.prompt.kind === 'form' ? props.prompt : null))

// One bag of answers keyed by field name: a string for choice/text, an array
// for checklist. Kept untyped-ish on purpose — the field list is model-authored
// and the template narrows per field type anyway. The recommended option starts
// selected, so confirming the suggestion is one Enter.
function blank(suggest = true): Record<string, string | string[]> {
  return Object.fromEntries(
    (form.value?.fields ?? []).map((f) => {
      if (f.type === 'text') return [f.name, '']
      const picks = suggest ? f.options.filter((o) => o.recommended).map((o) => o.value) : []
      return [f.name, f.type === 'checklist' ? picks : (picks[0] ?? '')]
    }),
  )
}
const values = ref(blank())
const other = ref('')
const submitted = ref(false)
/** Reopened with "Change": live again although a newer question is open. */
const changing = ref(false)
const live = computed(() => props.active || changing.value)
const rootEl = ref<HTMLElement | null>(null)

function toggle(field: AssistantPromptField, value: string) {
  const current = values.value[field.name]
  if (!Array.isArray(current)) return
  const at = current.indexOf(value)
  if (at >= 0) current.splice(at, 1)
  else current.push(value)
}

function isChecked(field: AssistantPromptField, value: string): boolean {
  const current = values.value[field.name]
  return Array.isArray(current) ? current.includes(value) : current === value
}

/** A required field is answered when it has something in it. */
const complete = computed(() => {
  const f = form.value
  if (!f) return true
  return f.fields.every((field) => {
    if (!field.required) return true
    const v = values.value[field.name]
    return Array.isArray(v) ? v.length > 0 : String(v ?? '').trim().length > 0
  })
})

function labelFor(field: AssistantPromptField, value: string): string {
  if (field.type === 'text') return value
  return field.options.find((o) => o.value === value)?.label ?? value
}

/**
 * Finds which of `needles` occur in `body`, in the order they occur there.
 *
 * Longest first, blanking each match out in place as it is found — an option
 * label is model-authored and may well contain a comma, so splitting the line
 * on one would shred it. Blanking with spaces of equal length keeps every
 * later position true, which is what lets the result be sorted back into the
 * order the answer was written in.
 */
function occurrences(needles: { match: string; value: string }[], body: string): string[] {
  let rest = body.toLowerCase()
  const found: { value: string; at: number }[] = []
  for (const n of [...needles].sort((a, b) => b.match.length - a.match.length)) {
    const at = rest.indexOf(n.match.toLowerCase())
    if (at < 0) continue
    found.push({ value: n.value, at })
    rest = rest.slice(0, at) + ' '.repeat(n.match.length) + rest.slice(at + n.match.length)
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.value)
}

/**
 * Reads a sent answer back into the form, so an answered prompt shows what was
 * chosen instead of an empty one.
 *
 * `compose()` below is the only thing that writes these messages, so this
 * reads its exact shape: one `Label: A, B` line per answered field. Labels
 * are matched first because that is what is written; raw option values are
 * tried only when no label matched at all, which is how answers sent before
 * single choices carried their label still resolve. Nothing loose is guessed
 * at — a line belonging to no field stays free text, which is also the case
 * when the user ignored the controls and simply typed a reply.
 */
function parseAnswer(text: string): { values: Record<string, string | string[]>; other: string } {
  const fields = form.value?.fields ?? []
  const values: Record<string, string | string[]> = {}
  const leftovers: string[] = []

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const field = fields.find((f) => line.toLowerCase().startsWith(`${f.label.toLowerCase()}:`))
    if (!field) {
      leftovers.push(line)
      continue
    }
    const body = line.slice(field.label.length + 1).trim()
    if (field.type === 'text') {
      values[field.name] = body
      continue
    }
    const byLabel = occurrences(
      field.options.map((o) => ({ match: o.label, value: o.value })),
      body,
    )
    const picked =
      byLabel.length > 0
        ? byLabel
        : occurrences(
            field.options.map((o) => ({ match: o.value, value: o.value })),
            body,
          )
    values[field.name] = field.type === 'checklist' ? picked : (picked[0] ?? body)
  }

  return { values, other: leftovers.join('\n') }
}

/** Answered here in this session, or answered before it and read back. */
const answered = computed(() => submitted.value || (props.answer ?? '').trim().length > 0)

/** A settled flow step: drawn as one line rather than as its form. */
const collapsed = computed(
  () => !changing.value && !!props.flowStep && (props.flowStep.answer !== null || props.flowStep.superseded),
)

/** Reads a stored flow answer back into the controls — the value, not its label. */
function seed(answer: AssistantFlowAnswer) {
  const field = form.value?.fields[0]
  if (!field) return
  const v = answer.value
  const known = (x: string) => field.type === 'text' || field.options.some((o) => o.value === x)
  if (field.type === 'checklist') {
    const picked = Array.isArray(v) ? v : []
    values.value[field.name] = picked.filter(known)
    other.value = picked.filter((x) => !known(x)).join(', ')
  } else if (typeof v === 'string' && known(v)) {
    values.value[field.name] = v
  } else {
    values.value[field.name] = ''
    other.value = typeof v === 'string' ? v : ''
  }
}

/**
 * A mode-switch is only shown as accepted when the turn that followed it is
 * the intent it offered — the user is equally free to ignore it and ask
 * something else, and claiming they switched would be a lie about the record.
 */
const switched = computed(
  () =>
    props.prompt.kind === 'mode-switch' &&
    (props.answer ?? '').trim() === props.prompt.intent.trim(),
)

watch(
  () => props.answer,
  (text) => {
    if (!text || props.flowStep) return
    const parsed = parseAnswer(text)
    // The record of an answer shows what was sent, never a suggestion it skipped.
    values.value = { ...blank(false), ...parsed.values }
    other.value = parsed.other
  },
  { immediate: true },
)

/**
 * The answer goes back as a readable message, not as JSON.
 *
 * It has to survive twice: the model reads it as the next turn, and the user
 * reads it in their own transcript afterwards. "Scope: This project" is both;
 * a serialized payload is neither.
 */
function compose(): string {
  const f = form.value
  if (!f) return ''
  const lines: string[] = []
  for (const field of f.fields) {
    const v = values.value[field.name]
    const text = Array.isArray(v)
      ? v.map((x) => labelFor(field, x)).join(', ')
      : labelFor(field, String(v ?? '').trim())
    if (text) lines.push(`${field.label}: ${text}`)
  }
  if (other.value.trim()) lines.push(other.value.trim())
  return lines.join('\n')
}

watch(
  () => props.flowStep?.answer,
  (answer) => {
    if (answer) seed(answer)
  },
  { immediate: true },
)

/** The flow step's answer as the API validates it: an option value, the ticked values, free text, or null. */
function flowAnswer(): AssistantFlowAnswer | undefined {
  const f = form.value
  const field = f?.fields[0]
  if (!f?.flow || !f.questionId || !field) return undefined
  const v = values.value[field.name]
  const extra = other.value.trim()
  const value = Array.isArray(v)
    ? [...v, ...(extra ? [extra] : [])]
    : extra || String(v ?? '').trim() || null
  return { flow: f.flow, questionId: f.questionId, value }
}

function submit() {
  if (!live.value || !complete.value) return
  const structured = flowAnswer()
  // A skipped optional flow step still has to say so, or the turn looks empty.
  const answer = compose() || (structured ? `${form.value!.fields[0]!.label}: ${t('chat.flowSkipped')}` : '')
  if (!answer) return
  submitted.value = true
  changing.value = false
  emit('answer', answer, structured)
}

/** Enter answers from a radio or checkbox too, which have no implicit submit; a button or a multi-line box keeps its own Enter. */
function onEnter(e: KeyboardEvent) {
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement || e.isComposing) return
  e.preventDefault()
  submit()
}

/**
 * A flow's question takes focus when it arrives, on the selected option, so a
 * run of suggestions is a run of Enter presses. Only when nothing else holds
 * focus: a row re-mounted by scrolling must not pull the reader back to it.
 */
function focusControl() {
  void nextTick(() => {
    const el =
      rootEl.value?.querySelector<HTMLElement>('input:checked') ??
      rootEl.value?.querySelector<HTMLElement>('input, textarea')
    el?.focus({ preventScroll: true })
  })
}

onMounted(() => {
  const idle = !document.activeElement || document.activeElement === document.body
  if (props.active && form.value?.flow && idle) focusControl()
})

function startChange() {
  changing.value = true
  submitted.value = false
  focusControl()
}

function cancelChange() {
  changing.value = false
  if (props.flowStep?.answer) seed(props.flowStep.answer)
}
</script>

<template>
  <!-- A settled flow step: one line, the question. The answer is the user turn
       right below it, drawn as an answer rather than as a chat message.
       Superseded steps keep their line, struck through, so a changed answer is
       never silently gone. -->
  <div
    v-if="collapsed && form && flowStep"
    class="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border border-primary/25 bg-primary/[0.04] py-1.5 pr-1.5 pl-3.5 text-ui"
  >
    <p class="min-w-0" :class="flowStep.superseded ? 'text-muted-foreground line-through' : ''">{{ form.question }}</p>
    <Check v-if="!flowStep.superseded" class="size-3.5 shrink-0 text-panel-tip" :aria-label="t('chat.answered')" />
    <span v-else class="text-xs font-medium text-muted-foreground">
      {{ flowStep.answer ? t('chat.flowChanged') : t('chat.flowDropped') }}
    </span>
    <Button v-if="flowStep.changeable" variant="ghost" size="sm" class="ml-auto h-7" @click="startChange">
      {{ t('chat.flowChange') }}
    </Button>
  </div>

  <!-- Tinted and outlined so a question reads as a thing to act on, not as
       more of the answer it follows. -->
  <section
    v-else
    ref="rootEl"
    class="rounded-xl border border-primary/25 bg-primary/[0.04] p-3.5"
    :class="live ? '' : answered ? 'pointer-events-none opacity-80' : 'pointer-events-none opacity-55'"
    :aria-disabled="!live"
  >
    <!-- Mode switch ------------------------------------------------------- -->
    <template v-if="prompt.kind === 'mode-switch'">
      <div class="flex items-start gap-2.5">
        <span
          class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
          aria-hidden="true"
        >
          <Wand2 class="size-3.5" />
        </span>
        <div class="min-w-0 flex-1 space-y-2.5">
          <div class="space-y-1">
            <p class="text-sm font-medium">{{ t('chat.needsAgentMode') }}</p>
            <p class="text-ui leading-relaxed text-muted-foreground">
              {{ t('chat.agentModeExplainer') }}
            </p>
          </div>
          <p class="rounded-lg border bg-background px-3 py-2 text-ui leading-relaxed">
            {{ prompt.intent }}
          </p>
          <p v-if="switched" class="inline-flex items-center gap-1.5 text-ui text-muted-foreground">
            <Check class="size-3.5 text-panel-tip" />
            {{ t('chat.switchedToAgent') }}
          </p>
          <Button v-else size="sm" :disabled="!active" @click="emit('switchMode', prompt.intent)">
            <Sparkles class="size-3.5" />
            {{ t('chat.switchAndContinue') }}
          </Button>
        </div>
      </div>
    </template>

    <!-- Form -------------------------------------------------------------- -->
    <form v-else class="space-y-3.5" @submit.prevent="submit" @keydown.enter="onEnter">
      <p class="text-sm leading-relaxed font-medium">{{ prompt.question }}</p>

      <div v-for="field in prompt.fields" :key="field.name" class="space-y-1.5">
        <!-- A flow question's text is often its label; saying it twice is noise. -->
        <p v-if="field.label !== prompt.question" class="text-xs font-medium text-muted-foreground">
          {{ field.label }}
          <span v-if="field.required" class="text-primary" :aria-label="t('common.required')">*</span>
        </p>

        <!-- Radios: exactly one. Native radios sharing a name already move with the arrow keys. -->
        <div
          v-if="field.type === 'choice'"
          class="space-y-1"
          role="radiogroup"
          :aria-label="field.label"
          :aria-required="field.required || undefined"
        >
          <label
            v-for="opt in field.options"
            :key="opt.value"
            class="flex cursor-pointer items-start gap-2.5 rounded-lg border bg-background px-3 py-2 transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring"
            :class="
              isChecked(field, opt.value)
                ? 'border-primary bg-primary/[0.07] ring-1 ring-primary/30'
                : 'hover:bg-accent'
            "
          >
            <input
              type="radio"
              class="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)] outline-none"
              :name="field.name"
              :value="opt.value"
              :checked="isChecked(field, opt.value)"
              :disabled="!live"
              @change="values[field.name] = opt.value"
            />
            <span class="min-w-0 flex-1 leading-snug">
              <span class="block text-ui">{{ opt.label }}</span>
              <span v-if="opt.recommended || opt.description" class="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
                <span v-if="opt.recommended" class="text-xs font-medium text-primary">{{ t('chat.suggested') }}</span>
                <span v-if="opt.description" class="text-caption text-muted-foreground">{{ opt.description }}</span>
              </span>
            </span>
          </label>
        </div>

        <!-- Checkboxes: any number. -->
        <div v-else-if="field.type === 'checklist'" class="space-y-1" role="group" :aria-label="field.label">
          <label
            v-for="opt in field.options"
            :key="opt.value"
            class="flex cursor-pointer items-start gap-2.5 rounded-lg border bg-background px-3 py-2 transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring"
            :class="
              isChecked(field, opt.value)
                ? 'border-primary bg-primary/[0.07] ring-1 ring-primary/30'
                : 'hover:bg-accent'
            "
          >
            <input
              type="checkbox"
              class="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)] outline-none"
              :value="opt.value"
              :checked="isChecked(field, opt.value)"
              :disabled="!live"
              @change="toggle(field, opt.value)"
            />
            <span class="min-w-0 flex-1 leading-snug">
              <span class="block text-ui">{{ opt.label }}</span>
              <span v-if="opt.recommended || opt.description" class="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
                <span v-if="opt.recommended" class="text-xs font-medium text-primary">{{ t('chat.suggested') }}</span>
                <span v-if="opt.description" class="text-caption text-muted-foreground">{{ opt.description }}</span>
              </span>
            </span>
          </label>
        </div>

        <!-- Free text. -->
        <textarea
          v-else-if="field.multiline"
          v-model="values[field.name] as string"
          :placeholder="field.placeholder"
          :disabled="!live"
          :aria-label="field.label"
          rows="3"
          class="w-full resize-y rounded-lg border bg-background px-3 py-2 text-ui outline-none transition-colors focus:border-ring focus:ring-3 focus:ring-ring"
        />
        <Input
          v-else
          v-model="values[field.name] as string"
          :placeholder="field.placeholder"
          :disabled="!live"
          :aria-label="field.label"
          class="h-9 text-ui"
        />
      </div>

      <!-- The escape hatch: the offered options are the assistant's guess at
           the answer space, and it is allowed to be wrong. -->
      <div v-if="prompt.allowOther" class="space-y-1.5">
        <p class="text-xs font-medium text-muted-foreground">{{ t('chat.somethingElse') }}</p>
        <Input
          v-model="other"
          :placeholder="t('chat.answerInOwnWords')"
          :disabled="!live"
          :aria-label="t('chat.somethingElse')"
          class="h-9 text-ui"
          @keydown.esc.stop="other = ''"
        />
      </div>

      <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-0.5">
        <p v-if="answered && !changing" class="inline-flex items-center gap-1.5 text-ui text-muted-foreground">
          <Check class="size-3.5 text-panel-tip" />
          {{ t('chat.answered') }}
        </p>
        <template v-else>
          <Button type="submit" size="sm" :disabled="!live || !complete">
            {{ prompt.submitLabel ?? t('chat.sendAnswer') }}
            <ArrowRight class="size-3.5" />
          </Button>
          <Button v-if="changing" type="button" variant="ghost" size="sm" @click="cancelChange">
            {{ t('common.cancel') }}
          </Button>
        </template>
        <p v-if="live && !complete" class="text-caption text-muted-foreground">
          {{ t('chat.answerStarred') }}
        </p>
        <!-- Where in the flow this is: words, not a bar. -->
        <p v-if="prompt.step && prompt.of" class="ml-auto text-xs font-medium whitespace-nowrap text-muted-foreground">
          {{ t('chat.flowStep', { step: prompt.step, of: prompt.of }) }}
        </p>
      </div>
    </form>
  </section>
</template>
