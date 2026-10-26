<script setup lang="ts">
/**
 * The try-it console for one HTTP operation (#78). It edits the draft the
 * code samples print, so what is sent and what the sample shows are one
 * request; the credentials are the only difference, filled in at send time.
 *
 * Two routes out, and the spec author can widen neither:
 *
 *  - **Browser** (the default): this tab calls the server directly, on the
 *    reader's own network and credentials. It works only where the API allows
 *    CORS — a refusal looks like a network error, so the console says which.
 *  - **Proxy**: `POST /v1/api-specs/:id/try`, for an API that refuses CORS. It
 *    exists only when the workspace's mode (clamped by the deployment) is not
 *    `off`, and for an editor; otherwise the segment says why it is missing.
 *
 * Credentials live in `sessionStorage` per spec (use-try-env) and nowhere else.
 *
 * Laid out the way Postman taught everyone to read a request: one bar with the
 * method, the URL as it will go out and Send; under it the request by part —
 * Params · Headers · Body · Auth, each with what it holds; then the response
 * with its status, time and size. While a request is out, a trace runs along
 * the bar's lower edge in the method's hue; when the answer lands, the edge
 * takes the status's hue and the response unfolds under it.
 */
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { AlertTriangle, Loader2, RotateCcw, Send } from 'lucide-vue-next'
import {
  apiServerOptions,
  operationAuth,
  resolveSampleRequest,
  type ApiOperationInfo,
  type ApiSettingsResponse,
  type ApiTryResponse,
  type SampleRequest,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { formatBytes, formatNumber } from '@/lib/format'
import { methodTone, pathSegments, statusTone, type OperationView } from '@/lib/api-spec'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import ApiCode from './ApiCode.vue'
import ApiTabs, { type ApiTab } from './ApiTabs.vue'
import ApiTone from './ApiTone.vue'
import { credentialSlots, forgetCredentials, type TryDraft, type TryEnv, type TryVia } from './use-try-env'

const props = defineProps<{
  document: Record<string, unknown>
  operation: ApiOperationInfo
  view: OperationView
  draft: TryDraft
  env: TryEnv
  request: SampleRequest
  /** The body the spec's example gives, for Reset. */
  exampleBody: string | null
  /** The server in use: the reader's choice when this revision still names it, else the first. */
  serverUrl: string | null
  workspaceId: string
}>()

const { t } = useI18n()
const auth = useAuthStore()
const uid = useId()

// ---- Where the request goes --------------------------------------------------

const servers = computed(() => apiServerOptions(props.document))
const absolute = (url: string) => /^https?:\/\//iu.test(url)

const settingsQuery = useQuery(apiQueryOptions('/v1/workspaces/{id}/api-settings', { path: { id: props.workspaceId } }))
const settings = computed(() => settingsQuery.data.value as ApiSettingsResponse | undefined)

/** Why the proxy is not offered, or null when it is. */
const proxyBlocked = computed<'off' | 'role' | 'loading' | null>(() => {
  if (!settings.value) return 'loading'
  if (settings.value.tryProxy.effective === 'off') return 'off'
  if (!auth.canEdit) return 'role'
  return null
})
const via = computed<TryVia>(() => (props.env.via === 'proxy' && proxyBlocked.value === null ? 'proxy' : 'browser'))
function choose(next: TryVia) {
  if (next === 'proxy' && proxyBlocked.value !== null) return
  props.env.via = next
}

// ---- What is sent -------------------------------------------------------------

const bucket = (where: 'path' | 'query' | 'header') => (where === 'header' ? props.draft.headers : props.draft[where])
const schemes = computed(() => operationAuth(props.document, props.operation))
const bodyTypes = computed(() => props.view.requestBody?.contents.map((c) => c.mediaType) ?? [])

const missing = computed(() =>
  props.view.parameters.filter((p) => p.required && p.in !== 'cookie' && !(bucket(p.in as 'path')?.[p.name] ?? '').trim()).map((p) => p.name),
)
const resolved = computed(() => resolveSampleRequest(props.request, credentialSlots(props.env)))
const unsendable = computed(() => {
  if (!absolute(props.request.url)) return t('apiTry.relativeServer')
  if (missing.value.length) return t('apiTry.missing', { names: missing.value.join(', ') })
  return null
})
const hasCredentials = computed(() => !!(props.env.token || props.env.apiKey || props.env.basicUser || props.env.basicPassword))

/** The URL as it will go out, in parts: a filled `{param}` shows its value, an empty one its name. */
const urlParts = computed(() => {
  const server = (props.serverUrl ?? '').replace(/\/+$/u, '')
  const path = pathSegments(props.view.path).map((seg) => {
    if (!seg.param) return { text: seg.text, kind: 'literal' as const }
    const name = seg.text.slice(1, -1)
    const value = (props.draft.path[name] ?? '').trim()
    return value ? { text: value, kind: 'value' as const } : { text: seg.text, kind: 'empty' as const }
  })
  const query = Object.entries(props.draft.query)
    .filter(([, v]) => v.trim() !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  return { server, path, query }
})

// ---- The request, by part ------------------------------------------------------

const paramRows = computed(() => props.view.parameters.filter((p) => p.in === 'path' || p.in === 'query'))
const headerRows = computed(() => props.view.parameters.filter((p) => p.in === 'header'))
const filledIn = (rows: typeof paramRows.value) => rows.filter((p) => (bucket(p.in as 'path')[p.name] ?? '').trim() !== '').length
const parts = computed(() => {
  const out: ApiTab[] = []
  if (paramRows.value.length) out.push({ id: 'params', label: t('apiTry.req.params'), count: paramRows.value.length })
  if (headerRows.value.length) out.push({ id: 'headers', label: t('apiTry.req.headers'), count: headerRows.value.length })
  if (props.view.requestBody) out.push({ id: 'body', label: t('apiTry.req.body'), dot: !!props.draft.body?.trim() })
  if (schemes.value.length) out.push({ id: 'auth', label: t('apiTry.req.auth'), dot: hasCredentials.value })
  return out
})
const part = ref<string>('params')
const shownPart = computed(() => (parts.value.some((p) => p.id === part.value) ? part.value : (parts.value[0]?.id ?? null)))
const partStrip = ref<InstanceType<typeof ApiTabs> | null>(null)
const partSummary = (rows: typeof paramRows.value) => `${filledIn(rows)}/${rows.length}`

/** Set once Send was pressed with something missing: from then on the gaps are marked. */
const tried = ref(false)
const isMissing = (name: string) => tried.value && missing.value.includes(name)
const bodyChanged = computed(() => (props.draft.body ?? '') !== (props.exampleBody ?? ''))
const where = (loc: string) => t(`apiLink.in.${loc}`)

// ---- Sending ------------------------------------------------------------------

interface Result extends Omit<ApiTryResponse, 'droppedHeaders'> {
  via: TryVia
  droppedHeaders: string[]
}
const sending = ref(false)
const result = ref<Result | null>(null)
const failure = ref<{ kind: 'cors' | 'error'; message: string } | null>(null)
const tab = ref<'body' | 'headers'>('body')

const BROWSER_TIMEOUT_MS = 30_000
const BROWSER_MAX_CHARS = 1_000_000

const landed = ref(0)

async function send() {
  if (sending.value) return
  if (unsendable.value) {
    tried.value = true
    const first = props.view.parameters.find((p) => missing.value.includes(p.name))
    if (first) {
      part.value = first.in === 'header' ? 'headers' : 'params'
      await nextTick()
      document.getElementById(`${uid}-${first.in}-${first.name}`)?.focus()
    }
    return
  }
  sending.value = true
  failure.value = null
  const r = resolved.value
  const body = r.method === 'GET' || r.method === 'HEAD' ? null : r.body
  try {
    result.value = via.value === 'proxy' ? await viaProxy(r, body) : await viaBrowser(r, body)
    tab.value = 'body'
    landed.value++
  } catch (e) {
    result.value = null
    // A CORS refusal and a dead host are the same TypeError to a page; the
    // proxy cannot tell them apart either, so the hint names both.
    failure.value =
      via.value === 'browser' && e instanceof TypeError
        ? { kind: 'cors', message: t('apiTry.corsHint', { host: hostOf(r.url) }) }
        : { kind: 'error', message: errorMessage(e, t) }
    landed.value++
  } finally {
    sending.value = false
  }
}

async function viaBrowser(r: typeof resolved.value, body: string | null): Promise<Result> {
  const started = performance.now()
  const res = await fetch(r.url, {
    method: r.method,
    headers: r.headers.map((h) => [h.name, h.value] as [string, string]),
    body,
    credentials: 'omit',
    signal: AbortSignal.timeout(BROWSER_TIMEOUT_MS),
  })
  const text = await res.text()
  return {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers.entries()].map(([name, value]) => ({ name, value })),
    body: text.slice(0, BROWSER_MAX_CHARS),
    encoding: 'utf8',
    bytes: new TextEncoder().encode(text).length,
    truncated: text.length > BROWSER_MAX_CHARS,
    durationMs: Math.round(performance.now() - started),
    via: 'browser',
    droppedHeaders: [],
  }
}

async function viaProxy(r: typeof resolved.value, body: string | null): Promise<Result> {
  const res = await api.post('/v1/api-specs/{id}/try', {
    path: { id: props.operation.documentId },
    body: {
      revisionId: props.operation.revisionId,
      entityKey: props.operation.entityKey,
      method: r.method,
      url: r.url,
      headers: r.headers,
      body,
    },
  })
  return { ...res, via: 'proxy' }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

watch(missing, (names) => {
  if (names.length === 0) tried.value = false
})

const resultTone = computed(() => (result.value ? statusTone(String(result.value.status)) : failure.value ? 'caution' : null))
const responseTabs = computed<ApiTab[]>(() => [
  { id: 'body', label: t('apiTry.tab.body') },
  { id: 'headers', label: t('apiTry.tab.headers'), count: result.value?.headers.length ?? 0 },
])
const responseStrip = ref<InstanceType<typeof ApiTabs> | null>(null)
const contentType = computed(() => result.value?.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '')
const isJson = computed(() => /json/iu.test(contentType.value))

const shownBody = computed(() => {
  const r = result.value
  if (!r || r.encoding !== 'utf8') return r?.body ?? ''
  const type = r.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? ''
  if (!/json/iu.test(type) || r.truncated) return r.body
  try {
    return JSON.stringify(JSON.parse(r.body), null, 2)
  } catch {
    return r.body
  }
})
</script>

<template>
  <div class="kn-try space-y-4" :data-kn-method="view.method?.toUpperCase()">
    <!-- The request bar: method, the URL as it will go out, Send. -->
    <form class="kn-try-bar" :data-sending="sending || undefined" :data-landed="resultTone ?? undefined" :style="resultTone ? { '--kn-result': `var(--kn-panel-${resultTone})` } : undefined" @submit.prevent="send">
      <ApiTone :tone="methodTone(view.method)" variant="solid" class="ml-1.5">{{ view.method }}</ApiTone>
      <div class="kn-try-url" :title="resolved.url">
        <Select v-if="servers.length > 1" :model-value="serverUrl ?? undefined" @update:model-value="(v) => (env.serverUrl = String(v))">
          <SelectTrigger :id="`${uid}-server`" class="kn-try-server h-7 max-w-[45%] min-w-0 gap-1 border-0 bg-transparent px-1.5 font-mono text-sm shadow-none" :aria-label="t('apiTry.server')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="srv in servers" :key="srv.url" :value="srv.url" class="font-mono text-ui">{{ srv.url }}</SelectItem>
          </SelectContent>
        </Select>
        <span v-else class="kn-try-server-text">{{ urlParts.server || t('apiTry.noServer') }}</span>
        <span class="kn-try-path"
          ><template v-for="(seg, i) in urlParts.path" :key="i"
            ><span v-if="seg.kind === 'value'" class="kn-try-seg-value">{{ seg.text }}</span
            ><span v-else-if="seg.kind === 'empty'" class="kn-try-seg-empty">{{ seg.text }}</span
            ><template v-else>{{ seg.text }}</template></template
          ><span v-if="urlParts.query" class="kn-try-seg-query">?{{ urlParts.query }}</span></span
        >
      </div>
      <Button type="submit" size="sm" class="h-8 shrink-0 px-3.5" :aria-busy="sending || undefined">
        <Loader2 v-if="sending" class="animate-spin motion-reduce:animate-none" />
        <Send v-else />
        {{ sending ? t('apiTry.sending') : t('apiTry.send') }}
      </Button>
      <span class="kn-try-trace" aria-hidden="true" />
    </form>

    <!-- Where it goes from, and what stops it going. -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div class="flex items-center gap-2">
        <span :id="`${uid}-via`" class="text-ui text-muted-foreground">{{ t('apiTry.via.label') }}</span>
        <div role="radiogroup" :aria-labelledby="`${uid}-via`" class="kn-try-seg">
          <button
            v-for="v in (['browser', 'proxy'] as const)"
            :key="v"
            type="button"
            role="radio"
            :aria-checked="via === v"
            :aria-disabled="v === 'proxy' && proxyBlocked !== null"
            :aria-describedby="v === 'proxy' && proxyBlocked && proxyBlocked !== 'loading' ? `${uid}-proxy-why` : undefined"
            :data-active="via === v || undefined"
            @click="choose(v)"
          >
            {{ t(`apiTry.via.${v}`) }}
          </button>
        </div>
      </div>
      <p v-if="unsendable && (tried || !absolute(request.url))" class="kn-try-warn" role="status">
        <AlertTriangle class="size-3.5 shrink-0" aria-hidden="true" />{{ unsendable }}
      </p>
    </div>
    <p v-if="via === 'browser' && proxyBlocked && proxyBlocked !== 'loading'" :id="`${uid}-proxy-why`" class="-mt-2 text-ui leading-relaxed text-muted-foreground">
      {{ t(`apiTry.proxyBlocked.${proxyBlocked}`) }}
      <RouterLink v-if="proxyBlocked === 'off' && auth.canAdminWorkspace" to="/settings/api" class="text-primary underline-offset-2 hover:underline">
        {{ t('apiTry.proxyBlocked.settings') }}
      </RouterLink>
    </p>

    <!-- The request, by part. -->
    <div v-if="parts.length" class="space-y-3">
      <ApiTabs ref="partStrip" :model-value="shownPart ?? ''" :tabs="parts" :label="t('apiTry.req.label')" @update:model-value="(v) => (part = v)" />

      <div v-if="shownPart === 'params' || shownPart === 'headers'" :id="partStrip?.panelId(shownPart)" :key="shownPart" role="tabpanel" :aria-labelledby="partStrip?.tabId(shownPart)" class="kn-fade-swap">
        <div class="kn-try-table" role="table" :aria-label="t(`apiTry.req.${shownPart}`)">
          <div class="kn-try-thead" role="row">
            <span role="columnheader">{{ t('apiTry.col.key') }}</span>
            <span role="columnheader">{{ t('apiTry.col.value') }}</span>
            <span role="columnheader" class="kn-try-desc-col">{{ t('apiTry.col.description') }}</span>
          </div>
          <div v-for="p in shownPart === 'params' ? paramRows : headerRows" :key="`${p.in}:${p.name}`" class="kn-try-row" role="row">
            <label role="cell" :for="`${uid}-${p.in}-${p.name}`" class="kn-try-key">
              <code>{{ p.name }}</code><span v-if="p.required" class="kn-try-req" :title="t('apiRef.required')">*</span>
              <span class="kn-try-in">{{ where(p.in) }}</span>
            </label>
            <div role="cell" class="kn-try-value">
              <Select
                v-if="p.enumValues.length"
                :model-value="bucket(p.in as 'path')[p.name] ?? ''"
                @update:model-value="(v) => (bucket(p.in as 'path')[p.name] = String(v))"
              >
                <SelectTrigger :id="`${uid}-${p.in}-${p.name}`" class="kn-try-input h-9 w-full font-mono" :aria-invalid="isMissing(p.name) || undefined"><SelectValue :placeholder="t('apiTry.choose')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="v in p.enumValues" :key="v" :value="v" class="font-mono text-ui">{{ v }}</SelectItem>
                </SelectContent>
              </Select>
              <Input
                v-else
                :id="`${uid}-${p.in}-${p.name}`"
                v-model="bucket(p.in as 'path')[p.name]"
                class="kn-try-input h-9 font-mono"
                :placeholder="p.example ?? p.type"
                :aria-required="p.required || undefined"
                :aria-invalid="isMissing(p.name) || undefined"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <div role="cell" class="kn-try-desc-col kn-try-desc">
              <span class="font-mono text-xs">{{ p.type }}</span>
              <span v-if="p.description" class="line-clamp-2">{{ p.description }}</span>
            </div>
          </div>
        </div>
        <p class="mt-1.5 text-right text-xs text-muted-foreground tabular-nums">
          {{ t('apiTry.req.filled', { n: partSummary(shownPart === 'params' ? paramRows : headerRows) }) }}
        </p>
      </div>

      <div v-else-if="shownPart === 'body' && view.requestBody" :id="partStrip?.panelId('body')" key="body" role="tabpanel" :aria-labelledby="partStrip?.tabId('body')" class="kn-fade-swap space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <Select v-if="bodyTypes.length > 1" :model-value="draft.contentType ?? bodyTypes[0]" @update:model-value="(v) => (draft.contentType = String(v))">
            <SelectTrigger class="h-7 w-auto font-mono text-xs" :aria-label="t('apiTry.contentType')"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="ct in bodyTypes" :key="ct" :value="ct" class="font-mono text-xs">{{ ct }}</SelectItem>
            </SelectContent>
          </Select>
          <code v-else class="font-mono text-xs text-muted-foreground">{{ bodyTypes[0] }}</code>
          <button v-if="bodyChanged && exampleBody !== null" type="button" class="kn-try-link ml-auto" @click="draft.body = exampleBody ?? null">
            <RotateCcw class="size-3.5" aria-hidden="true" />{{ t('apiTry.resetBody') }}
          </button>
        </div>
        <Textarea
          :id="`${uid}-body`"
          :model-value="draft.body ?? ''"
          :aria-label="t('apiTry.req.body')"
          class="kn-try-body min-h-44 font-mono text-ui leading-[1.65]"
          spellcheck="false"
          @update:model-value="(v) => (draft.body = String(v))"
        />
      </div>

      <div v-else-if="shownPart === 'auth'" :id="partStrip?.panelId('auth')" key="auth" role="tabpanel" :aria-labelledby="partStrip?.tabId('auth')" class="kn-fade-swap space-y-2">
        <div class="kn-try-table" role="table" :aria-label="t('apiTry.auth.title')">
          <template v-for="sch in schemes" :key="sch.scheme">
            <template v-if="sch.kind === 'basic'">
              <div class="kn-try-row kn-try-row--auth" role="row">
                <label role="cell" :for="`${uid}-auth-user`" class="kn-try-key">{{ t('apiTry.auth.username') }}</label>
                <div role="cell" class="kn-try-value"><Input :id="`${uid}-auth-user`" v-model="env.basicUser" class="kn-try-input h-9 font-mono" autocomplete="off" spellcheck="false" /></div>
              </div>
              <div class="kn-try-row kn-try-row--auth" role="row">
                <label role="cell" :for="`${uid}-auth-pass`" class="kn-try-key">{{ t('apiTry.auth.password') }}</label>
                <div role="cell" class="kn-try-value"><Input :id="`${uid}-auth-pass`" v-model="env.basicPassword" type="password" class="kn-try-input h-9 font-mono" autocomplete="off" /></div>
              </div>
            </template>
            <div v-else class="kn-try-row kn-try-row--auth" role="row">
              <label role="cell" :for="`${uid}-auth-${sch.scheme}`" class="kn-try-key">
                {{ sch.kind === 'bearer' ? t('apiTry.auth.token') : t('apiTry.auth.apiKey') }}
                <span v-if="sch.kind === 'apiKey'" class="kn-try-in">{{ sch.in ? where(sch.in) : '' }} · {{ sch.name }}</span>
              </label>
              <div role="cell" class="kn-try-value">
                <Input
                  :id="`${uid}-auth-${sch.scheme}`"
                  :model-value="sch.kind === 'bearer' ? env.token : env.apiKey"
                  type="password"
                  class="kn-try-input h-9 font-mono"
                  autocomplete="off"
                  @update:model-value="(v) => (sch.kind === 'bearer' ? (env.token = String(v)) : (env.apiKey = String(v)))"
                />
              </div>
            </div>
          </template>
        </div>
        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p class="text-ui leading-relaxed text-muted-foreground">{{ t('apiTry.auth.kept') }}</p>
          <button v-if="hasCredentials" type="button" class="kn-try-link" @click="forgetCredentials(env)">{{ t('apiTry.auth.forget') }}</button>
        </div>
      </div>
    </div>

    <!-- The response: what came back, why nothing did, or where it will be. -->
    <section class="kn-try-response" :aria-label="t('apiTry.response')" aria-live="polite">
      <p v-if="!result && !failure" class="kn-try-idle">
        <Send class="size-4 shrink-0" aria-hidden="true" />{{ sending ? t('apiTry.sending') : t('apiTry.idle') }}
      </p>

      <div v-else-if="failure" :key="`f${landed}`" role="alert" class="kn-try-note kn-try-arrive flex items-start gap-2.5 rounded-lg p-3.5 text-sm leading-relaxed" :data-kind="failure.kind">
        <AlertTriangle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div class="space-y-1">
          <p>{{ failure.message }}</p>
          <p v-if="failure.kind === 'cors'" class="opacity-85">
            {{ proxyBlocked === null ? t('apiTry.corsUseProxy') : t('apiTry.corsNoProxy') }}
          </p>
        </div>
      </div>

      <div v-else-if="result" :key="`r${landed}`" class="kn-try-arrive space-y-3">
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
          <h5 class="text-sm font-semibold">{{ t('apiTry.response') }}</h5>
          <dl class="kn-try-metrics">
            <div>
              <dt>{{ t('apiTry.metric.status') }}</dt>
              <dd class="flex items-center gap-1.5">
                <ApiTone :tone="statusTone(String(result.status))" variant="solid" class="kn-try-status">{{ result.status }}</ApiTone>
                <span class="text-foreground">{{ result.statusText }}</span>
              </dd>
            </div>
            <div>
              <dt>{{ t('apiTry.metric.time') }}</dt>
              <dd>{{ t('apiTry.ms', { n: formatNumber(result.durationMs) }) }}</dd>
            </div>
            <div>
              <dt>{{ t('apiTry.metric.size') }}</dt>
              <dd>{{ formatBytes(result.bytes) }}</dd>
            </div>
            <div class="text-muted-foreground">{{ t(`apiTry.sentVia.${result.via}`) }}</div>
          </dl>
        </div>

        <ApiTabs ref="responseStrip" v-model="tab" :tabs="responseTabs" :label="t('apiTry.response')" size="sm" />
        <div :id="responseStrip?.panelId(tab)" :key="tab" role="tabpanel" :aria-labelledby="responseStrip?.tabId(tab)" class="kn-fade-swap">
          <template v-if="tab === 'body'">
            <p v-if="result.encoding === 'base64'" class="mb-1.5 text-ui text-muted-foreground">{{ t('apiTry.binary') }}</p>
            <ApiCode v-if="shownBody" :code="shownBody" :lang="isJson && result.encoding === 'utf8' ? 'json' : null" :caption="contentType || t('apiTry.tab.body')" wrap />
            <p v-else class="py-2 text-sm text-muted-foreground">{{ t('apiTry.emptyBody') }}</p>
            <p v-if="result.truncated" class="mt-1.5 text-ui text-muted-foreground">
              {{ t('apiTry.truncated', { size: formatBytes(settings?.tryLimits.maxResponseBytes ?? result.bytes) }) }}
            </p>
          </template>
          <template v-else>
            <dl class="kn-try-headers">
              <div v-for="(h, i) in result.headers" :key="i">
                <dt>{{ h.name }}</dt>
                <dd>{{ h.value }}</dd>
              </div>
            </dl>
            <p v-if="result.via === 'browser'" class="mt-1.5 text-ui text-muted-foreground">{{ t('apiTry.browserHeaders') }}</p>
          </template>
          <p v-if="result.droppedHeaders.length" class="mt-1.5 text-ui text-muted-foreground">
            {{ t('apiTry.dropped', { names: result.droppedHeaders.join(', ') }) }}
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* The request bar --------------------------------------------------------- */
.kn-try-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.9rem;
  padding: 0.3rem;
  border: 1px solid color-mix(in oklab, var(--kn-accent) 35%, var(--border));
  border-radius: 8px;
  background: var(--card);
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  overflow: hidden;
  transition: border-color 150ms ease-out, box-shadow 150ms ease-out;
}
.kn-try-bar:focus-within {
  border-color: color-mix(in oklab, var(--kn-accent) 60%, var(--border));
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 25%, transparent);
}
.kn-try-url {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--kn-text-sm);
}
.kn-try-server-text {
  flex-shrink: 1;
  min-width: 0;
  max-width: 45%;
  padding-inline: 0.4rem 0;
  overflow: hidden;
  color: var(--muted-foreground);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kn-try-server :deep(span) {
  overflow: hidden;
  color: var(--muted-foreground);
  text-overflow: ellipsis;
}
.kn-try-path {
  min-width: 0;
  overflow: hidden;
  color: var(--foreground);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kn-try-seg-value {
  color: color-mix(in oklab, var(--kn-accent) 70%, var(--foreground));
  font-weight: 600;
}
.kn-try-seg-empty {
  color: color-mix(in oklab, var(--kn-panel-caution) 70%, var(--foreground));
}
.kn-try-seg-query {
  color: var(--muted-foreground);
}

/* The trace: while a request is out, a short run of the method's hue travels
   the bar's lower edge; once the answer lands, the edge holds the status's hue.
   It is the console's one authored motion, and it only ever means "in flight". */
.kn-try-trace {
  position: absolute;
  inset: auto 0 0 0;
  height: 2px;
  pointer-events: none;
  background: var(--kn-result, transparent);
  opacity: 0;
  transition: opacity 200ms ease-out, background-color 300ms ease-out;
}
.kn-try-bar[data-landed] .kn-try-trace {
  opacity: 0.85;
}
.kn-try-bar[data-sending] .kn-try-trace {
  opacity: 1;
  background: linear-gradient(90deg, transparent, color-mix(in oklab, var(--kn-accent) 85%, var(--foreground)), transparent) 0 0 / 40% 100% no-repeat;
  animation: kn-try-trace 1.1s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}
@keyframes kn-try-trace {
  from { background-position: -70% 0; }
  to { background-position: 170% 0; }
}

/* Send from: a two-way segment. */
.kn-try-seg {
  display: inline-flex;
  height: 1.9rem;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--muted);
}
.kn-try-seg > button {
  padding-inline: 0.7rem;
  border-radius: 5px;
  font-size: var(--kn-text-ui);
  color: var(--muted-foreground);
  transition: background-color 150ms ease-out, color 150ms ease-out, box-shadow 150ms ease-out;
}
.kn-try-seg > button:hover:not([aria-disabled='true']) {
  color: var(--foreground);
}
.kn-try-seg > button[data-active] {
  background: var(--card);
  color: var(--foreground);
  font-weight: 500;
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.08);
}
.kn-try-seg > button[aria-disabled='true'] {
  cursor: not-allowed;
  opacity: 0.5;
}
.kn-try-seg > button:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}
.kn-try-warn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: var(--kn-text-ui);
  color: color-mix(in oklab, var(--kn-panel-warning) 45%, var(--foreground));
}
.kn-try-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: var(--kn-text-ui);
  color: var(--muted-foreground);
  text-underline-offset: 3px;
}
.kn-try-link:hover {
  color: var(--foreground);
  text-decoration: underline;
}

