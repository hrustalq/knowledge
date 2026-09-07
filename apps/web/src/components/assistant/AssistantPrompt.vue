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
// has been answered the answer is right above it, so the controls go quiet:
// still readable as the record of a question, no longer inviting a second
// answer to a question already settled.
import { computed, ref } from 'vue'
import { ArrowRight, Check, Sparkles, Wand2 } from 'lucide-vue-next'
import type { AssistantPrompt, AssistantPromptField } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const props = defineProps<{
  prompt: AssistantPrompt
  /** False for a prompt further up the thread, or while a turn is in flight. */
  active: boolean
}>()

const emit = defineEmits<{
  /** The composed answer, to send as the next user turn. */
  answer: [string]
  /** Accepted the switch to Agent mode, with the intent to re-send. */
  switchMode: [string]
}>()

const form = computed(() => (props.prompt.kind === 'form' ? props.prompt : null))

// One bag of answers keyed by field name: a string for choice/text, an array
// for checklist. Kept untyped-ish on purpose — the field list is model-authored
// and the template narrows per field type anyway.
const values = ref<Record<string, string | string[]>>(
  Object.fromEntries(
    (form.value?.fields ?? []).map((f) => [f.name, f.type === 'checklist' ? [] : '']),
  ),
)
const other = ref('')
const submitted = ref(false)

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
      : String(v ?? '').trim()
    if (text) lines.push(`${field.label}: ${text}`)
  }
  if (other.value.trim()) lines.push(other.value.trim())
  return lines.join('\n')
}

function submit() {
  const answer = compose()
  if (!answer || !props.active) return
  submitted.value = true
  emit('answer', answer)
}
</script>

<template>
  <!-- Tinted and outlined so a question reads as a thing to act on, not as
       more of the answer it follows. -->
  <section
    class="rounded-xl border border-primary/25 bg-primary/[0.04] p-3.5"
    :class="active ? '' : 'pointer-events-none opacity-55'"
    :aria-disabled="!active"
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
            <p class="text-sm font-medium">This needs Agent mode</p>
            <p class="text-[13px] leading-relaxed text-muted-foreground">
              Ask mode only reads. Switching lets the assistant write — a new page goes live immediately, a
              change to an existing page opens a merge request for you to review.
            </p>
          </div>
          <p class="rounded-lg border bg-background px-3 py-2 text-[13px] leading-relaxed">
            {{ prompt.intent }}
          </p>
          <Button size="sm" :disabled="!active" @click="emit('switchMode', prompt.intent)">
            <Sparkles class="size-3.5" />
            Switch to Agent and continue
          </Button>
        </div>
      </div>
    </template>

    <!-- Form -------------------------------------------------------------- -->
    <form v-else class="space-y-3.5" @submit.prevent="submit">
      <p class="text-sm leading-relaxed font-medium">{{ prompt.question }}</p>

      <div v-for="field in prompt.fields" :key="field.name" class="space-y-1.5">
        <p class="text-xs font-medium text-muted-foreground">
          {{ field.label }}
          <span v-if="field.required" class="text-primary" aria-label="required">*</span>
        </p>

        <!-- Radios: exactly one. -->
        <div v-if="field.type === 'choice'" class="space-y-1" role="radiogroup" :aria-label="field.label">
          <label
            v-for="opt in field.options"
            :key="opt.value"
            class="flex cursor-pointer items-start gap-2.5 rounded-lg border bg-background px-3 py-2 transition-colors"
            :class="isChecked(field, opt.value) ? 'border-primary ring-1 ring-primary/30' : 'hover:bg-accent'"
          >
            <input
              type="radio"
              class="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)]"
              :name="field.name"
              :value="opt.value"
              :checked="isChecked(field, opt.value)"
              :disabled="!active"
              @change="values[field.name] = opt.value"
            />
            <span class="min-w-0 flex-1 leading-snug">
              <span class="block text-[13px]">{{ opt.label }}</span>
              <span v-if="opt.description" class="block text-[11px] text-muted-foreground">
                {{ opt.description }}
              </span>
            </span>
          </label>
        </div>

        <!-- Checkboxes: any number. -->
        <div v-else-if="field.type === 'checklist'" class="space-y-1">
          <label
            v-for="opt in field.options"
            :key="opt.value"
            class="flex cursor-pointer items-start gap-2.5 rounded-lg border bg-background px-3 py-2 transition-colors"
            :class="isChecked(field, opt.value) ? 'border-primary ring-1 ring-primary/30' : 'hover:bg-accent'"
          >
            <input
              type="checkbox"
              class="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)]"
              :value="opt.value"
              :checked="isChecked(field, opt.value)"
              :disabled="!active"
              @change="toggle(field, opt.value)"
            />
            <span class="min-w-0 flex-1 leading-snug">
              <span class="block text-[13px]">{{ opt.label }}</span>
              <span v-if="opt.description" class="block text-[11px] text-muted-foreground">
                {{ opt.description }}
              </span>
            </span>
          </label>
        </div>

        <!-- Free text. -->
        <textarea
          v-else-if="field.multiline"
          v-model="values[field.name] as string"
          :placeholder="field.placeholder"
          :disabled="!active"
          rows="3"
          class="w-full resize-y rounded-lg border bg-background px-3 py-2 text-[13px] outline-none transition-colors focus:border-ring focus:ring-3 focus:ring-ring/25"
        />
        <Input
          v-else
          v-model="values[field.name] as string"
          :placeholder="field.placeholder"
          :disabled="!active"
          class="h-9 text-[13px]"
        />
      </div>

      <!-- The escape hatch: the offered options are the assistant's guess at
           the answer space, and it is allowed to be wrong. -->
      <div v-if="prompt.allowOther" class="space-y-1.5">
        <p class="text-xs font-medium text-muted-foreground">Something else</p>
        <Input
          v-model="other"
          placeholder="Answer in your own words instead"
          :disabled="!active"
          class="h-9 text-[13px]"
        />
      </div>

      <div class="flex items-center gap-2 pt-0.5">
        <Button type="submit" size="sm" :disabled="!active || !complete">
          <template v-if="submitted">
            <Check class="size-3.5" />
            Sent
          </template>
          <template v-else>
            {{ prompt.submitLabel ?? 'Send answer' }}
            <ArrowRight class="size-3.5" />
          </template>
        </Button>
        <p v-if="active && !complete" class="text-[11px] text-muted-foreground">
          Answer the starred fields to continue.
        </p>
      </div>
    </form>
  </section>
</template>
