<script setup lang="ts">
// The controls of an assistant question — radios, checkboxes, a text box — for
// one list of fields. Lifted out of `AssistantPrompt.vue` so the chat's
// `ask_user` / flow form and the scaffold interview (#731) draw one control
// set. The caller owns the form around it: the question, Enter, submit.
import { useI18n } from 'vue-i18n'
import type { AssistantPromptField } from '@knowledge/contracts'
import { Input } from '@/shared/ui/input'
import type { PromptValues } from '@/entities/assistant/model/prompt-values'

const { t } = useI18n()

defineProps<{
  fields: AssistantPromptField[]
  disabled?: boolean
  /** The question these fields answer: a field labelled the same is not labelled twice. */
  question?: string
}>()

const values = defineModel<PromptValues>('values', { required: true })

const set = (name: string, value: string | string[]) => (values.value = { ...values.value, [name]: value })

function toggle(field: AssistantPromptField, value: string) {
  const current = values.value[field.name]
  if (!Array.isArray(current)) return
  set(field.name, current.includes(value) ? current.filter((v) => v !== value) : [...current, value])
}

function isChecked(field: AssistantPromptField, value: string): boolean {
  const current = values.value[field.name]
  return Array.isArray(current) ? current.includes(value) : current === value
}
</script>

<template>
  <div v-for="field in fields" :key="field.name" class="space-y-1.5">
    <p v-if="field.label !== question" class="text-xs font-medium text-muted-foreground">
      {{ field.label }}
      <span v-if="field.required" class="text-primary" :aria-label="t('common.required')">*</span>
    </p>

    <!-- Radios: exactly one; checkboxes: any number. Native radios sharing a name already move with the arrow keys. -->
    <div
      v-if="field.type !== 'text'"
      class="space-y-1"
      :role="field.type === 'choice' ? 'radiogroup' : 'group'"
      :aria-label="field.label"
      :aria-required="(field.type === 'choice' && field.required) || undefined"
    >
      <label
        v-for="opt in field.options"
        :key="opt.value"
        class="flex cursor-pointer items-start gap-2.5 rounded-lg border bg-background px-3 py-2 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
        :class="isChecked(field, opt.value) ? 'border-primary bg-primary/[0.07] ring-1 ring-primary/30' : 'hover:bg-accent'"
      >
        <input
          :type="field.type === 'choice' ? 'radio' : 'checkbox'"
          class="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)] outline-none"
          :name="field.type === 'choice' ? field.name : undefined"
          :value="opt.value"
          :checked="isChecked(field, opt.value)"
          :disabled="disabled"
          @change="field.type === 'choice' ? set(field.name, opt.value) : toggle(field, opt.value)"
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
      :value="values[field.name] as string"
      :placeholder="field.placeholder"
      :disabled="disabled"
      :aria-label="field.label"
      rows="3"
      class="w-full resize-y rounded-lg border bg-background px-3 py-2 text-ui outline-none transition-colors focus:border-ring focus:ring-3 focus:ring-ring"
      @input="set(field.name, ($event.target as HTMLTextAreaElement).value)"
    />
    <Input
      v-else
      :model-value="values[field.name] as string"
      :placeholder="field.placeholder"
      :disabled="disabled"
      :aria-label="field.label"
      class="h-9 text-ui"
      @update:model-value="(v) => set(field.name, String(v))"
    />
  </div>
</template>
