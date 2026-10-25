<script setup lang="ts">
/**
 * The browser runner (#483, phase 3): one operation's whole QA suite against
 * a real server — setup once, every case (negative first, each between its
 * own setup and teardown), then teardown, which runs after a failure or Stop
 * too. The order and the rules are `runTestPlan`'s, in contracts, so an
 * agent walking the same plan with its own client gets the same results.
 *
 * Two routes out, as in the try console: this browser, or the proxy's
 * capability-gated twin (`POST …/test-run/send`), one call per step against
 * the spec that defines it. A 429 from the proxy holds the row and resumes.
 *
 * The values a run asks for live in this component and nowhere else: never
 * stored, sent only in the requests that use them. Credential slots start
 * from the Try-it console's values (read, never written back), and each
 * spec's requests go to the server picked there.
 *
 * A third route, **Server** (phase 5), while the workspace's runner is on:
 * the worker runs the plan with a test environment's values, which never
 * reach this page. The run is polled until it settles and drawn in the same
 * table, from the plan and results stored on it; the suite's recent runs
 * open the same way.
 */
import { computed, onBeforeUnmount, reactive, ref, useId, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { AlertTriangle, CheckCircle2, CircleDashed, ClipboardCheck, Loader2, MinusCircle, Play, Square, X, XCircle } from 'lucide-vue-next'
import {
  apiServerOptions,
  isSecretName,
  runTestPlan,
  testRunCounts,
  testRunKey,
  type ApiOperationInfo,
  type ApiSettingsResponse,
  type ApiTestRunDetail,
  type ListApiTestEnvironmentsResponse,
  type ListApiTestRunsResponse,
  type TestRunCall,
  type TestRunOutcome,
  type TestRunPlan,
  type TestRunRequest,
  type TestRunResponse,
  type TestRunResult,
  type TestRunStep,
  type TestRunTarget,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { isApiRequestError } from '@/api/http'
import { formatNumber, formatRelative } from '@/lib/format'
import { statusTone } from '@/lib/api-spec'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import ApiTone from './ApiTone.vue'
import { credentialSlots, useTryEnv, type TryVia } from './use-try-env'

const props = defineProps<{
  document: Record<string, unknown>
  operation: ApiOperationInfo
  workspaceId: string
  /** The suite's generation time: a regenerated suite is a new plan. */
  generatedAt: string
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const uid = useId()

const planQuery = useQuery(
  computed(() => {
    const o = apiQueryOptions('/v1/api-specs/{id}/test-run-plan', {
      path: { id: props.operation.documentId },
      query: { entityKey: props.operation.entityKey },
    })
    return { ...o, queryKey: [...o.queryKey, props.generatedAt], retry: false, staleTime: Infinity }
  }),
)
const plan = computed(() => planQuery.data.value as TestRunPlan | undefined)

// ---- Where the requests go ------------------------------------------------------

const settingsQuery = useQuery(apiQueryOptions('/v1/workspaces/{id}/api-settings', { path: { id: props.workspaceId } }))
const proxyOff = computed(() => (settingsQuery.data.value as ApiSettingsResponse | undefined)?.tryProxy.effective === 'off')
const runnerOn = computed(() => (settingsQuery.data.value as ApiSettingsResponse | undefined)?.testRunner.effective === 'on')
const suiteEnv = useTryEnv(props.operation.documentId)
type Via = TryVia | 'server'
const chosenVia = ref<Via>(suiteEnv.via)
const via = computed<Via>(() => {
  if (chosenVia.value === 'server' && runnerOn.value) return 'server'
  return chosenVia.value === 'proxy' && settingsQuery.data.value && !proxyOff.value ? 'proxy' : 'browser'
})
const routes = computed<Via[]>(() => (runnerOn.value ? ['browser', 'proxy', 'server'] : ['browser', 'proxy']))

const servers = computed(() => apiServerOptions(props.document).filter((s) => /^https?:\/\//iu.test(s.url)))
const server = ref(servers.value.find((s) => s.url === suiteEnv.serverUrl)?.url ?? servers.value[0]?.url ?? '')

/** The plan's URL on the server picked for its spec: here for the suite's, in Try it for any other. */
function rebase(target: TestRunTarget, url: string): string {
  const picked = (target.documentId === props.operation.documentId ? server.value : useTryEnv(target.documentId).serverUrl)?.replace(/\/+$/u, '')
  if (!picked || !target.server || picked === target.server || !url.startsWith(target.server)) return url
  return picked + url.slice(target.server.length)
}

// ---- What a run asks for --------------------------------------------------------

interface Field {
  name: string
  secret: boolean
  fromTryIt: boolean
}
const values = reactive<Record<string, string>>({})
const fields = ref<Field[]>([])

/** One field per value the plan names; a credential slot starts from the first spec's Try-it value that has one. */
function prepare(p: TestRunPlan) {
  const docs = [props.operation.documentId, ...allCalls(p).map((s) => s.target.documentId)]
  const slots = [...new Set(docs)].map((id) => credentialSlots(useTryEnv(id)))
  const out: Field[] = []
  for (const name of p.secrets) {
    const prefill = slots.map((s) => s[name]).find((v) => !!v) ?? ''
    if (values[name] === undefined) values[name] = prefill
    out.push({ name, secret: true, fromTryIt: !!prefill && values[name] === prefill })
  }
  for (const [name, def] of Object.entries(p.inputs)) {
    const key = `input.${name}`
    if (values[key] === undefined) values[key] = def === null ? '' : String(def)
    out.push({ name: key, secret: false, fromTryIt: false })
  }
  fields.value = out
}

const allCalls = (p: TestRunPlan): TestRunCall[] =>
  [...p.setup, ...p.teardown, ...p.cases.flatMap((c) => [...c.setup, ...c.teardown])].filter((s): s is TestRunCall => s.kind === 'call')

// ---- On the server (phase 5) -----------------------------------------------------

const envQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/workspaces/{id}/test-environments', { path: { id: props.workspaceId } }),
    enabled: runnerOn.value,
  })),
)
const environments = computed(() => (envQuery.data.value as ListApiTestEnvironmentsResponse | undefined)?.environments ?? [])
const environmentId = ref('')
watch(environments, (list) => {
  if (!list.some((e) => e.id === environmentId.value)) environmentId.value = list[0]?.id ?? ''
})

const historyQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/api-specs/{id}/test-runs', { path: { id: props.operation.documentId }, query: { entityKey: props.operation.entityKey } }),
    refetchInterval: (q: { state: { data?: unknown } }) =>
      ((q.state.data as ListApiTestRunsResponse | undefined)?.runs ?? []).some((r) => r.status === 'queued' || r.status === 'running') ? 3000 : false,
  })),
)
const history = computed(() => (historyQuery.data.value as ListApiTestRunsResponse | undefined)?.runs ?? [])

