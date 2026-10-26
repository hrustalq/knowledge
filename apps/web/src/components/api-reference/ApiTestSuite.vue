<script setup lang="ts">
/**
 * One operation's QA test suite (#468), as a section of the open card: where
 * it came from, the two exports, and the cases grouped positive / negative.
 * A case is one row — expected status, name, rule — that opens in place to
 * what it checks and its curl command.
 *
 * Both exports come from the API's `?format=`: with fixtures bound (#483)
 * they carry the fixtures' setup and teardown, which only the server can
 * resolve against the specs the caller may open. Above the cases sits the
 * suite's setup; inside a case, that case's own.
 *
 * Run suite (phase 3) opens the browser runner in place, above the cases,
 * for a member holding `api-test-suites.run`.
 */
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { ChevronRight, Download, Loader2, Play, RefreshCw, X } from 'lucide-vue-next'
import { renderCodeSample, type ApiOperationInfo, type ApiTestCase, type ApiTestSuiteFormat, type ApiTestSuiteResponse } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { Collapse } from '@/components/ui/collapse'
import { statusTone } from '@/lib/api-spec'
import { requestFile } from '@/api/client'
import { saveFile } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import ApiCode from './ApiCode.vue'
import ApiSuiteSetup from './ApiSuiteSetup.vue'
import ApiTestRun from './ApiTestRun.vue'
import ApiTone from './ApiTone.vue'
import type { SuiteFixtures } from './use-suite-fixtures'

const props = defineProps<{
  document: Record<string, unknown>
  workspaceId: string
  operation: ApiOperationInfo
  suite: ApiTestSuiteResponse | undefined
  generating: boolean
  failure: string | null
  loadError: string | null
  canGenerate: boolean
  canRun: boolean
  fixtures: SuiteFixtures
}>()
const emit = defineEmits<{ generate: [regenerate: boolean] }>()
const { t } = useI18n()
const uid = useId()

const groups = computed(() =>
  (['positive', 'negative'] as const)
    .map((kind) => ({ kind, cases: props.suite?.cases.filter((c) => c.kind === kind) ?? [] }))
    .filter((g) => g.cases.length > 0),
)
/** Only a suite whose requests carry a credential placeholder needs the note about filling one. */
const usesCredentials = computed(() =>
  !!props.suite?.cases.some((c) => [...c.request.headers, ...c.request.query].some((x) => x.value.some((p) => typeof p !== 'string'))),
)