/* Key | Value | Description, Postman's table: one frame, hairlines inside, the
   value cell an input that fills it. */
.kn-try-table {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--card);
  font-size: var(--kn-text-sm);
}
.kn-try-thead,
.kn-try-row {
  display: grid;
  grid-template-columns: minmax(8rem, 0.9fr) minmax(0, 1.4fr) minmax(0, 1fr);
}
.kn-try-row--auth {
  grid-template-columns: minmax(8rem, 0.9fr) minmax(0, 2.4fr);
}
.kn-try-thead {
  background: color-mix(in oklab, var(--foreground) 3%, var(--card));
  font-size: var(--kn-text-xs);
  font-weight: 500;
  color: var(--muted-foreground);
}
.kn-try-thead > span {
  padding: 0.4rem 0.75rem;
}
.kn-try-row {
  border-top: 1px solid var(--border);
}
.kn-try-table > .kn-try-row:first-child {
  border-top: 0;
}
.kn-try-row > * + * {
  border-left: 1px solid var(--border);
}
.kn-try-key {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.15rem 0.4rem;
  padding: 0.55rem 0.75rem;
  font-size: var(--kn-text-sm);
}
.kn-try-key code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.kn-try-req {
  margin-inline-start: -0.25rem;
  font-weight: 700;
  color: color-mix(in oklab, var(--kn-panel-caution) 75%, var(--foreground));
}
.kn-try-in {
  flex-basis: 100%;
  font-size: var(--kn-text-xs);
  font-style: italic;
  color: var(--muted-foreground);
}
.kn-try-value {
  min-width: 0;
}
.kn-try-value :deep(.kn-try-input) {
  height: 100%;
  min-height: 2.6rem;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  font-size: var(--kn-text-sm);
}
.kn-try-value :deep(.kn-try-input:focus-visible) {
  box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--ring) 70%, transparent);
}
.kn-try-value :deep(.kn-try-input[aria-invalid='true']) {
  background: color-mix(in oklab, var(--kn-panel-caution) 8%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--kn-panel-caution) 55%, transparent);
}
.kn-try-desc {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.55rem 0.75rem;
  font-size: var(--kn-text-ui);
  line-height: 1.45;
  color: color-mix(in oklab, var(--foreground) 70%, var(--card));
}
.kn-try-body {
  background: color-mix(in oklab, var(--foreground) 4%, var(--card));
  tab-size: 2;
}

