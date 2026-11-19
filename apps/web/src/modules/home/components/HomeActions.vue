<script setup lang="ts">
// The four starts (#1243), each a plain link to the page that does it: an
// action a caller may not take, or whose section is off, is not offered.
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { FilePlus2, Sparkles, Upload, Workflow } from 'lucide-vue-next'
import { Button } from '@knowledge/ui/button'
import { usePermission } from '@/stores/permissions'
import { useFeaturesStore } from '@/stores/features'

const { t } = useI18n()
const canContribute = usePermission('workspace:contribute')
const canViewWorkspace = usePermission('workspace:view')
const features = useFeaturesStore()

interface HomeAction {
  to: string
  label: string
  icon: Component
}

const actions = computed(() => {
  const out: HomeAction[] = []
  if (canContribute.value) out.push({ to: '/create', label: t('home.actions.newPage'), icon: FilePlus2 })
  if (canContribute.value) out.push({ to: '/upload', label: t('home.actions.import'), icon: Upload })
  // A guest fails every workspace-level route, the assistant's among them.
  if (canViewWorkspace.value && features.isOn('assistant')) out.push({ to: '/assistant', label: t('home.actions.ask'), icon: Sparkles })
  if (canContribute.value && features.isOn('workflows')) out.push({ to: '/workflows', label: t('home.actions.workflow'), icon: Workflow })
  return out
})
</script>

<template>
  <div v-if="actions.length" class="flex flex-wrap gap-2">
    <!-- All outline: Needs you is the page's lead, not a start button. -->
    <Button v-for="a in actions" :key="a.to" as-child variant="outline" size="sm">
      <RouterLink :to="a.to">
        <component :is="a.icon" aria-hidden="true" />
        {{ a.label }}
      </RouterLink>
    </Button>
  </div>
</template>
