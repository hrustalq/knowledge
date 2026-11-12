<script setup lang="ts">
/**
 * What a workspace is used for (#934): the closed catalogue as a checklist.
 * Mounted by Settings → Features and by the first-visit wizard, which also
 * passes the interview's one-line reason for each use it picked.
 */
import { useI18n } from 'vue-i18n'
import { WORKSPACE_USE_KEYS, type WorkspaceUse } from '@knowledge/contracts'
import { Checkbox } from '@knowledge/ui/checkbox'

defineProps<{ reasons?: Partial<Record<WorkspaceUse, string>> }>()
const uses = defineModel<WorkspaceUse[]>({ required: true })
const { t } = useI18n()

function toggle(use: WorkspaceUse, on: boolean) {
  // Catalogue order, so the stored list reads the same however it was clicked.
  uses.value = WORKSPACE_USE_KEYS.filter((u) => (u === use ? on : uses.value.includes(u)))
}
</script>

<template>
  <ul class="divide-y rounded-md border">
    <li v-for="use in WORKSPACE_USE_KEYS" :key="use" class="flex items-start gap-3 px-4 py-2.5">
      <Checkbox
        :id="`use-${use}`"
        class="mt-0.5"
        :model-value="uses.includes(use)"
        :aria-describedby="`use-${use}-hint`"
        @update:model-value="toggle(use, $event === true)"
      />
      <div class="min-w-0">
        <label :for="`use-${use}`" class="text-sm font-medium">{{ t(`features.purpose.uses.${use}.name`) }}</label>
        <p :id="`use-${use}-hint`" class="kn-measure text-xs text-muted-foreground">
          {{ t(`features.purpose.uses.${use}.description`) }}
          <span v-if="reasons?.[use]" class="mt-0.5 block text-foreground">{{ reasons[use] }}</span>
        </p>
      </div>
    </li>
  </ul>
</template>