/** The server run on show: one just queued, or one picked from the history. Polled until it settles. */
const runId = ref<string | null>(null)
const runQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/api-specs/{id}/test-runs/{runId}', { path: { id: props.operation.documentId, runId: runId.value ?? '' } }),
    enabled: runId.value !== null,
    refetchInterval: (q: { state: { data?: unknown } }) => {
      const status = (q.state.data as ApiTestRunDetail | undefined)?.status
      return status === undefined || status === 'queued' || status === 'running' ? 2000 : false
    },
  })),
)
const serverRun = computed(() => (runId.value ? ((runQuery.data.value as ApiTestRunDetail | undefined) ?? null) : null))
const serverBusy = computed(() => serverRun.value?.status === 'queued' || serverRun.value?.status === 'running')
const starting = ref(false)
const serverError = ref<string | null>(null)

async function startOnServer() {
  if (!environmentId.value || starting.value) return
  starting.value = true
  serverError.value = null
  try {
    const run = await api.post('/v1/api-specs/{id}/test-runs', {
      path: { id: props.operation.documentId },
      body: { entityKey: props.operation.entityKey, environmentId: environmentId.value },
    })
    results.value = {}
    runId.value = run.id
    void historyQuery.refetch()
  } catch (e) {
    serverError.value = errorMessage(e, t)
  } finally {
    starting.value = false
  }
}

function openRun(id: string) {
  results.value = {}
  runId.value = id
}

watch(serverRun, (run) => {
  if (run) results.value = run.results
  if (run && !serverBusy.value) void historyQuery.refetch()
})

