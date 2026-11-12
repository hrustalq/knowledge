<script setup lang="ts">
/**
 * /settings/editing (#958): how an edit reaches a page in this workspace.
 * Admin-only, like the PUT behind it. Every control shows what applies; one
 * left on its default is stored as "inherit", so a later change of the default
 * reaches this workspace.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@knowledge/ui/button'
import { Input } from '@knowledge/ui/input'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'

const { t } = useI18n()
const auth = useAuthStore()
const features = useFeaturesStore()

const policy = computed(() => features.editing)

// Empty = inherit the server's number.
const approvals = ref('')
function reset() {
  approvals.value = policy.value?.requiredApprovals.workspace?.toString() ?? ''
}
watch(policy, reset, { immediate: true })

const approvalsValue = computed(() => (approvals.value.trim() === '' ? null : Number(approvals.value)))
const approvalsValid = computed(() => {
  const n = approvalsValue.value
  return n === null || (Number.isInteger(n) && n >= 0 && n <= 20)
})
const dirty = computed(() => approvalsValue.value !== (policy.value?.requiredApprovals.workspace ?? null))

const saving = ref(false)
async function save() {
  if (saving.value || !dirty.value || !approvalsValid.value) return
  saving.value = true
  try {
    await features.saveEditing({ requiredApprovals: approvalsValue.value })
    toast.success(t('editing.saved'))
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
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('editing.title') }}</h1>
      <p class="kn-measure mt-0.5 text-sm text-muted-foreground">{{ t('editing.subtitle') }}</p>
    </div>
    <p v-if="!auth.canAdminWorkspace" class="text-sm text-muted-foreground">{{ t('editing.adminOnly') }}</p>
    <p v-else-if="!policy" class="text-sm text-muted-foreground" role="status">{{ t('editing.unavailable') }}</p>

    <form v-else class="space-y-8" @submit.prevent="save">
      <section class="space-y-3" aria-labelledby="approvals-heading">
        <div>
          <h2 id="approvals-heading" class="text-base font-semibold">{{ t('editing.approvals.title') }}</h2>
          <p class="kn-measure mt-0.5 text-sm text-muted-foreground">{{ t('editing.approvals.subtitle') }}</p>
        </div>
        <div class="space-y-1.5">
          <label for="editing-approvals" class="text-sm font-medium">{{ t('editing.approvals.label') }}</label>
          <Input
            id="editing-approvals"
            v-model="approvals"
            type="number"
            min="0"
            max="20"
            step="1"
            inputmode="numeric"
            class="w-28 tabular-nums"
            :placeholder="String(policy.requiredApprovals.inherited)"
            :aria-invalid="!approvalsValid || undefined"
            aria-describedby="editing-approvals-hint"
          />
          <p id="editing-approvals-hint" class="text-xs" :class="approvalsValid ? 'text-muted-foreground' : 'text-destructive'">
            {{
              !approvalsValid
                ? t('editing.approvals.invalid')
                : approvalsValue === null
                  ? t('editing.approvals.inherits', { n: policy.requiredApprovals.inherited }, policy.requiredApprovals.inherited)
                  : t('editing.approvals.hint', { n: policy.requiredApprovals.inherited })
            }}
          </p>
        </div>
      </section>

      <div class="flex justify-end">
        <Button type="submit" size="sm" :disabled="!dirty || !approvalsValid || saving">
          {{ saving ? t('common.loading') : t('common.save') }}
        </Button>
      </div>
    </form>
  </div>
</template>
