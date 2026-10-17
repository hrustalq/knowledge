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
 */
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { AlertTriangle, KeyRound, Loader2, Send } from 'lucide-vue-next'
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
import { statusTone, type OperationView } from '@/lib/api-spec'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import ApiTone from './ApiTone.vue'
import { credentialSlots, forgetCredentials, type TryDraft, type TryEnv, type TryVia } from './use-try-env'

const props = defineProps<{
  document: Record<string, unknown>
  operation: ApiOperationInfo
  view: OperationView
  draft: TryDraft
  env: TryEnv
  request: SampleRequest
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

const groups = computed(() =>
  (['path', 'query', 'header'] as const)
    .map((where) => ({ where, params: props.view.parameters.filter((p) => p.in === where) }))
    .filter((g) => g.params.length > 0),
)
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

async function send() {
  if (sending.value || unsendable.value) return
  sending.value = true
  failure.value = null
  const r = resolved.value
  const body = r.method === 'GET' || r.method === 'HEAD' ? null : r.body
  try {
    result.value = via.value === 'proxy' ? await viaProxy(r, body) : await viaBrowser(r, body)
    tab.value = 'body'
  } catch (e) {
    result.value = null
    // A CORS refusal and a dead host are the same TypeError to a page; the
    // proxy cannot tell them apart either, so the hint names both.
    failure.value =
      via.value === 'browser' && e instanceof TypeError
        ? { kind: 'cors', message: t('apiTry.corsHint', { host: hostOf(r.url) }) }
        : { kind: 'error', message: errorMessage(e, t) }
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
  const res = (await api.post('/v1/api-specs/{id}/try', {
    path: { id: props.operation.documentId },
    body: {
      revisionId: props.operation.revisionId,
      entityKey: props.operation.entityKey,
      method: r.method,
      url: r.url,
      headers: r.headers,
      body,
    },
  })) as ApiTryResponse
  return { ...res, via: 'proxy' }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

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
  <div class="space-y-5">
    <!-- Route and server: the two facts that decide whether anything can arrive. -->
    <div class="flex flex-wrap items-end gap-x-6 gap-y-3">
      <div class="space-y-1.5">
        <span :id="`${uid}-via`" class="block text-[0.75rem] font-medium text-muted-foreground">{{ t('apiTry.via.label') }}</span>
        <div role="radiogroup" :aria-labelledby="`${uid}-via`" class="inline-flex h-8 rounded-md border p-0.5">
          <button
            v-for="v in (['browser', 'proxy'] as const)"
            :key="v"
            type="button"
            role="radio"
            :aria-checked="via === v"
            :aria-disabled="v === 'proxy' && proxyBlocked !== null"
            :aria-describedby="v === 'proxy' && proxyBlocked && proxyBlocked !== 'loading' ? `${uid}-proxy-why` : undefined"
            class="rounded-sm px-3 text-[0.8rem] transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            :class="[
              via === v ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:text-foreground',
              v === 'proxy' && proxyBlocked !== null && 'cursor-not-allowed opacity-50 hover:text-muted-foreground',
            ]"
            @click="choose(v)"
          >
            {{ t(`apiTry.via.${v}`) }}
          </button>
        </div>
      </div>

      <div class="min-w-60 flex-1 space-y-1.5">
        <label :for="`${uid}-server`" class="block text-[0.75rem] font-medium text-muted-foreground">{{ t('apiTry.server') }}</label>
        <Select v-if="servers.length > 1" :model-value="serverUrl ?? undefined" @update:model-value="(v) => (env.serverUrl = String(v))">
          <SelectTrigger :id="`${uid}-server`" class="h-8 w-full max-w-md font-mono text-[0.78rem]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="s in servers" :key="s.url" :value="s.url" class="font-mono text-[0.78rem]">{{ s.url }}</SelectItem>
          </SelectContent>
        </Select>
        <p v-else :id="`${uid}-server`" class="flex h-8 items-center truncate font-mono text-[0.78rem]">
          {{ serverUrl ?? t('apiTry.noServer') }}
        </p>
      </div>
    </div>
    <p v-if="via === 'browser' && proxyBlocked && proxyBlocked !== 'loading'" :id="`${uid}-proxy-why`" class="-mt-2 text-[0.75rem] leading-relaxed text-muted-foreground">
      {{ t(`apiTry.proxyBlocked.${proxyBlocked}`) }}
      <RouterLink v-if="proxyBlocked === 'off' && auth.canAdminWorkspace" to="/settings/api" class="text-primary underline-offset-2 hover:underline">
        {{ t('apiTry.proxyBlocked.settings') }}
      </RouterLink>
    </p>

    <!-- Parameters, by where they travel. -->
    <section v-for="g in groups" :key="g.where" class="space-y-2">
      <h5 class="text-[0.75rem] font-medium text-muted-foreground">{{ t(`apiRef.in.${g.where}`) }}</h5>
      <div class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:items-center">
        <template v-for="p in g.params" :key="p.name">
          <label :for="`${uid}-${g.where}-${p.name}`" class="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <code class="truncate font-mono text-[0.8rem] font-medium">{{ p.name }}</code>
            <span class="font-mono text-[0.72rem] text-muted-foreground">{{ p.type }}</span>
            <span v-if="p.required" class="text-[0.68rem] font-semibold tracking-wide uppercase">{{ t('apiRef.required') }}</span>
          </label>
          <Select
            v-if="p.enumValues.length"
            :model-value="bucket(g.where)[p.name] ?? ''"
            @update:model-value="(v) => (bucket(g.where)[p.name] = String(v))"
          >
            <SelectTrigger :id="`${uid}-${g.where}-${p.name}`" class="h-8 w-full font-mono text-[0.8rem]"><SelectValue :placeholder="t('apiTry.choose')" /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="v in p.enumValues" :key="v" :value="v" class="font-mono text-[0.8rem]">{{ v }}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            v-else
            :id="`${uid}-${g.where}-${p.name}`"
            v-model="bucket(g.where)[p.name]"
            class="h-8 font-mono text-[0.8rem]"
            :placeholder="p.type"
            :aria-required="p.required || undefined"
            autocomplete="off"
            spellcheck="false"
          />
        </template>
      </div>
    </section>

    <!-- Credentials: shared by every operation of this spec, kept in this tab. -->
    <section v-if="schemes.length" class="space-y-2">
      <div class="flex items-baseline justify-between gap-3">
        <h5 class="flex items-center gap-1.5 text-[0.75rem] font-medium text-muted-foreground">
          <KeyRound class="size-3.5" />{{ t('apiTry.auth.title') }}
        </h5>
        <button v-if="hasCredentials" type="button" class="text-[0.75rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" @click="forgetCredentials(env)">
          {{ t('apiTry.auth.forget') }}
        </button>
      </div>
      <div class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:items-center">
        <template v-for="s in schemes" :key="s.scheme">
          <template v-if="s.kind === 'basic'">
            <label :for="`${uid}-auth-user`" class="text-[0.8rem]">{{ t('apiTry.auth.username') }}</label>
            <Input :id="`${uid}-auth-user`" v-model="env.basicUser" class="h-8 font-mono text-[0.8rem]" autocomplete="off" spellcheck="false" />
            <label :for="`${uid}-auth-pass`" class="text-[0.8rem]">{{ t('apiTry.auth.password') }}</label>
            <Input :id="`${uid}-auth-pass`" v-model="env.basicPassword" type="password" class="h-8 font-mono text-[0.8rem]" autocomplete="off" />
          </template>
          <template v-else>
            <label :for="`${uid}-auth-${s.scheme}`" class="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[0.8rem]">
              {{ s.kind === 'bearer' ? t('apiTry.auth.token') : t('apiTry.auth.apiKey') }}
              <code v-if="s.kind === 'apiKey'" class="font-mono text-[0.72rem] text-muted-foreground">{{ s.in }} · {{ s.name }}</code>
            </label>
            <Input
              :id="`${uid}-auth-${s.scheme}`"
              :model-value="s.kind === 'bearer' ? env.token : env.apiKey"
              type="password"
              class="h-8 font-mono text-[0.8rem]"
              autocomplete="off"
              @update:model-value="(v) => (s.kind === 'bearer' ? (env.token = String(v)) : (env.apiKey = String(v)))"
            />
          </template>
        </template>
      </div>
      <p class="text-[0.75rem] leading-relaxed text-muted-foreground">{{ t('apiTry.auth.kept') }}</p>
    </section>

    <!-- The body, prefilled from the spec's example. -->
    <section v-if="view.requestBody" class="space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <label :for="`${uid}-body`" class="text-[0.75rem] font-medium text-muted-foreground">{{ t('apiRef.body') }}</label>
        <Select v-if="bodyTypes.length > 1" :model-value="draft.contentType ?? bodyTypes[0]" @update:model-value="(v) => (draft.contentType = String(v))">
          <SelectTrigger class="h-7 w-auto font-mono text-[0.75rem]" :aria-label="t('apiTry.contentType')"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="ct in bodyTypes" :key="ct" :value="ct" class="font-mono text-[0.75rem]">{{ ct }}</SelectItem>
          </SelectContent>
        </Select>
        <span v-else class="font-mono text-[0.72rem] text-muted-foreground">{{ bodyTypes[0] }}</span>
      </div>
      <Textarea
        :id="`${uid}-body`"
        :model-value="draft.body ?? ''"
        class="min-h-36 font-mono text-[0.78rem] leading-[1.6]"
        spellcheck="false"
        @update:model-value="(v) => (draft.body = String(v))"
      />
    </section>

    <!-- Send: the button, and the exact line that will go out. -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-4">
      <Button size="sm" :disabled="sending || !!unsendable" @click="send">
        <Loader2 v-if="sending" class="animate-spin" />
        <Send v-else />
        {{ sending ? t('apiTry.sending') : t('apiTry.send') }}
      </Button>
      <p v-if="unsendable" class="text-[0.78rem] text-muted-foreground">{{ unsendable }}</p>
      <code v-else class="min-w-0 flex-1 truncate font-mono text-[0.75rem] text-muted-foreground" :title="resolved.url">
        {{ resolved.method }} {{ resolved.url }}
      </code>
    </div>

    <!-- What came back, or why nothing did. -->
    <div v-if="failure" role="alert" class="kn-try-note flex items-start gap-2 rounded-lg p-3 text-[0.82rem] leading-relaxed" :data-kind="failure.kind">
      <AlertTriangle class="mt-0.5 size-4 shrink-0" />
      <div class="space-y-1">
        <p>{{ failure.message }}</p>
        <p v-if="failure.kind === 'cors'" class="text-muted-foreground">
          {{ proxyBlocked === null ? t('apiTry.corsUseProxy') : t('apiTry.corsNoProxy') }}
        </p>
      </div>
    </div>

    <section v-else-if="result" class="space-y-2" aria-live="polite">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h5 class="text-[0.75rem] font-medium text-muted-foreground">{{ t('apiTry.response') }}</h5>
        <ApiTone :tone="statusTone(String(result.status))">{{ result.status }}</ApiTone>
        <span class="text-sm">{{ result.statusText }}</span>
        <span class="ml-auto flex gap-3 text-[0.75rem] text-muted-foreground tabular-nums">
          <span>{{ t('apiTry.ms', { n: formatNumber(result.durationMs) }) }}</span>
          <span>{{ formatBytes(result.bytes) }}</span>
          <span>{{ t(`apiTry.sentVia.${result.via}`) }}</span>
        </span>
      </div>

      <div class="flex border-b" role="tablist" :aria-label="t('apiTry.response')">
        <button
          v-for="k in (['body', 'headers'] as const)"
          :id="`${uid}-res-${k}`"
          :key="k"
          type="button"
          role="tab"
          :aria-selected="tab === k"
          :aria-controls="`${uid}-res-panel`"
          class="-mb-px rounded-t-sm border-b-2 px-2.5 py-1.5 text-[0.8rem] transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          :class="tab === k ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'"
          @click="tab = k"
        >
          {{ t(`apiTry.tab.${k}`) }}
          <span v-if="k === 'headers'" class="ml-1 rounded-full bg-muted px-1.5 text-[0.7rem] tabular-nums text-muted-foreground">{{ result.headers.length }}</span>
        </button>
      </div>

      <div :id="`${uid}-res-panel`" role="tabpanel" :aria-labelledby="`${uid}-res-${tab}`">
        <template v-if="tab === 'body'">
          <p v-if="result.encoding === 'base64'" class="mb-1.5 text-[0.75rem] text-muted-foreground">{{ t('apiTry.binary') }}</p>
          <pre v-if="shownBody" tabindex="0" class="max-h-[26rem] overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-[0.78rem] leading-[1.6] [overflow-wrap:anywhere] whitespace-pre-wrap">{{ shownBody }}</pre>
          <p v-else class="py-2 text-[0.82rem] text-muted-foreground">{{ t('apiTry.emptyBody') }}</p>
          <p v-if="result.truncated" class="mt-1.5 text-[0.75rem] text-muted-foreground">
            {{ t('apiTry.truncated', { size: formatBytes(settings?.tryLimits.maxResponseBytes ?? result.bytes) }) }}
          </p>
        </template>
        <template v-else>
          <dl class="divide-y border-y text-[0.78rem]">
            <div v-for="(h, i) in result.headers" :key="i" class="grid grid-cols-[minmax(0,16rem)_minmax(0,1fr)] gap-4 py-1.5">
              <dt class="font-mono text-muted-foreground [overflow-wrap:anywhere]">{{ h.name }}</dt>
              <dd class="font-mono [overflow-wrap:anywhere]">{{ h.value }}</dd>
            </div>
          </dl>
          <p v-if="result.via === 'browser'" class="mt-1.5 text-[0.75rem] text-muted-foreground">{{ t('apiTry.browserHeaders') }}</p>
        </template>
        <p v-if="result.droppedHeaders.length" class="mt-1.5 text-[0.75rem] text-muted-foreground">
          {{ t('apiTry.dropped', { names: result.droppedHeaders.join(', ') }) }}
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* A refusal is a warning, not an error page: the panel ramp's warning hue as a
   wash, its ink pulled toward the foreground so it reads on both grounds. */
.kn-try-note {
  --tone: var(--kn-panel-warning);
  background: color-mix(in oklch, var(--tone) 10%, transparent);
  color: color-mix(in oklch, var(--tone) 35%, var(--foreground));
}
.kn-try-note[data-kind='error'] {
  --tone: var(--kn-panel-caution);
}
</style>