/** The plan the table draws: a server run's own (the suite may have moved on since), or the live one. */
const shownPlan = computed(() => serverRun.value?.plan ?? plan.value)

// ---- Running --------------------------------------------------------------------

type Phase = 'idle' | 'running' | 'stopping' | 'done'
const phase = ref<Phase>('idle')
const results = ref<Record<string, TestRunResult>>({})
const current = ref<string | null>(null)
const waiting = ref<{ key: string; seconds: number } | null>(null)
let abort: AbortController | null = null
let alive = true
onBeforeUnmount(() => {
  alive = false
  abort?.abort()
})

const BROWSER_TIMEOUT_MS = 30_000

async function viaBrowser(req: TestRunRequest): Promise<TestRunResponse> {
  let res: Response
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: req.headers.map((h) => [h.name, h.value] as [string, string]),
      body: req.method === 'GET' || req.method === 'HEAD' ? null : req.body,
      credentials: 'omit',
      signal: AbortSignal.timeout(BROWSER_TIMEOUT_MS),
    })
  } catch (e) {
    // A CORS refusal and a dead host are the same TypeError to a page.
    if (e instanceof TypeError) throw new Error(t('apiTests.run.reason.cors', { host: hostOf(req.url) }))
    throw e
  }
  return { status: res.status, headers: [...res.headers.entries()].map(([name, value]) => ({ name, value })), body: await res.text() }
}

/** Through the proxy; a 429 waits out `retryAfter` and sends again, so a long suite finishes rather than fails. */
async function viaProxy(key: string, target: TestRunTarget, req: TestRunRequest): Promise<TestRunResponse> {
  for (;;) {
    try {
      const res = await api.post('/v1/api-specs/{id}/test-run/send', {
        path: { id: target.documentId },
        body: {
          revisionId: target.revisionId,
          entityKey: target.entityKey,
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? null : req.body,
        },
      })
      // A binary body is base64 and captures nothing; the status still counts.
      return { status: res.status, headers: res.headers, body: res.encoding === 'utf8' ? res.body : '', durationMs: res.durationMs }
    } catch (e) {
      if (!(isApiRequestError(e) && e.status === 429) || !alive) throw new Error(errorMessage(e, t))
      await countdown(key, Number(e.details?.retryAfter) || 60)
    }
  }
}

async function countdown(key: string, seconds: number) {
  for (let s = seconds; s > 0 && alive; s--) {
    waiting.value = { key, seconds: s }
    await new Promise((r) => setTimeout(r, 1000))
  }
  waiting.value = null
}

async function start() {
  if (via.value === 'server') return startOnServer()
  const p = plan.value
  if (!p || phase.value === 'running' || phase.value === 'stopping') return
  runId.value = null
  results.value = {}
  phase.value = 'running'
  abort = new AbortController()
  const run: Record<string, string> = {}
  for (const f of fields.value) run[f.name] = values[f.name] ?? ''
  try {
    await runTestPlan(
      p,
      run,
      (key, target, req) => {
        current.value = key
        const out = { ...req, url: rebase(target, req.url) }
        return via.value === 'proxy' ? viaProxy(key, target, out) : viaBrowser(out)
      },
      (key, r) => {
        if (alive) results.value = { ...results.value, [key]: r }
      },
      abort.signal,
    )
  } finally {
    current.value = null
    waiting.value = null
    if (alive) phase.value = 'done'
  }
}

function stop() {
  if (phase.value !== 'running') return
  abort?.abort()
  phase.value = 'stopping'
}

// ---- Rows -----------------------------------------------------------------------

type RowOutcome = TestRunOutcome | 'running' | 'pending'
interface Row {
  key: string
  label: string
  note: string | null
  expect: string | null
  nested: string | null
}
interface Section {
  id: 'setup' | 'cases' | 'teardown'
  rows: Row[]
}

const stepRow = (key: string, s: TestRunStep, nested: string | null = null): Row => ({
  key,
  label: s.label,
  note: s.kind === 'manual' ? s.note : null,
  expect: s.kind === 'call' ? s.expect : null,
  nested,
})

