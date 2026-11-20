<script setup lang="ts">
/**
 * The wizard's last step (#1225): the server, not the person, says whether the
 * client connected. A key's `lastUsedAt` is written on its first call (only
 * later calls are throttled), so polling the caller's own key list sees the
 * first MCP request within one tick. Nothing new on the API.
 *
 * With no call after a while, the diagnostics open on their own: a curl the
 * person runs from the same shell, and what each reply means.
 *
 * A client signing in through the browser (#1371) has no key to watch: the
 * connection is a grant (`oauth`) made after the wizard opened, once used.
 * The wizard's setup key is never it — its use is the installer curl.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleCheck } from 'lucide-vue-next'
import { useQueryClient } from '@tanstack/vue-query'
import type { ApiKeyInfo } from '@knowledge/contracts'
import { Button } from '@knowledge/ui/button'
import { api, fetchApi } from '@/shared/api/queries'
import { formatRelative } from '@/shared/utils/format'
import { CopyBlock } from '@/entities/access'

const props = defineProps<{
  /** Polls only while the step is on screen. */
  active: boolean
  needsKey: boolean
  /** Signing in through the browser: the client's sign-in command, '' when it asks by itself; null for a key. */
  signIn: string | null
  clientName: string
  /** The key minted in this wizard; null watches every key the caller has. */
  keyId: string | null
  apiKey: string | null
  /** When the wizard opened: an existing key counts once it is used after this. */
  since: number
  check: string
  /** Tools the session is offered, when the new key's own count is not known. */
  sessionTools: number
}>()
const { t } = useI18n()
const queryClient = useQueryClient()

const POLL_MS = 3000
/** How long to wait before the diagnostics open by themselves. */
const SLOW_MS = 90_000

const hit = ref<ApiKeyInfo | null>(null)
const tools = ref<number | null>(null)
const started = ref<number | null>(null)
const now = ref(Date.now())
const asked = ref(false)
const slow = computed(() => !hit.value && (asked.value || (started.value !== null && now.value - started.value > SLOW_MS)))
const watching = computed(() => props.needsKey || props.signIn !== null)
const showCheck = computed(() => props.signIn === null && (!props.needsKey || slow.value))

let timer: ReturnType<typeof setInterval> | undefined
function stop() {
  clearInterval(timer)
  timer = undefined
}

async function poll() {
  now.value = Date.now()
  try {
    const { keys } = await fetchApi(queryClient, '/v1/me/api-keys', {}, { fresh: true })
    const used = (k: ApiKeyInfo) =>
      !!k.lastUsedAt &&
      !k.install &&
      (props.signIn !== null
        ? k.oauth && Date.parse(k.createdAt) >= props.since
        : props.keyId
          ? k.id === props.keyId
          : Date.parse(k.lastUsedAt) >= props.since)
    const found = keys.find(used)
    if (!found) return
    hit.value = found
    stop()
    if (props.apiKey) {
      // What this key is offered, which a narrowed key makes smaller than the session's.
      const info = await api.get('/v1/mcp/connection', { config: { headers: { Authorization: `Bearer ${props.apiKey}` } } }).catch(() => null)
      tools.value = info?.tools.length ?? null
    }
  } catch {
    /* a failed tick is retried by the next one */
  }
}

watch(
  () => [props.active, watching.value, hit.value] as const,
  ([active, watch, done]) => {
    if (!active || !watch || done) return stop()
    started.value ??= Date.now()
    if (!timer) {
      void poll()
      timer = setInterval(poll, POLL_MS)
    }
  },
  { immediate: true },
)
onBeforeUnmount(stop)

const STATUSES = ['refused', 's401', 's403', 's404', 's405', 'ok'] as const
/** With no key there is no 401 or 403 to explain. */
const statuses = computed(() => (props.needsKey ? STATUSES : STATUSES.filter((s) => s !== 's401' && s !== 's403')))
</script>

<template>
  <div class="grid min-w-0 gap-4">
    <div v-if="watching" class="flex items-start gap-3 rounded-lg border bg-card px-4 py-3.5" role="status" aria-live="polite">
      <template v-if="hit">
        <CircleCheck class="mt-0.5 size-5 shrink-0 text-panel-tip" aria-hidden="true" />
        <div class="min-w-0">
          <p class="text-sm font-medium">{{ t('connect.wizard.verify.connected') }}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {{ t('connect.wizard.verify.connectedHint', { client: clientName, name: hit.name, when: formatRelative(hit.lastUsedAt!), n: tools ?? sessionTools }) }}
          </p>
        </div>
      </template>
      <template v-else>
        <!-- Waiting is work in progress: the status dot's pulse, not a spinner (DESIGN.md: one thing moves at rest). -->
        <span class="mt-1.5 size-2.5 shrink-0 animate-pulse rounded-full bg-panel-note motion-reduce:animate-none" aria-hidden="true" />
        <div class="min-w-0">
          <p class="text-sm font-medium">
            {{ signIn !== null ? t('connect.wizard.verify.signInWaiting', { client: clientName }) : t('connect.wizard.verify.waiting', { client: clientName }) }}
          </p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {{ signIn !== null ? t('connect.wizard.verify.signInWaitingHint', { client: clientName }) : t('connect.wizard.verify.waitingHint', { client: clientName }) }}
          </p>
        </div>
      </template>
    </div>
    <div v-else class="flex items-start gap-3 rounded-lg border bg-card px-4 py-3.5">
      <CircleCheck class="mt-0.5 size-5 shrink-0 text-panel-note" aria-hidden="true" />
      <p class="kn-measure text-xs leading-relaxed text-muted-foreground">{{ t('connect.wizard.verify.devMode', { n: sessionTools }) }}</p>
    </div>

    <!-- The terminal check needs a key in the shell: a browser sign-in has none, its help opens by itself. -->
    <div v-if="needsKey && !hit && !slow">
      <Button variant="outline" size="sm" @click="asked = true">{{ t('connect.wizard.verify.showCheck') }}</Button>
    </div>

    <!-- No curl to offer a browser sign-in: the shell holds no credential for it. -->
    <p v-if="signIn !== null && slow && !hit" class="kn-measure text-xs leading-relaxed text-muted-foreground">
      {{ signIn ? t('connect.wizard.verify.signInSlow', { client: clientName, command: signIn }) : t('connect.wizard.verify.signInSlowAuto', { client: clientName }) }}
    </p>

    <section v-if="showCheck && !hit" class="grid min-w-0 gap-3">
      <p v-if="needsKey" class="kn-measure text-xs text-muted-foreground">{{ t('connect.wizard.verify.slow') }}</p>
      <CopyBlock :code="check" :label="needsKey ? t('connect.wizard.verify.check') : t('connect.wizard.verify.checkDev')" />
      <h3 class="text-xs font-medium text-muted-foreground">{{ t('connect.wizard.verify.statusTitle') }}</h3>
      <dl class="divide-y rounded-lg border">
        <div v-for="s in statuses" :key="s" class="grid gap-1 px-3.5 py-2.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
          <dt class="text-xs font-medium">{{ t(`connect.wizard.verify.statuses.${s}.code`) }}</dt>
          <dd class="text-xs leading-relaxed text-muted-foreground">{{ t(`connect.wizard.verify.statuses.${s}.fix`) }}</dd>
        </div>
      </dl>
    </section>
  </div>
</template>
