<script setup lang="ts">
/**
 * /settings/features (#604): which sections this workspace shows. Admin-only,
 * like the PUT behind it. Each row is one WORKSPACE_FEATURES value; off hides
 * the section in the app and refuses its API routes and MCP tools.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { WORKSPACE_FEATURES, type WorkspaceFeature } from '@knowledge/contracts'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'

const { t } = useI18n()
const auth = useAuthStore()
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
}

const off = ref(new Set<WorkspaceFeature>())
watch(
  () => features.disabled,
  (disabled) => {
    off.value = new Set(disabled)
  },
  { immediate: true },
)

const dirty = computed(
  () => off.value.size !== features.disabled.length || features.disabled.some((f) => !off.value.has(f)),
)

function toggle(feature: WorkspaceFeature, on: boolean) {
  const next = new Set(off.value)
  if (on) next.delete(feature)
  else next.add(feature)
  off.value = next
}

const saving = ref(false)
async function save() {
  if (saving.value || !dirty.value) return
  saving.value = true
  try {
    // Catalogue order, so the stored list reads the same however it was clicked.
    await features.save(WORKSPACE_FEATURES.filter((f) => off.value.has(f)))
    toast.success(t('features.saved'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-5">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('features.title') }}</h1>
      <p class="kn-measure mt-0.5 text-sm text-muted-foreground">{{ t('features.subtitle') }}</p>
    </div>
    <p v-if="!auth.canAdminWorkspace" class="text-sm text-muted-foreground">{{ t('features.adminOnly') }}</p>

    <form v-else class="space-y-5" @submit.prevent="save">
      <ul class="divide-y rounded-md border">
        <li v-for="feature in WORKSPACE_FEATURES" :key="feature" class="flex items-start gap-3 px-4 py-3">
          <Checkbox
            :id="`feature-${feature}`"
            class="mt-0.5"
            :model-value="!off.has(feature)"
            :aria-describedby="`feature-${feature}-hint`"
            @update:model-value="toggle(feature, $event === true)"
          />
          <div class="min-w-0">
            <label :for="`feature-${feature}`" class="text-sm font-medium">{{ t(NAV_LABEL[feature]) }}</label>
            <p :id="`feature-${feature}-hint`" class="kn-measure text-xs text-muted-foreground">
              {{ t(`features.items.${feature}`) }}
            </p>
          </div>
        </li>
      </ul>
      <p class="kn-measure text-xs text-muted-foreground">{{ t('features.background') }}</p>

      <div class="flex justify-end">
        <Button type="submit" size="sm" :disabled="!dirty || saving">
          {{ saving ? t('common.loading') : t('common.save') }}
        </Button>
      </div>
    </form>
  </div>
</template>
