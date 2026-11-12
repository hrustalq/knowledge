<script setup lang="ts">
/**
 * /settings/features (#604, #934): what this workspace is for, and which
 * sections it shows. Admin-only, like the PUTs behind it. The purpose is
 * advice: ticking a use previews the sections it suggests in the list below,
 * and the list stays the admin's to change before anything is saved.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@knowledge/ui/button'
import { Textarea } from '@knowledge/ui/textarea'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'
import FeatureSections from '../components/FeatureSections.vue'
import PurposeUses from '../components/PurposeUses.vue'
import { usePurposeDraft } from '../model/purpose-draft'

const { t } = useI18n()
const auth = useAuthStore()
const features = useFeaturesStore()
const draft = usePurposeDraft()

// The description is the admin's alone: the members' features read never carries it.
const description = ref('')
const storedDescription = ref('')
onMounted(async () => {
  if (!auth.canAdminWorkspace) return
  try {
    description.value = storedDescription.value = (await features.loadPurpose()).description ?? ''
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
})
// The store was replaced under the page (another workspace, a live refetch).
watch(() => [features.uses, features.disabled], draft.reset)

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v) => b.includes(v))
const purposeDirty = computed(
  () => !same(draft.uses.value, features.uses) || description.value.trim() !== storedDescription.value,
)
const dirty = computed(() => purposeDirty.value || !same(draft.off.value, features.disabled))

const saving = ref(false)
async function save() {
  if (saving.value || !dirty.value) return
  saving.value = true
  try {
    if (purposeDirty.value) {
      await features.savePurpose({ uses: draft.uses.value, description: description.value.trim() || null, disabled: draft.off.value })
      storedDescription.value = description.value = description.value.trim()
    } else {
      await features.save(draft.off.value)
    }
    draft.reset()
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

    <form v-else class="space-y-8" @submit.prevent="save">
      <section class="space-y-3" aria-labelledby="purpose-heading">
        <div>
          <h2 id="purpose-heading" class="text-base font-semibold">{{ t('features.purpose.title') }}</h2>
          <p class="kn-measure mt-0.5 text-sm text-muted-foreground">{{ t('features.purpose.subtitle') }}</p>
        </div>
        <PurposeUses v-model="draft.uses.value" />
        <div class="space-y-1.5">
          <label for="purpose-description" class="text-sm font-medium">{{ t('features.purpose.descriptionLabel') }}</label>
          <Textarea
            id="purpose-description"
            v-model="description"
            maxlength="2000"
            :placeholder="t('features.purpose.descriptionPlaceholder')"
            aria-describedby="purpose-description-hint"
          />
          <p id="purpose-description-hint" class="text-xs text-muted-foreground">{{ t('features.purpose.descriptionHint') }}</p>
        </div>
      </section>

      <section class="space-y-3" aria-labelledby="sections-heading">
        <h2 id="sections-heading" class="text-base font-semibold">{{ t('features.sectionsTitle') }}</h2>
        <FeatureSections :off="draft.off.value" :suggested="draft.suggested.value" @toggle="draft.toggle" />
        <p class="kn-measure text-xs text-muted-foreground">{{ t('features.background') }}</p>
      </section>

      <div class="flex justify-end">
        <Button type="submit" size="sm" :disabled="!dirty || saving">
          {{ saving ? t('common.loading') : purposeDirty ? t('features.purpose.apply') : t('common.save') }}
        </Button>
      </div>
    </form>
  </div>
</template>
