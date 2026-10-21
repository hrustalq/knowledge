<script setup lang="ts">
/**
 * Handoff rules (#424): which knowledge objects get a tracker ticket without
 * anyone pressing "Send to tracker". All off by default. They run under a
 * deployment ceiling — so many tickets per sweep — and only into projects
 * with a tracker route, and the form says both next to the choice, because a
 * rule that silently creates nothing reads as a broken rule.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type { WorkItemRules, WorkItemRulesResponse } from '@knowledge/contracts'
import { WORK_ITEM_CONFLICT_RULES, WORK_ITEM_ISSUE_RULES, WORK_ITEM_VERIFICATION_RULES } from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageState } from '@/components/layout/page'

const { t } = useI18n()
const queryClient = useQueryClient()
const workspaceId = getWorkspaceId()

const query = useQuery(apiQueryOptions('/v1/work-items/rules', { query: { workspaceId } }))
const settings = computed(() => query.data.value as WorkItemRulesResponse | undefined)

type Draft = Record<keyof WorkItemRules, string>
const draft = ref<Draft>({ issues: 'off', conflicts: 'off', verification: 'off' })
watch(
  settings,
  (s) => {
    if (!s) return
    draft.value = {
      issues: s.requested.issues ?? 'off',
      conflicts: s.requested.conflicts ?? 'off',
      verification: s.requested.verification ?? 'off',
    }
  },
  { immediate: true },
)

const rows = [
  { key: 'issues', options: WORK_ITEM_ISSUE_RULES },
  { key: 'conflicts', options: WORK_ITEM_CONFLICT_RULES },
  { key: 'verification', options: WORK_ITEM_VERIFICATION_RULES },
] as const

const dirty = computed(() => {
  const s = settings.value
  return !!s && rows.some((r) => (s.requested[r.key] ?? 'off') !== draft.value[r.key])
})
const anyOn = computed(() => rows.some((r) => draft.value[r.key] !== 'off'))
/** The deployment can stop rules altogether; say so rather than show a choice that does nothing. */
const stopped = computed(() => !!settings.value && (settings.value.ceiling.maxPerTick === 0 || !settings.value.ceiling.syncEnabled))

const saving = ref(false)
async function save() {
  if (!dirty.value || saving.value) return
  saving.value = true
  try {
    const off = (v: string) => (v === 'off' ? null : v)
    await api.put('/v1/work-items/rules', {
      body: {
        workspaceId,
        issues: off(draft.value.issues) as WorkItemRules['issues'],
        conflicts: off(draft.value.conflicts) as WorkItemRules['conflicts'],
        verification: off(draft.value.verification) as WorkItemRules['verification'],
      },
    })
    toast.success(t('workItems.rules.saved'))
    void queryClient.invalidateQueries({ queryKey: ['/v1/work-items/rules'] })
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <PageState v-if="query.isPending.value" state="loading" :rows="3" row-class="h-12" />
  <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />

  <form v-else-if="settings" class="space-y-5" @submit.prevent="save">
    <div>
      <h2 class="text-base font-semibold">{{ t('workItems.rules.title') }}</h2>
      <p class="kn-measure mt-0.5 text-sm text-muted-foreground">{{ t('workItems.rules.intro') }}</p>
    </div>

    <div class="divide-y rounded-md border">
      <div v-for="row in rows" :key="row.key" class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[1fr_14rem]">
        <div class="min-w-0">
          <span :id="`rule-${row.key}`" class="text-sm font-medium">{{ t(`workItems.rules.${row.key}.label`) }}</span>
          <p class="kn-measure text-xs text-muted-foreground">{{ t(`workItems.rules.${row.key}.hint`) }}</p>
        </div>
        <Select v-model="draft[row.key]">
          <SelectTrigger class="h-9 w-full" :aria-labelledby="`rule-${row.key}`">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in row.options" :key="option" :value="option">
              {{ t(`workItems.rules.${row.key}.options.${option}`) }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <!-- The ceiling and the route requirement, next to the choice they limit. -->
    <p class="kn-measure text-xs" :class="stopped && anyOn ? 'text-destructive' : 'text-muted-foreground'">
      <template v-if="stopped">{{ t('workItems.rules.stopped') }}</template>
      <template v-else>{{ t('workItems.rules.ceiling', { n: settings.ceiling.maxPerTick }, settings.ceiling.maxPerTick) }}</template>
    </p>

    <div class="flex justify-end">
      <Button type="submit" size="sm" :disabled="!dirty || saving">
        {{ saving ? t('common.loading') : t('common.save') }}
      </Button>
    </div>
  </form>
</template>