const open = ref(new Set<string>())
function toggle(id: string) {
  const next = new Set(open.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  open.value = next
}

const running = ref(false)

const downloading = ref<ApiTestSuiteFormat | null>(null)
const downloadError = ref<string | null>(null)
async function download(format: ApiTestSuiteFormat) {
  downloading.value = format
  downloadError.value = null
  try {
    const { blob, filename } = await requestFile('get', '/v1/api-specs/{id}/test-suite', {
      path: { id: props.operation.documentId },
      query: { entityKey: props.operation.entityKey, format },
      config: { timeout: 0 },
    })
    saveFile(blob, filename ?? (format === 'curl' ? 'suite.sh' : 'suite.postman_collection.json'))
  } catch (e) {
    downloadError.value = (e as Error).message
  } finally {
    downloading.value = null
  }
}

/** One case's own fixtures, run just before it. */
const caseBound = (c: ApiTestCase) => props.fixtures.bindings.value?.cases[c.id] ?? []
const caseAddable = (c: ApiTestCase) => {
  const taken = new Set(caseBound(c).map((b) => b.fixtureId))
  return props.fixtures.library.value.filter((f) => !taken.has(f.documentId))
}
function bindToCase(c: ApiTestCase, e: Event) {
  const select = e.target as HTMLSelectElement
  if (select.value) void props.fixtures.bind(select.value, c.id)
  select.value = ''
}

const ruleLabel = (c: ApiTestCase) => t(`apiTests.rule.${c.rule}`)
const domId = (c: ApiTestCase) => `${uid}-${c.id.replace(/[^\w-]/gu, '_')}`
</script>

<template>
  <section class="kn-op-section" :aria-busy="generating">
    <h4 class="kn-op-section-title">
      {{ t('apiTests.title') }}
      <span v-if="suite" class="kn-op-count">{{ suite.cases.length }}</span>
    </h4>

    <div class="kn-op-pad space-y-4">
      <div v-if="suite" class="kn-ts-bar">
        <p class="kn-ts-meta">
          {{ t('apiTests.generated', { when: formatDateTime(suite.generatedAt), revision: suite.revisionId.slice(0, 8) }) }}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" :disabled="downloading !== null" @click="download('curl')">
            <Loader2 v-if="downloading === 'curl'" class="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <Download v-else class="size-3.5" aria-hidden="true" />
            {{ t('apiTests.downloadScript') }}
          </Button>
          <Button size="sm" variant="outline" :disabled="downloading !== null" @click="download('postman')">
            <Loader2 v-if="downloading === 'postman'" class="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <Download v-else class="size-3.5" aria-hidden="true" />
            {{ t('apiTests.downloadPostman') }}
          </Button>
          <Button
            size="sm"
            :variant="running ? 'secondary' : 'outline'"
            :disabled="generating || !canRun"
            :title="canRun ? undefined : t('apiTests.run.noCapability')"
            :aria-expanded="running"
            @click="running = !running"
          >
            <Play class="size-3.5" aria-hidden="true" />
            {{ t('apiTests.run.action') }}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            :disabled="generating || !canGenerate"
            :title="canGenerate ? undefined : t('apiTests.noCapability')"
            @click="emit('generate', true)"
          >
            <RefreshCw class="size-3.5" :class="generating && 'animate-spin motion-reduce:animate-none'" aria-hidden="true" />
            {{ t('apiTests.regenerate') }}
          </Button>
        </div>
      </div>

      <p v-if="downloadError" class="kn-ts-status kn-ts-status--error" role="alert">{{ downloadError }}</p>
      <p v-if="suite && !canRun" class="text-ui text-muted-foreground">{{ t('apiTests.run.noCapability') }}</p>

      <ApiTestRun
        v-if="suite && running && canRun"
        :document="document"
        :operation="operation"
        :workspace-id="workspaceId"
        :generated-at="suite.generatedAt"
        @close="running = false"
      />

      <ApiSuiteSetup
        :fixtures="fixtures"
        :can-bind="canGenerate"
        :has-suite="!!suite"
        :can-generate="canGenerate"
        :generating="generating"
        @generate="emit('generate', false)"
      />

      <p v-if="generating" class="kn-ts-status" role="status">
        <Loader2 class="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {{ suite ? t('apiTests.regenerating') : t('apiTests.generating') }}
      </p>
      <div v-else-if="failure !== null" class="kn-ts-status kn-ts-status--error" role="alert">
        <span>{{ failure || t('apiTests.failed') }}</span>
        <Button v-if="canGenerate" size="sm" variant="outline" @click="emit('generate', !!suite)">{{ t('apiTests.retry') }}</Button>
      </div>
      <p v-else-if="loadError" class="kn-ts-status kn-ts-status--error" role="alert">{{ loadError }}</p>

      <p v-if="usesCredentials" class="text-ui text-muted-foreground">{{ t('apiTests.credentials') }}</p>

      <div v-for="g in groups" :key="g.kind" class="kn-ts-group" :class="generating && 'opacity-60'">
        <h5 class="kn-ts-group-title">
          {{ t(`apiTests.kind.${g.kind}`) }}<span class="kn-op-count">{{ g.cases.length }}</span>
        </h5>
        <ul class="kn-ts-list">
          <li v-for="c in g.cases" :key="c.id" class="kn-ts-case">
            <button
              type="button"
              class="kn-ts-case-head"
              :aria-expanded="open.has(c.id)"
              :aria-controls="domId(c)"
              @click="toggle(c.id)"
            >
              <ChevronRight class="kn-ts-chevron" aria-hidden="true" />
              <ApiTone :tone="statusTone(c.expected.status)" size="sm" class="kn-ts-status-chip">{{ c.expected.status }}</ApiTone>
              <span class="kn-ts-name">{{ c.name }}</span>
              <span class="kn-ts-rule">
                {{ ruleLabel(c) }}<template v-if="c.target"> · <code>{{ c.target }}</code></template>
              </span>
            </button>
            <Collapse :open="open.has(c.id)">
              <div :id="domId(c)" class="kn-ts-case-body">
                <p v-if="c.description">{{ c.description }}</p>
                <p v-if="c.expected.expectation || c.expected.description" class="text-muted-foreground">
                  <span class="font-medium text-foreground">{{ t('apiTests.expect', { status: c.expected.status }) }}</span>
                  {{ c.expected.expectation || c.expected.description }}
                </p>
                <div v-if="caseBound(c).length || (canGenerate && caseAddable(c).length)" class="kn-ts-case-setup">
                  <span class="kn-ts-case-setup-label">{{ t('apiTests.setup.forCase') }}</span>
                  <span v-for="b in caseBound(c)" :key="b.fixtureId" class="kn-ts-case-chip">
                    <RouterLink v-if="b.title" :to="`/documents/${b.fixtureId}`">{{ b.title }}</RouterLink>
                    <span v-else>{{ t('apiTests.setup.hidden') }}</span>
                    <button
                      v-if="canGenerate"
                      type="button"
                      class="kn-ts-case-chip-x"
                      :disabled="fixtures.saving.value"
                      :aria-label="t('apiTests.setup.unbind', { name: b.title ?? t('apiTests.setup.hidden') })"
                      @click="fixtures.unbind(b.fixtureId, c.id)"
                    >
                      <X class="size-3" aria-hidden="true" />
                    </button>
                  </span>
                  <select
                    v-if="canGenerate && caseAddable(c).length"
                    class="kn-setup-select kn-ts-case-add"
                    :aria-label="t('apiTests.setup.addToCase', { name: c.name })"
                    :disabled="fixtures.saving.value"
                    @change="bindToCase(c, $event)"
                  >
                    <option value="" selected>{{ t('apiTests.setup.addPlaceholder') }}</option>
                    <option v-for="f in caseAddable(c)" :key="f.documentId" :value="f.documentId">{{ f.title }}</option>
                  </select>
                </div>
                <ApiCode v-if="open.has(c.id)" :code="renderCodeSample('curl', c.request)" lang="bash" :label="t('apiTests.curlLabel')" />
                <ApiCode
                  v-if="open.has(c.id) && c.expected.example != null"
                  :code="JSON.stringify(c.expected.example, null, 2)"
                  lang="json"
                  :caption="t('apiTests.expectedBody', { status: c.expected.status })"
                  max-height="14rem"
                />
              </div>
            </Collapse>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style>
.kn-ts-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem 1rem;
}
.kn-ts-meta {
  font-size: var(--kn-text-ui);
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
.kn-ts-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  font-size: var(--kn-text-sm);
  color: var(--muted-foreground);
}
.kn-ts-status--error {
  color: var(--destructive);
}
.kn-ts-group {
  transition: opacity 150ms ease-out;
}
.kn-ts-group-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
  font-size: var(--kn-text-sm);
  font-weight: 600;
  color: var(--foreground);
}
.kn-ts-list {
  border-top: 1px solid var(--border);
}
.kn-ts-case {
  border-bottom: 1px solid var(--border);
}
.kn-ts-case-head {
  display: grid;
  grid-template-columns: 1rem 3.25rem minmax(0, 1fr) minmax(0, auto);
  align-items: center;
  column-gap: 0.6rem;
  width: 100%;
  padding: 0.55rem 0.4rem;
  border-radius: 6px;
  text-align: start;
  font-size: var(--kn-text-sm);
  transition: background-color 120ms ease-out;
}
.kn-ts-case-head:hover {
  background: color-mix(in oklab, var(--kn-accent) 7%, transparent);
}
.kn-ts-case-head:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
.kn-ts-chevron {
  width: 0.95rem;
  height: 0.95rem;
  color: var(--muted-foreground);
  transition: transform var(--collapse-duration) var(--snap-ease);
}
.kn-ts-case-head[aria-expanded='true'] .kn-ts-chevron {
  transform: rotate(90deg);
}
.kn-ts-status-chip {
  justify-self: start;
  font-variant-numeric: tabular-nums;
}
.kn-ts-name {
  min-width: 0;
  color: var(--foreground);
  overflow-wrap: anywhere;
}
.kn-ts-rule {
  justify-self: end;
  min-width: 0;
  font-size: var(--kn-text-xs);
  color: var(--muted-foreground);
  text-align: end;
  overflow-wrap: anywhere;
}
.kn-ts-rule code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: color-mix(in oklab, var(--foreground) 78%, var(--card));
}
.kn-ts-case-body {
  display: grid;
  gap: 0.6rem;
  padding: 0.15rem 0.4rem 0.9rem 2rem;
  font-size: var(--kn-text-sm);
  line-height: 1.55;
}
.kn-ts-case-setup {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  font-size: var(--kn-text-xs);
}
.kn-ts-case-setup-label {
  color: var(--muted-foreground);
}
.kn-ts-case-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0.1rem 0.25rem 0.1rem 0.55rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--foreground);
}
.kn-ts-case-chip a:hover {
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.kn-ts-case-chip-x {
  display: inline-grid;
  place-items: center;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 999px;
  color: var(--muted-foreground);
}
.kn-ts-case-chip-x:hover {
  background: color-mix(in oklab, var(--kn-accent) 10%, transparent);
  color: var(--foreground);
}
.kn-ts-case-chip-x:focus-visible,
.kn-ts-case-chip a:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}
.kn-ts-case-add {
  flex: 0 1 14rem;
  height: 1.75rem;
  font-size: var(--kn-text-xs);
}
@container kn-op (max-width: 34rem) {
  .kn-ts-case-head {
    grid-template-columns: 1rem 3.25rem minmax(0, 1fr);
    row-gap: 0.2rem;
  }
  .kn-ts-rule {
    grid-column: 3;
    justify-self: start;
    text-align: start;
  }
  .kn-ts-case-body {
    padding-left: 0.4rem;
  }
}
@media (prefers-reduced-motion: reduce) {
  .kn-ts-chevron,
  .kn-ts-group {
    transition: none;
  }
}
</style>