const sections = computed<Section[]>(() => {
  const p = shownPlan.value
  if (!p) return []
  const out: Section[] = []
  if (p.setup.length) out.push({ id: 'setup', rows: p.setup.map((s) => stepRow(testRunKey.setup(s), s)) })
  out.push({
    id: 'cases',
    rows: p.cases.flatMap((c) => [
      { key: testRunKey.case(c), label: c.name, note: null, expect: c.expect, nested: null },
      ...c.setup.map((s) => stepRow(testRunKey.caseSetup(c, s), s, t('apiTests.run.section.setup'))),
      ...c.teardown.map((s) => stepRow(testRunKey.caseTeardown(c, s), s, t('apiTests.run.section.teardown'))),
    ]),
  })
  if (p.teardown.length) out.push({ id: 'teardown', rows: p.teardown.map((s) => stepRow(testRunKey.teardown(s), s)) })
  return out
})

function outcomeOf(key: string): RowOutcome | null {
  const r = results.value[key]
  if (r) return r.outcome
  if (current.value === key) return 'running'
  return phase.value === 'running' || phase.value === 'stopping' || serverBusy.value ? 'pending' : null
}

const OUTCOME_ICON = {
  pass: CheckCircle2,
  fail: XCircle,
  error: AlertTriangle,
  skipped: MinusCircle,
  'not-run': MinusCircle,
  manual: ClipboardCheck,
  running: Loader2,
  pending: CircleDashed,
} as const

function reasonText(r: TestRunResult | undefined): string | null {
  const reason = r?.reason
  if (!reason) return null
  if (reason.startsWith('missing:')) {
    return r.outcome === 'skipped' ? t('apiTests.run.reason.skipped') : t('apiTests.run.reason.missing', { names: reason.slice(8).split(',').join(', ') })
  }
  if (reason.startsWith('capture:')) return t('apiTests.run.reason.capture', { name: reason.slice(8) })
  if (reason === 'setup') return t('apiTests.run.reason.setup')
  return reason
}

const capturesOf = (key: string) =>
  Object.entries(results.value[key]?.captures ?? {}).map(([name, value]) => ({ name, value: isSecretName(name) ? null : value }))

const summary = computed(() => (shownPlan.value ? testRunCounts(shownPlan.value, results.value) : { passed: 0, failed: 0, notRun: 0 }))

/** Whether the table shows: a browser run started, or a server run is on show. */
const showResults = computed(() => phase.value !== 'idle' || serverRun.value !== null)

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

watch(plan, (p) => p && prepare(p), { immediate: true })
</script>

