<script setup lang="ts">
/**
 * One operation's QA test suite (#468), as a section of the open card: where
 * it came from, the two exports, and the cases grouped positive / negative.
 * A case is one row — expected status, name, rule — that opens in place to
 * what it checks and its curl command.
 *
 * Both exports are printed here from the stored cases by the same contracts
 * printers the API's `?format=` uses, so the file and the screen cannot
 * disagree, and a download is not a second request.
 */
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronRight, Copy, Download, Loader2, RefreshCw } from 'lucide-vue-next'
import { renderCodeSample, testSuiteCurl, testSuitePostman, type ApiOperationInfo, type ApiTestCase, type ApiTestSuiteResponse } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { Collapse } from '@/components/ui/collapse'
import { statusTone } from '@/lib/api-spec'
import { saveFile } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { useCopy } from '@/lib/use-copy'
import ApiCode from './ApiCode.vue'
import ApiTone from './ApiTone.vue'

const props = defineProps<{
  operation: ApiOperationInfo
  specTitle: string
  suite: ApiTestSuiteResponse | undefined
  generating: boolean
  failure: string | null
  loadError: string | null
  canGenerate: boolean
}>()
const emit = defineEmits<{ generate: [regenerate: boolean] }>()
const { t } = useI18n()
const { state: copyState, copy } = useCopy()
const uid = useId()

const groups = computed(() =>
  (['positive', 'negative'] as const)
    .map((kind) => ({ kind, cases: props.suite?.cases.filter((c) => c.kind === kind) ?? [] }))
    .filter((g) => g.cases.length > 0),
)
const label = computed(() => `${props.operation.method ?? ''} ${props.operation.path}`)
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

function downloadPostman() {
  if (!props.suite) return
  const collection = testSuitePostman({ title: `${props.specTitle} — ${label.value}`, folder: label.value, cases: props.suite.cases })
  const name = label.value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
  saveFile(new Blob([JSON.stringify(collection, null, 2)], { type: 'application/json' }), `${name}.postman_collection.json`)
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
          <Button size="sm" variant="outline" @click="copy(testSuiteCurl(suite.cases))">
            <Check v-if="copyState === 'copied'" class="size-3.5" aria-hidden="true" />
            <Copy v-else class="size-3.5" aria-hidden="true" />
            {{ copyState === 'copied' ? t('apiTests.copied') : copyState === 'failed' ? t('apiTests.copyFailed') : t('apiTests.copyCurl') }}
          </Button>
          <Button size="sm" variant="outline" @click="downloadPostman">
            <Download class="size-3.5" aria-hidden="true" />
            {{ t('apiTests.downloadPostman') }}
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
