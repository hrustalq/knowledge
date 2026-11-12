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
import { RadioGroup, RadioGroupItem } from '@knowledge/ui/radio-group'
import { HISTORY_AUDIENCES, PUBLISH_MODES, type HistoryAudience, type PublishMode } from '@knowledge/contracts'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'

const { t } = useI18n()
const auth = useAuthStore()
const features = useFeaturesStore()

const policy = computed(() => features.editing)

// Empty = inherit the server's number.
const approvals = ref('')
const mode = ref<PublishMode>('review')
const audience = ref<HistoryAudience>('everyone')
function reset() {
  mode.value = policy.value?.publishMode.effective ?? 'review'
  audience.value = policy.value?.historyAudience.effective ?? 'everyone'
  approvals.value = policy.value?.requiredApprovals.workspace?.toString() ?? ''
}
watch(policy, reset, { immediate: true })

const approvalsValue = computed(() => (approvals.value.trim() === '' ? null : Number(approvals.value)))
const approvalsValid = computed(() => {
  const n = approvalsValue.value
  return n === null || (Number.isInteger(n) && n >= 0 && n <= 20)
})
const dirty = computed(
  () =>
    approvalsValue.value !== (policy.value?.requiredApprovals.workspace ?? null) ||
    mode.value !== policy.value?.publishMode.effective ||
    audience.value !== policy.value?.historyAudience.effective,
)

const saving = ref(false)
async function save() {
  if (saving.value || !dirty.value || !approvalsValid.value) return
  saving.value = true
  try {
    await features.saveEditing({
      requiredApprovals: approvalsValue.value,
      // The default is stored as "inherit".
      publishMode: mode.value === 'review' ? null : mode.value,
      historyAudience: audience.value === 'everyone' ? null : audience.value,
    })
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
      <section class="space-y-3" aria-labelledby="mode-heading">
        <div>
          <h2 id="mode-heading" class="text-base font-semibold">{{ t('editing.mode.title') }}</h2>
          <p class="kn-measure mt-0.5 text-sm text-muted-foreground">{{ t('editing.mode.subtitle') }}</p>
        </div>
        <RadioGroup v-model="mode" class="kn-measure gap-2" aria-labelledby="mode-heading">
          <label
            v-for="m in PUBLISH_MODES"
            :key="m"
            class="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 text-sm"
            :class="mode === m ? 'border-primary' : ''"
          >
            <RadioGroupItem :value="m" class="mt-0.5" />
            <span class="space-y-0.5">
              <span class="block font-medium">{{ t(`editing.mode.${m}.label`) }}</span>
              <span class="block text-xs text-muted-foreground">{{ t(`editing.mode.${m}.hint`) }}</span>
            </span>
          </label>
        </RadioGroup>
      </section>

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

      <section class="space-y-3" aria-labelledby="history-heading">
        <div>
          <h2 id="history-heading" class="text-base font-semibold">{{ t('editing.history.title') }}</h2>
          <p class="kn-measure mt-0.5 text-sm text-muted-foreground">{{ t('editing.history.subtitle') }}</p>
        </div>
        <RadioGroup v-model="audience" class="kn-measure gap-2" aria-labelledby="history-heading">
          <label
            v-for="a in HISTORY_AUDIENCES"
            :key="a"
            class="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 text-sm"
            :class="audience === a ? 'border-primary' : ''"
          >
            <RadioGroupItem :value="a" class="mt-0.5" />
            <span class="space-y-0.5">
              <span class="block font-medium">{{ t(`editing.history.${a}.label`) }}</span>
              <span class="block text-xs text-muted-foreground">{{ t(`editing.history.${a}.hint`) }}</span>
            </span>
          </label>
        </RadioGroup>
      </section>

      <div class="flex justify-end">
        <Button type="submit" size="sm" :disabled="!dirty || !approvalsValid || saving">
          {{ saving ? t('common.loading') : t('common.save') }}
        </Button>
      </div>
    </form>
  </div>
</template>
