<script setup lang="ts">
/**
 * The workspace's sections as switches (#604), and the preview of a purpose
 * (#934): a row says when saving would switch it, and when it differs from
 * what the chosen uses suggest. Each row is one WORKSPACE_FEATURES value.
 */
import { useI18n } from 'vue-i18n'
import { WORKSPACE_FEATURES, type WorkspaceFeature } from '@knowledge/contracts'
import { Checkbox } from '@knowledge/ui/checkbox'
import { useFeaturesStore } from '@/stores/features'

const props = defineProps<{
  /** The sections off in the draft. */
  off: WorkspaceFeature[]
  /** Off under the draft's uses; null when no use is chosen. */
  suggested: WorkspaceFeature[] | null
}>()
defineEmits<{ toggle: [feature: WorkspaceFeature, on: boolean] }>()

const { t } = useI18n()
const features = useFeaturesStore()

/** The section's name as the nav prints it, so the two never disagree. */
const NAV_LABEL: Record<WorkspaceFeature, string> = {
  workflows: 'nav.workflows',
  'knowledge-health': 'nav.knowledgeHealth',
  qa: 'nav.qa',
  analytics: 'nav.analytics',
  captures: 'nav.captures',
  memos: 'nav.memos',
  conflicts: 'nav.conflicts',
  assistant: 'nav.assistant',
  // No nav entry: the remote is reached with `git clone`, not a page.
  git: 'features.names.git',
  // Reached from "Add page", not the nav.
  sources: 'features.names.sources',
  // No page: agents reach it over the Hindsight API.
  memory: 'features.names.memory',
}

/** The env ceiling that takes a section off this server, named so the admin knows what to ask for. */
const SERVER_SWITCH: Partial<Record<WorkspaceFeature, string>> = { sources: 'WEB_SOURCES_ENABLED', memory: 'MEMORY_ENABLED' }

const isOff = (f: WorkspaceFeature) => props.off.includes(f)
const switches = (f: WorkspaceFeature) => isOff(f) !== features.disabled.includes(f)
const differs = (f: WorkspaceFeature) => props.suggested !== null && isOff(f) !== props.suggested.includes(f)
</script>

<template>
  <ul class="divide-y rounded-md border">
    <li v-for="feature in WORKSPACE_FEATURES" :key="feature" class="flex items-start gap-3 px-4 py-3">
      <Checkbox
        :id="`feature-${feature}`"
        class="mt-0.5"
        :model-value="!isOff(feature)"
        :aria-describedby="`feature-${feature}-hint`"
        @update:model-value="$emit('toggle', feature, $event === true)"
      />
      <div class="min-w-0">
        <label :for="`feature-${feature}`" class="text-sm font-medium">{{ t(NAV_LABEL[feature]) }}</label>
        <p :id="`feature-${feature}-hint`" class="kn-measure text-xs text-muted-foreground">
          {{ t(`features.items.${feature}`) }}
          <!-- An env ceiling: what is asked for and what applies, both shown. -->
          <span v-if="features.unavailable.includes(feature)" class="text-foreground">{{ t('features.serverOff', { env: SERVER_SWITCH[feature] ?? '' }) }}</span>
          <span v-if="switches(feature)" class="mt-0.5 block font-medium text-foreground">
            {{ isOff(feature) ? t('features.purpose.switchesOff') : t('features.purpose.switchesOn') }}
          </span>
          <span v-if="differs(feature)" class="mt-0.5 block text-foreground">
            {{ isOff(feature) ? t('features.purpose.suggestsOn') : t('features.purpose.suggestsOff') }}
          </span>
        </p>
      </div>
    </li>
  </ul>
</template>