<template>
  <section class="kn-run" :aria-labelledby="`${uid}-title`" :aria-busy="phase === 'running' || phase === 'stopping'">
    <header class="kn-run-head">
      <h5 :id="`${uid}-title`" class="kn-run-title">{{ t('apiTests.run.title') }}</h5>
      <Button size="icon-sm" variant="ghost" :disabled="phase === 'running' || phase === 'stopping'" :aria-label="t('apiTests.run.close')" @click="emit('close')">
        <X class="size-4" aria-hidden="true" />
      </Button>
    </header>

    <p v-if="planQuery.isPending.value" class="kn-ts-status" role="status">
      <Loader2 class="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />{{ t('apiTests.run.loading') }}
    </p>
    <p v-else-if="planQuery.error.value" class="kn-ts-status kn-ts-status--error" role="alert">{{ errorMessage(planQuery.error.value, t) }}</p>

    <template v-else-if="plan">
      <p class="kn-run-intro">{{ t('apiTests.run.intro') }}</p>

      <form class="kn-run-form" @submit.prevent="start">
        <div class="kn-run-where">
          <div class="flex items-center gap-2">
            <span :id="`${uid}-via`" class="text-ui text-muted-foreground">{{ t('apiTry.via.label') }}</span>
            <div role="radiogroup" :aria-labelledby="`${uid}-via`" class="kn-run-seg">
              <button
                v-for="v in routes"
                :key="v"
                type="button"
                role="radio"
                :aria-checked="via === v"
                :aria-disabled="(v === 'proxy' && proxyOff) || phase === 'running' || undefined"
                :aria-describedby="v === 'proxy' && proxyOff ? `${uid}-proxy-why` : undefined"
                :data-active="via === v || undefined"
                @click="phase !== 'running' && !(v === 'proxy' && proxyOff) && (chosenVia = v)"
              >
                {{ v === 'server' ? t('apiTests.run.viaServer') : t(`apiTry.via.${v}`) }}
              </button>
            </div>
          </div>
          <label v-if="via === 'server'" class="kn-run-server">
            <span class="text-ui text-muted-foreground">{{ t('apiTests.run.environment') }}</span>
            <select v-if="environments.length" v-model="environmentId" class="kn-setup-select" :disabled="starting || serverBusy">
              <option v-for="e in environments" :key="e.id" :value="e.id">{{ e.server ? `${e.name} · ${e.server}` : e.name }}</option>
            </select>
          </label>
          <label v-else-if="servers.length > 1" class="kn-run-server">
            <span class="text-ui text-muted-foreground">{{ t('apiTests.run.server') }}</span>
            <select v-model="server" class="kn-setup-select" :disabled="phase === 'running'">
              <option v-for="s in servers" :key="s.url" :value="s.url">{{ s.url }}</option>
            </select>
          </label>
          <span v-else-if="servers.length" class="kn-run-server-text">{{ servers[0].url }}</span>
        </div>
        <p v-if="via === 'server'" class="text-ui text-muted-foreground">
          <template v-if="envQuery.isSuccess.value && !environments.length">
            {{ t('apiTests.run.noEnvironments') }}
            <RouterLink to="/qa?tab=environments" class="text-primary underline underline-offset-2">{{ t('apiTests.run.manageEnvironments') }}</RouterLink>
          </template>
          <template v-else>{{ t('apiTests.run.serverNote') }}</template>
        </p>
        <p v-if="proxyOff" :id="`${uid}-proxy-why`" class="text-ui text-muted-foreground">{{ t('apiTry.proxyBlocked.off') }}</p>

        <fieldset v-if="via !== 'server'" class="kn-run-values" :disabled="phase === 'running' || phase === 'stopping'">
          <legend class="kn-run-legend">{{ t('apiTests.run.values') }}</legend>
          <p v-if="!fields.length" class="text-ui text-muted-foreground">{{ t('apiTests.run.noValues') }}</p>
          <div v-for="f in fields" :key="f.name" class="kn-run-field">
            <label :for="`${uid}-v-${f.name}`" class="kn-run-field-label">
              <code>{{ f.name }}</code>
              <span class="kn-run-field-tag">{{ f.secret ? t('apiTests.run.secret') : t('apiTests.run.input') }}</span>
              <span v-if="f.fromTryIt" class="kn-run-field-tag">{{ t('apiTests.run.fromTryIt') }}</span>
            </label>
            <Input
              :id="`${uid}-v-${f.name}`"
              v-model="values[f.name]"
              :type="f.secret ? 'password' : 'text'"
              autocomplete="off"
              spellcheck="false"
              class="h-8 font-mono text-sm"
            />
          </div>
          <p v-if="fields.some((f) => f.secret)" class="text-xs text-muted-foreground">{{ t('apiTests.run.emptyNote') }}</p>
        </fieldset>

        <div class="flex flex-wrap items-center gap-2">
          <Button v-if="phase === 'running' || phase === 'stopping'" type="button" size="sm" variant="outline" :disabled="phase === 'stopping'" @click="stop">
            <Square class="size-3.5" aria-hidden="true" />{{ t('apiTests.run.stop') }}
          </Button>
          <Button v-else-if="via === 'server'" type="submit" size="sm" :disabled="!environmentId || starting || serverBusy">
            <Loader2 v-if="starting || serverBusy" class="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <Play v-else class="size-3.5" aria-hidden="true" />{{ t('apiTests.run.startOnServer') }}
          </Button>
          <Button v-else type="submit" size="sm">
            <Play class="size-3.5" aria-hidden="true" />{{ phase === 'done' ? t('apiTests.run.again') : t('apiTests.run.start') }}
          </Button>
          <p v-if="serverError" class="kn-run-summary text-destructive" role="alert">{{ serverError }}</p>
          <p v-else-if="serverRun" class="kn-run-summary" role="status">
            <template v-if="serverBusy">{{ t(`apiTests.run.serverStatus.${serverRun.status}`) }}</template>
            <template v-else-if="serverRun.status === 'error'">{{ t('apiTests.run.serverStatus.error') }}: {{ serverRun.error }}</template>
            <template v-else>{{ t('apiTests.run.summary', summary) }}</template>
          </p>
          <p v-else-if="phase !== 'idle'" class="kn-run-summary" role="status">
            <template v-if="waiting">{{ t('apiTests.run.waiting', { seconds: waiting.seconds }) }}</template>
            <template v-else-if="phase === 'stopping'">{{ t('apiTests.run.stopping') }}</template>
            <template v-else-if="phase === 'running'">{{ t('apiTests.run.running') }}</template>
            <template v-else>{{ t('apiTests.run.summary', summary) }}</template>
          </p>
        </div>
      </form>

      <div v-if="showResults" class="kn-run-results">
        <div class="kn-run-row kn-run-row--head" aria-hidden="true">
          <span />
          <span>{{ t('apiTests.run.col.step') }}</span>
          <span>{{ t('apiTests.run.col.expected') }}</span>
          <span>{{ t('apiTests.run.col.actual') }}</span>
          <span class="text-end">{{ t('apiTests.run.col.time') }}</span>
        </div>
        <section v-for="s in sections" :key="s.id">
          <h6 class="kn-run-section">{{ t(`apiTests.run.section.${s.id}`) }}</h6>
          <ol>
            <li
              v-for="row in s.rows"
              :key="row.key"
              class="kn-run-row"
              :data-outcome="outcomeOf(row.key) ?? undefined"
              :data-nested="row.nested ? '' : undefined"
            >
              <span class="kn-run-outcome">
                <component
                  :is="OUTCOME_ICON[outcomeOf(row.key) ?? 'pending']"
                  class="size-4"
                  :class="outcomeOf(row.key) === 'running' && 'animate-spin motion-reduce:animate-none'"
                  aria-hidden="true"
                />
                <span class="sr-only">{{ t(`apiTests.run.outcome.${outcomeOf(row.key) ?? 'pending'}`) }}</span>
              </span>
              <span class="kn-run-name">
                <span v-if="row.nested" class="kn-run-nested">{{ row.nested }} · </span>{{ row.label }}
                <span v-if="results[row.key] && results[row.key].outcome !== 'pass'" class="kn-run-word">
                  {{ t(`apiTests.run.outcome.${results[row.key].outcome}`) }}
                </span>
                <span v-if="row.note" class="kn-run-note">{{ row.note }}</span>
                <span v-if="waiting?.key === row.key" class="kn-run-note">{{ t('apiTests.run.waiting', { seconds: waiting.seconds }) }}</span>
                <span v-if="reasonText(results[row.key])" class="kn-run-reason">{{ reasonText(results[row.key]) }}</span>
                <span v-if="capturesOf(row.key).length" class="kn-run-captures">
                  <span class="sr-only">{{ t('apiTests.run.col.captured') }}:</span>
                  <code v-for="c in capturesOf(row.key)" :key="c.name" :title="c.value ?? undefined">
                    {{ c.name }} = <span :class="c.value === null && 'kn-run-hidden'">{{ c.value ?? t('apiTests.run.hidden') }}</span>
                  </code>
                </span>
              </span>
              <span class="kn-run-cell kn-run-exp">
                <ApiTone v-if="row.expect" :tone="statusTone(row.expect)" size="sm">{{ row.expect }}</ApiTone>
              </span>
              <span class="kn-run-cell kn-run-act">
                <ApiTone v-if="results[row.key]?.status != null" :tone="statusTone(String(results[row.key].status))" size="sm" variant="solid">
                  {{ results[row.key].status }}
                </ApiTone>
              </span>
              <span class="kn-run-time">
                <template v-if="results[row.key]?.durationMs != null">{{ t('apiTry.ms', { n: formatNumber(results[row.key].durationMs!) }) }}</template>
              </span>
            </li>
          </ol>
        </section>
      </div>

      <section v-if="history.length" class="kn-run-history" :aria-labelledby="`${uid}-history`">
        <h6 :id="`${uid}-history`" class="kn-run-section">{{ t('apiTests.run.history') }}</h6>
        <ol>
          <li v-for="r in history" :key="r.id">
            <button type="button" class="kn-run-past" :data-active="runId === r.id || undefined" :aria-current="runId === r.id || undefined" @click="openRun(r.id)">
              <component
                :is="r.status === 'passed' ? CheckCircle2 : r.status === 'failed' ? XCircle : r.status === 'error' ? AlertTriangle : Loader2"
                class="size-4 shrink-0"
                :class="[`kn-run-past--${r.status}`, (r.status === 'queued' || r.status === 'running') && 'animate-spin motion-reduce:animate-none']"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 truncate">
                <span class="sr-only">{{ t(`apiTests.run.serverStatus.${r.status}`) }}: </span>
                <template v-if="r.status === 'passed' || r.status === 'failed'">{{ t('apiTests.run.summary', r.counts) }}</template>
                <template v-else>{{ t(`apiTests.run.serverStatus.${r.status}`) }}</template>
              </span>
              <span class="kn-run-past-meta">{{ r.environment?.name ?? t('apiTests.run.environmentGone') }} · {{ formatRelative(r.createdAt) }}</span>
            </button>
          </li>
        </ol>
      </section>
    </template>
  </section>
