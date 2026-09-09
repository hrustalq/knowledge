<script setup lang="ts">
/**
 * What the workflow is for, and when it starts.
 *
 * Extracted so the builder's inspector and the wizard's last step ask the same
 * questions in the same words — the trigger settings are the part of this
 * feature with a real failure mode (an always-on trigger is an LLM avalanche),
 * and two copies of that explanation is one copy too many.
 *
 * Auto-start's own settings are revealed only once it is on. They are
 * meaningless otherwise, and showing four disabled checkboxes to explain a
 * switch nobody turned on is how this panel used to read as a form.
 */
import { useI18n } from 'vue-i18n'
import { DOCUMENT_CATEGORIES, KNOWN_EVENT_TYPES, type WorkflowTrigger } from '@knowledge/contracts'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'

const props = defineProps<{
  description: string
  trigger: WorkflowTrigger
  canManage: boolean
  /** The builder shows a header; the wizard supplies its own. */
  bare?: boolean
}>()

const emit = defineEmits<{
  'update:description': [string]
  'update:trigger': [WorkflowTrigger]
}>()

const { t } = useI18n()

/** Only page and revision events can name a source page to run against. */
const TRIGGER_EVENTS = KNOWN_EVENT_TYPES.filter((e) => e.startsWith('document.') || e.startsWith('revision.'))

function patch(fields: Partial<WorkflowTrigger>) {
  emit('update:trigger', { ...props.trigger, ...fields })
}

function toggleEvent(event: string, on: boolean) {
  patch({ events: on ? [...props.trigger.events, event] : props.trigger.events.filter((e) => e !== event) })
}

function toggleCategory(category: string, on: boolean) {
  const categories = props.trigger.categories ?? []
  patch({
    categories: (on ? [...categories, category] : categories.filter((c) => c !== category)) as never,
  })
}
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <header v-if="!bare" class="shrink-0 border-b px-4 py-3">
      <p class="text-sm font-medium">{{ t('workflow.thisWorkflow') }}</p>
      <p class="text-muted-foreground text-[11px]">{{ t('workflow.selectStep') }}</p>
    </header>

    <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
      <label class="block space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.description') }}</span>
        <Textarea
          :model-value="description"
          :disabled="!canManage"
          rows="3"
          :placeholder="t('workflow.descriptionPlaceholder')"
          @update:model-value="(v) => emit('update:description', String(v))"
        />
      </label>

      <div class="space-y-2">
        <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.starts') }}</span>
        <label class="flex items-start gap-2">
          <Checkbox
            :model-value="trigger.manual"
            :disabled="!canManage"
            @update:model-value="(v) => patch({ manual: Boolean(v) })"
          />
          <span class="min-w-0">
            <span class="block text-xs font-medium">{{ t('workflow.whenSomeoneAsks') }}</span>
            <span class="text-muted-foreground block text-[11px] leading-snug">
              {{ t('workflow.settings.manualHint') }}
            </span>
          </span>
        </label>
        <label class="flex items-start gap-2">
          <Checkbox
            :model-value="trigger.autoStart"
            :disabled="!canManage"
            @update:model-value="(v) => patch({ autoStart: Boolean(v) })"
          />
          <span class="min-w-0">
            <span class="block text-xs font-medium">{{ t('workflow.onItsOwn') }}</span>
            <span class="text-muted-foreground block text-[11px] leading-snug">
              {{ t('workflow.settings.autoHint') }}
            </span>
          </span>
        </label>
      </div>

      <div v-if="trigger.autoStart" class="space-y-4">
        <div class="space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.settings.after') }}</span>
          <label v-for="event in TRIGGER_EVENTS" :key="event" class="flex items-center gap-2">
            <Checkbox
              :model-value="trigger.events.includes(event)"
              :disabled="!canManage"
              @update:model-value="(v) => toggleEvent(event, Boolean(v))"
            />
            <span class="font-mono text-[11px]">{{ event }}</span>
          </label>
        </div>
        <div class="space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.settings.onlyFor') }}</span>
          <div class="flex flex-wrap gap-x-3 gap-y-1.5">
            <label v-for="c in DOCUMENT_CATEGORIES" :key="c" class="flex items-center gap-1.5">
              <Checkbox
                :model-value="trigger.categories.includes(c)"
                :disabled="!canManage"
                @update:model-value="(v) => toggleCategory(c, Boolean(v))"
              />
              <span class="text-[11px]">{{ t(`category.${c}`) }}</span>
            </label>
          </div>
          <p class="text-muted-foreground text-[11px]">{{ t('workflow.settings.everyCategory') }}</p>
        </div>
      </div>

      <slot name="footer" />
    </div>
  </div>
</template>