/* The response ------------------------------------------------------------ */
.kn-try-response {
  padding-top: 1rem;
  border-top: 1px dashed var(--border);
}
.kn-try-idle {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.9rem 1rem;
  border: 1px dashed var(--border);
  border-radius: 8px;
  font-size: var(--kn-text-sm);
  color: var(--muted-foreground);
}
.kn-try-metrics {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 1.1rem;
  font-size: var(--kn-text-ui);
  font-variant-numeric: tabular-nums;
}
.kn-try-metrics > div {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.kn-try-metrics dt {
  color: var(--muted-foreground);
}
.kn-try-metrics dd {
  font-weight: 500;
  color: var(--foreground);
}
.kn-try-headers {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--kn-text-ui);
}
.kn-try-headers > div {
  display: grid;
  grid-template-columns: minmax(0, 15rem) minmax(0, 1fr);
}
.kn-try-headers > div + div {
  border-top: 1px solid var(--border);
}
.kn-try-headers dt,
.kn-try-headers dd {
  padding: 0.45rem 0.75rem;
  overflow-wrap: anywhere;
}
.kn-try-headers dt {
  color: color-mix(in oklab, var(--foreground) 70%, var(--card));
  background: color-mix(in oklab, var(--foreground) 3%, var(--card));
  border-right: 1px solid var(--border);
}