</template>

<style>
.kn-run-history ol {
  display: grid;
  gap: 1px;
}
.kn-run-past {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 0.35rem 0.5rem;
  border-radius: 6px;
  font-size: var(--kn-text-ui);
  text-align: start;
  color: var(--foreground);
  outline: none;
}
.kn-run-past:hover,
.kn-run-past[data-active] {
  background: color-mix(in oklab, var(--muted) 70%, transparent);
}
.kn-run-past:focus-visible {
  box-shadow: 0 0 0 2px var(--ring);
}
.kn-run-past-meta {
  font-size: var(--kn-text-caption);
  color: var(--muted-foreground);
}
.kn-run-past--passed {
  color: color-mix(in oklab, var(--kn-panel-tip) 75%, var(--foreground));
}
.kn-run-past--failed,
.kn-run-past--error {
  color: color-mix(in oklab, var(--kn-panel-caution) 75%, var(--foreground));
}
.kn-run-past--queued,
.kn-run-past--running {
  color: var(--muted-foreground);
}
.kn-run {
  display: grid;
  gap: 0.85rem;
  padding: 0.85rem 0.9rem 0.95rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in oklab, var(--muted) 45%, var(--card));
}
.kn-run-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.kn-run-title {
  font-size: var(--kn-text-sm);
  font-weight: 600;
  color: var(--foreground);
}
.kn-run-intro {
  max-width: 70ch;
  font-size: var(--kn-text-ui);
  line-height: 1.55;
  color: var(--muted-foreground);
}
.kn-run-form {
  display: grid;
  gap: 0.85rem;
}
.kn-run-where {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1.25rem;
}
.kn-run-seg {
  display: inline-flex;
  height: 1.9rem;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--muted);
}
.kn-run-seg > button {
  padding-inline: 0.7rem;
  border-radius: 5px;
  font-size: var(--kn-text-ui);
  color: var(--muted-foreground);
  transition: background-color 150ms ease-out, color 150ms ease-out;
}
.kn-run-seg > button:hover:not([aria-disabled='true']) {
  color: var(--foreground);
}
.kn-run-seg > button[data-active] {
  background: var(--card);
  color: var(--foreground);
  font-weight: 500;
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.08);
}
.kn-run-seg > button[aria-disabled='true']:not([data-active]) {
  opacity: 0.5;
  cursor: not-allowed;
}
.kn-run-seg > button:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}
.kn-run-server {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}
.kn-run-server .kn-setup-select {
  max-width: 22rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.kn-run-server-text {
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--kn-text-ui);
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}
.kn-run-values {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
  gap: 0.6rem 1rem;
  min-width: 0;
}
.kn-run-legend {
  margin-bottom: 0.4rem;
  font-size: var(--kn-text-ui);
  font-weight: 600;
  color: var(--foreground);
}
.kn-run-values > p {
  grid-column: 1 / -1;
}
.kn-run-field {
  display: grid;
  gap: 0.3rem;
  min-width: 0;
}
.kn-run-field-label {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.2rem 0.45rem;
  font-size: var(--kn-text-ui);
}
.kn-run-field-label code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--foreground);
  overflow-wrap: anywhere;
}
.kn-run-field-tag {
  font-size: var(--kn-text-xs);
  color: var(--muted-foreground);
}
.kn-run-summary {
  font-size: var(--kn-text-ui);
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
.kn-run-results {
  border-top: 1px solid var(--border);
}
.kn-run-section {
  padding: 0.7rem 0.4rem 0.25rem;
  font-size: var(--kn-text-xs);
  font-weight: 600;
  color: var(--muted-foreground);
}
.kn-run-row {
  display: grid;
  grid-template-columns: 1.25rem minmax(0, 1fr) 3.4rem 3.4rem 4.25rem;
  align-items: start;
  column-gap: 0.6rem;
  padding: 0.45rem 0.4rem;
  border-bottom: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
  font-size: var(--kn-text-sm);
}
.kn-run-row--head {
  padding-block: 0.4rem;
  font-size: var(--kn-text-xs);
  color: var(--muted-foreground);
}
.kn-run-row[data-nested] .kn-run-name {
  padding-inline-start: 1rem;
  color: var(--muted-foreground);
}
.kn-run-outcome {
  display: grid;
  place-items: center;
  height: 1.25rem;
  color: var(--muted-foreground);
}
.kn-run-row[data-outcome='pass'] .kn-run-outcome {
  color: var(--color-panel-tip-ink);
}
.kn-run-row[data-outcome='fail'] .kn-run-outcome,
.kn-run-row[data-outcome='error'] .kn-run-outcome {
  color: var(--color-panel-caution-ink);
}
.kn-run-row[data-outcome='manual'] .kn-run-outcome,
.kn-run-row[data-outcome='running'] .kn-run-outcome {
  color: var(--color-panel-note-ink);
}
.kn-run-row[data-outcome='pending'] .kn-run-name,
.kn-run-row[data-outcome='not-run'] .kn-run-name {
  color: var(--muted-foreground);
}
.kn-run-name {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.15rem 0.5rem;
  min-width: 0;
  line-height: 1.45;
  color: var(--foreground);
  overflow-wrap: anywhere;
}
.kn-run-nested {
  color: var(--muted-foreground);
}
.kn-run-word {
  font-size: var(--kn-text-xs);
  font-weight: 600;
  color: var(--muted-foreground);
}
.kn-run-row[data-outcome='fail'] .kn-run-word,
.kn-run-row[data-outcome='error'] .kn-run-word {
  color: var(--color-panel-caution-ink);
}
.kn-run-note,
.kn-run-reason {
  flex-basis: 100%;
  font-size: var(--kn-text-xs);
  color: var(--muted-foreground);
}
.kn-run-reason {
  color: var(--color-panel-caution-ink);
}
.kn-run-captures {
  display: flex;
  flex-wrap: wrap;
  flex-basis: 100%;
  gap: 0.25rem;
}
.kn-run-captures code {
  max-width: 100%;
  padding: 0.05rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--kn-text-xs);
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kn-run-hidden {
  font-family: var(--font-sans, inherit);
  font-style: italic;
  color: var(--muted-foreground);
}
.kn-run-cell {
  display: flex;
  align-items: center;
  height: 1.25rem;
}
.kn-run-time {
  height: 1.25rem;
  font-size: var(--kn-text-xs);
  line-height: 1.25rem;
  color: var(--muted-foreground);
  text-align: end;
  font-variant-numeric: tabular-nums;
}
@container kn-op (max-width: 34rem) {
  .kn-run-row {
    grid-template-columns: 1.25rem auto auto minmax(0, 1fr);
    row-gap: 0.25rem;
  }
  .kn-run-row--head {
    display: none;
  }
  .kn-run-name {
    grid-column: 2 / -1;
    grid-row: 1;
  }
  .kn-run-exp {
    grid-column: 2;
    grid-row: 2;
  }
  .kn-run-act {
    grid-column: 3;
    grid-row: 2;
  }
  .kn-run-time {
    grid-column: 4;
    grid-row: 2;
    text-align: start;
  }
}
@media (prefers-reduced-motion: reduce) {
  .kn-run-seg > button {
    transition: none;
  }
}
</style>
