<script setup lang="ts">
/**
 * One row of a project's settings (#928): the setting, what applies and which
 * level decided it, the workspace's own value, and one control. The three
 * facts are words, never a colour: a settings page that shows only an input
 * reads as blank while the workspace's value is doing the work.
 */
import { useI18n } from 'vue-i18n'
import { Button } from '@knowledge/ui/button'

defineProps<{
  /** The control's id, so the label names it. */
  id: string
  label: string
  hint?: string
  /** What applies, in words. */
  applies: string
  source: 'project' | 'workspace' | 'default'
  /** What the project would otherwise follow, in words; shown when the project overrides it. */
  workspace: string
  /** The draft carries a project value, so there is something to reset. */
  set: boolean
  disabled: boolean
  /** Why the control is disabled, when the reason is not simply "read-only". */
  reason?: string
}>()
defineEmits<{ reset: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="grid gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[1fr_14rem]">
    <div class="min-w-0">
      <label :for="id" class="text-sm font-medium">{{ label }}</label>
      <p v-if="hint" class="kn-measure text-xs text-muted-foreground">{{ hint }}</p>
      <p class="mt-1 text-xs">
        <span class="text-muted-foreground">{{ t('health.settings.applies') }}</span>
        {{ applies }}
        <span class="text-muted-foreground">· {{ t(`projectSettings.source.${source}`) }}</span>
      </p>
      <p v-if="source === 'project'" class="text-xs text-muted-foreground">{{ t('projectSettings.workspaceValue', { value: workspace }) }}</p>
      <p v-if="reason" :id="`${id}-reason`" class="mt-1 text-xs text-muted-foreground">{{ reason }}</p>
    </div>
    <!-- The reset sits under the control, so every control in a group keeps one width. -->
    <div class="min-w-0 space-y-1">
      <slot />
      <Button v-if="set && !disabled" type="button" variant="link" size="sm" class="h-auto p-0 text-xs" @click="$emit('reset')">
        {{ t('projectSettings.reset') }}
      </Button>
    </div>
  </div>
</template>
