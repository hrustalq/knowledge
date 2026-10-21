<script setup lang="ts">
/**
 * The Ask tab of a site's settings (issue #77 phase 3, docs/features/44):
 * whether the site answers questions, how many a day, and which sites may
 * embed the widget.
 *
 * The daily budget is shown twice on purpose — what this site asks for and
 * what applies under PUBLIC_ASK_DAILY_BUDGET — because the env is a ceiling,
 * and a silent clamp would lie about the configuration (CLAUDE.md). Origins
 * are typed one per line; the API normalizes them, and what it stored is what
 * the form shows next.
 */
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy } from 'lucide-vue-next'
import { SITE_ASK_BUDGET_MAX, SITE_EMBED_ORIGINS_MAX, type ProjectSiteResponse, type PublishedSiteSummary } from '@knowledge/contracts'
import { useCopy } from '@/lib/use-copy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

const props = defineProps<{
  site: PublishedSiteSummary
  policy: ProjectSiteResponse['policy']
  canManage: boolean
  busy: boolean
}>()
const emit = defineEmits<{ save: [body: Record<string, unknown>] }>()

const { t } = useI18n()
const { state: copyState, copy } = useCopy()

// Format examples, not copy: the same in every language.
const ORIGIN_EXAMPLE = 'https://www.example.com'

const form = reactive({ enabled: false, budget: '', origins: '' })
function reset() {
  form.enabled = props.site.ask.enabled
  form.budget = props.site.ask.dailyBudget === null ? '' : String(props.site.ask.dailyBudget)
  form.origins = props.site.ask.embedOrigins.join('\n')
}
watch(() => props.site.ask, reset, { immediate: true })

const origins = computed(() => form.origins.split('\n').map((o) => o.trim()).filter(Boolean))
const budget = computed<number | null>(() => (form.budget.trim() === '' ? null : Number(form.budget)))
const budgetInvalid = computed(
  () => budget.value !== null && (!Number.isInteger(budget.value) || budget.value < 0 || budget.value > SITE_ASK_BUDGET_MAX),
)
const dirty = computed(
  () =>
    form.enabled !== props.site.ask.enabled ||
    budget.value !== props.site.ask.dailyBudget ||
    origins.value.join('\n') !== props.site.ask.embedOrigins.join('\n'),
)

const snippet = computed(() => `<script src="${props.site.url.replace(/\/+$/, '')}/widget.js" async><\/script>`)
const capped = computed(() => props.site.ask.effectiveDailyBudget < (props.site.ask.dailyBudget ?? props.policy.askDailyCeiling))

function save() {
  if (budgetInvalid.value || origins.value.length > SITE_EMBED_ORIGINS_MAX) return
  const body: Record<string, unknown> = {}
  if (form.enabled !== props.site.ask.enabled) body.askEnabled = form.enabled
  if (budget.value !== props.site.ask.dailyBudget) body.askDailyBudget = budget.value
  if (origins.value.join('\n') !== props.site.ask.embedOrigins.join('\n')) body.embedOrigins = origins.value
  emit('save', body)
}
</script>

<template>
  <form class="max-w-2xl space-y-6" @submit.prevent="save">
    <p v-if="policy.askDailyCeiling === 0" role="alert" class="rounded-md border kn-callout-warning px-3 py-2 text-sm">
      {{ t('site.ask.offByCeiling') }}
    </p>
    <p v-else-if="!policy.askModelConfigured" role="alert" class="rounded-md border kn-callout-warning px-3 py-2 text-sm">
      {{ t('site.ask.noModel') }}
    </p>

    <label class="flex items-start gap-2 text-sm">
      <input v-model="form.enabled" type="checkbox" class="mt-0.5" :disabled="!canManage">
      <span>
        {{ t('site.ask.enabled') }}
        <span class="block text-xs text-muted-foreground">{{ t('site.ask.enabledHint') }}</span>
      </span>
    </label>

    <div class="space-y-1">
      <label for="site-ask-budget" class="text-xs font-medium text-muted-foreground">{{ t('site.ask.budget') }}</label>
      <div class="flex items-center gap-3">
        <Input
          id="site-ask-budget"
          v-model="form.budget"
          inputmode="numeric"
          class="w-32"
          :placeholder="String(policy.askDailyCeiling)"
          :disabled="!canManage"
          :aria-invalid="budgetInvalid || undefined"
        />
        <Badge variant="secondary">{{ t('site.ask.applies', { n: site.ask.effectiveDailyBudget }) }}</Badge>
      </div>
      <span class="block text-xs" :class="budgetInvalid ? 'text-destructive' : 'text-muted-foreground'">
        {{ budgetInvalid ? t('site.ask.budgetInvalid', { max: SITE_ASK_BUDGET_MAX }) : t('site.ask.budgetHint', { ceiling: policy.askDailyCeiling }) }}
      </span>
      <span v-if="capped" class="block text-xs text-muted-foreground">{{ t('site.ask.capped', { ceiling: policy.askDailyCeiling }) }}</span>
    </div>

    <div class="space-y-1">
      <label for="site-ask-origins" class="text-xs font-medium text-muted-foreground">{{ t('site.ask.origins') }}</label>
      <Textarea
        id="site-ask-origins"
        v-model="form.origins"
        rows="4"
        class="font-mono text-xs"
        :placeholder="ORIGIN_EXAMPLE"
        :disabled="!canManage"
        spellcheck="false"
      />
      <span class="block text-xs text-muted-foreground">{{ t('site.ask.originsHint', { max: SITE_EMBED_ORIGINS_MAX }) }}</span>
    </div>

    <Button v-if="canManage" type="submit" size="sm" :disabled="!dirty || busy || budgetInvalid">{{ t('common.save') }}</Button>

    <div v-if="site.ask.enabled" class="space-y-2 border-t pt-4">
      <p class="text-sm font-medium">{{ t('site.ask.snippet') }}</p>
      <p class="text-xs text-muted-foreground">{{ t('site.ask.snippetHint') }}</p>
      <div class="flex items-start gap-2">
        <code class="min-w-0 flex-1 rounded-md border bg-muted px-3 py-2 font-mono text-xs break-all">{{ snippet }}</code>
        <Button type="button" size="sm" variant="outline" :aria-label="t('site.ask.copySnippet')" @click="copy(snippet)">
          <Check v-if="copyState === 'copied'" class="size-4" aria-hidden="true" />
          <Copy v-else class="size-4" aria-hidden="true" />
        </Button>
      </div>
      <p v-if="!site.ask.embedOrigins.length" class="text-xs text-muted-foreground">{{ t('site.ask.noOrigins') }}</p>
    </div>
  </form>
</template>
