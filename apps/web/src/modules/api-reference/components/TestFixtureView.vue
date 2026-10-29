<script setup lang="ts">
/**
 * The main column of a test fixture document (#483): what it sets up, what a
 * run asks for, then each step in order and the teardown. Checked against the
 * specs as they stand now, so a call whose operation was removed since the
 * fixture was written shows here rather than at the next run.
 *
 * Placeholders print as written. A fixture never holds a secret, and this
 * view never fills one in.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { isCallStep as isCall, type FixtureCallStep, type FixtureStep, type TestFixtureResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import MarkdownView from '@/modules/documents/components/MarkdownView.vue'
import { PageState } from '@/widgets/page'
import ApiEndpoint from './ApiEndpoint.vue'
import ApiTone from './ApiTone.vue'

const props = defineProps<{ documentId: string; revisionId?: string | null }>()
const { t } = useI18n()

const query = useQuery(
  computed(() =>
    apiQueryOptions('/v1/test-fixtures/{id}', {
      path: { id: props.documentId },
      query: props.revisionId ? { revisionId: props.revisionId } : {},
    }),
  ),
)
const data = computed(() => query.data.value as TestFixtureResponse | undefined)
const fixture = computed(() => data.value?.fixture ?? null)
const callOf = (id: string) => data.value?.calls.find((c) => c.stepId === id)
const requestOf = (s: FixtureCallStep) => (Object.keys(s.request).length ? JSON.stringify(s.request, null, 2) : null)
const inputs = computed(() => {
  const declared = fixture.value?.inputs ?? {}
  return (data.value?.runValues.inputs ?? []).map((name) => ({ name, value: declared[name] ?? null }))
})
</script>

<template>
  <PageState v-if="query.isError.value" state="error" :description="errorMessage(query.error.value, t)" />
  <PageState v-else-if="!data" state="loading" :rows="3" row-class="h-24" />
  <div v-else class="min-w-0 space-y-8">
    <div v-if="data.issues.length" role="status" class="kn-callout-warning space-y-1 rounded-md border px-4 py-3 text-sm">
      <p class="font-medium">{{ t('testFixture.issuesNow', { n: data.issues.length }, data.issues.length) }}</p>
      <ul class="space-y-0.5">
        <li v-for="(i, n) in data.issues" :key="n" class="flex flex-wrap gap-x-2">
          <code class="font-mono text-xs opacity-80">{{ i.path }}</code><span>{{ i.message }}</span>
        </li>
      </ul>
    </div>

    <template v-if="fixture">
      <MarkdownView v-if="fixture.description" :markdown="fixture.description" />

      <section v-if="inputs.length || data.runValues.secrets.length" class="space-y-2" aria-labelledby="fx-run-values">
        <h2 id="fx-run-values" class="font-display text-base font-semibold">{{ t('testFixture.runValues') }}</h2>
        <dl class="grid gap-x-6 gap-y-1.5 text-ui sm:grid-cols-[max-content_minmax(0,1fr)]">
          <template v-for="i in inputs" :key="`i-${i.name}`">
            <dt><code class="font-mono">{{ i.name }}</code></dt>
            <dd class="text-muted-foreground">
              {{ i.value === null ? t('testFixture.inputRequired') : t('testFixture.inputDefaultIs', { value: String(i.value) }) }}
            </dd>
          </template>
          <template v-for="s in data.runValues.secrets" :key="`s-${s}`">
            <dt><code class="font-mono">{{ s }}</code></dt>
            <dd class="text-muted-foreground">{{ t('testFixture.secretAsked') }}</dd>
          </template>
        </dl>
      </section>

      <section
        v-for="part in [
          { key: 'setup', steps: fixture.steps as FixtureStep[] },
          { key: 'teardown', steps: fixture.teardown as FixtureStep[] },
        ].filter((p) => p.steps.length)"
        :key="part.key"
        class="space-y-3"
        :aria-labelledby="`fx-${part.key}`"
      >
        <div class="space-y-1">
          <h2 :id="`fx-${part.key}`" class="font-display text-base font-semibold">{{ t(`testFixture.${part.key}`) }}</h2>
          <p v-if="part.key === 'teardown'" class="text-muted-foreground text-ui">{{ t('testFixture.teardownHint') }}</p>
        </div>
        <ol class="space-y-3">
          <li v-for="(s, i) in part.steps" :key="s.id" class="bg-card min-w-0 space-y-3 rounded-lg border p-4">
            <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
              <span class="text-muted-foreground text-caption font-mono tabular-nums">{{ i + 1 }}</span>
              <code class="text-ui font-mono font-medium">{{ s.id }}</code>
              <template v-if="isCall(s)">
                <span class="flex min-w-0 flex-1 items-center gap-2">
                  <ApiEndpoint
                    v-if="callOf(s.id)?.operation"
                    :method="callOf(s.id)!.operation!.method"
                    :path="callOf(s.id)!.operation!.path"
                    protocol="http"
                  />
                  <code v-else class="text-ui text-destructive min-w-0 font-mono [overflow-wrap:anywhere]">{{ s.call }}</code>
                </span>
                <ApiTone :tone="null" variant="wash" :title="t('testFixture.expect')">{{ s.expect ?? t('testFixture.any2xx') }}</ApiTone>
              </template>
              <span v-else class="text-muted-foreground text-caption">{{ t('testFixture.manualStep') }}</span>
            </div>
            <template v-if="isCall(s)">
              <p v-if="callOf(s.id)?.operation" class="text-muted-foreground text-caption">
                {{ callOf(s.id)!.operation!.specTitle }}<template v-if="callOf(s.id)!.operation!.summary"> · {{ callOf(s.id)!.operation!.summary }}</template>
              </p>
              <ul v-if="Object.keys(s.capture).length" class="flex flex-wrap gap-1.5" :aria-label="t('testFixture.capture')">
                <li v-for="(rule, name) in s.capture" :key="name" class="bg-muted rounded-sm px-1.5 py-0.5 font-mono text-caption">
                  {{ name }} <span class="text-muted-foreground">{{ t('testFixture.captureFrom', { rule }) }}</span>
                </li>
              </ul>
              <pre v-if="requestOf(s)" class="bg-muted quiet-scroll overflow-x-auto rounded-md px-3 py-2 font-mono text-caption leading-relaxed">{{ requestOf(s) }}</pre>
            </template>
            <MarkdownView v-else :markdown="s.manual" />
          </li>
        </ol>
      </section>
    </template>
  </div>
</template>