/* The answer unfolds from the bar downwards: a reveal, not a fade-in from
   nothing, so it reads as coming out of the request above it. */
.kn-try-arrive {
  animation: kn-try-arrive 320ms var(--snap-ease);
}
.kn-try-arrive :deep(.kn-try-status) {
  animation: kn-try-status 360ms var(--snap-ease);
}
@keyframes kn-try-arrive {
  from {
    opacity: 0.2;
    clip-path: inset(0 0 100% 0);
    transform: translateY(-4px);
  }
  to {
    clip-path: inset(0 0 -1rem 0);
  }
}
@keyframes kn-try-status {
  from {
    transform: scale(0.85);
    filter: blur(2px);
  }
}

/* A refusal is a warning, not an error page: the panel ramp's warning hue as a
   wash, its ink pulled toward the foreground so it reads on both grounds. */
.kn-try-note {
  --tone: var(--kn-panel-warning);
  background: color-mix(in oklab, var(--tone) 10%, transparent);
  border: 1px solid color-mix(in oklab, var(--tone) 30%, transparent);
  color: color-mix(in oklab, var(--tone) 35%, var(--foreground));
}
.kn-try-note[data-kind='error'] {
  --tone: var(--kn-panel-caution);
}

@container kn-op (max-width: 36rem) {
  /* The URL keeps the first row with its method; Send takes a row of its own. */
  .kn-try-bar {
    flex-wrap: wrap;
  }
  .kn-try-url {
    flex-basis: calc(100% - 5rem);
  }
  .kn-try-bar > :deep(button[type='submit']) {
    flex-basis: 100%;
  }
  .kn-try-thead {
    display: none;
  }
  .kn-try-row {
    grid-template-columns: minmax(0, 1fr);
  }
  .kn-try-row > * + * {
    border-left: 0;
    border-top: 1px dashed var(--border);
  }
  .kn-try-desc-col {
    display: none;
  }
  .kn-try-row--auth {
    grid-template-columns: minmax(0, 1fr);
  }
  .kn-try-headers > div {
    grid-template-columns: minmax(0, 1fr);
  }
  .kn-try-headers dt {
    border-right: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .kn-try-bar[data-sending] .kn-try-trace {
    animation: kn-try-pulse 1.4s linear infinite;
    background: color-mix(in oklab, var(--kn-accent) 70%, var(--foreground));
  }
  @keyframes kn-try-pulse {
    50% { opacity: 0.35; }
  }
  .kn-try-arrive {
    animation: kn-try-fade 140ms linear;
  }
  .kn-try-arrive :deep(.kn-try-status) {
    animation: none;
  }
  @keyframes kn-try-fade {
    from { opacity: 0.4; }
  }
}
</style>
