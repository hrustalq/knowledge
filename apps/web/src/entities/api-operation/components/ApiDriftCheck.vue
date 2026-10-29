<script setup lang="ts">
/**
 * "Check against the code" for an OpenAPI spec a repository syncs (#78,
 * phase 8): queues the sentinel's on-demand comparison, polls the run, and
 * lists what disagrees — the spec's operations no route serves, the routes no
 * spec documents, and the paths whose methods differ.
 *
 * The run is the only record, so nothing is kept past the page: a reload
 * starts over, and the same run is returned while one is still going.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Loader2, ScanSearch } from 'lucide-vue-next'
import type { AgentRunSummary, ApiDriftKind, ApiDriftMismatch } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { Button } from '@/shared/ui/button'
import { getWorkspaceId } from '@/shared/api/api'
import type { ApiTone as Tone } from '@/entities/api-operation/model/api-spec'
import ApiTone from './ApiTone.vue'

const props = defineProps<{ documentId: string }>()
const { t } = useI18n()

const POLL_MS = 3_000
const SHOWN = 12
const TONES: Record<ApiDriftKind, Tone> = { 'missing-in-code': 'caution', 'method-mismatch': 'warning', 'missing-in-spec': 'note' }

const runId = ref<string | null>(null)
const start = useApiMutation('post', '/v1/api-specs/{id}/drift-check')
const startError = ref<string | null>(null)

async function check() {
  startError.value = null
  try {
    const res = await start.mutateAsync({ path: { id: props.documentId } })
    runId.value = (res as { runId: string }).runId
  } catch (e) {
    startError.value = (e as Error).message
  }
}

const query = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/ai/agents/runs/{id}', {
      path: { id: runId.value ?? '' },
      query: { workspaceId: getWorkspaceId() },
    }),
    enabled: !!runId.value,
    refetchInterval: (q: { state: { data: unknown } }) => (finished(q.state.data as AgentRunSummary | undefined) ? false : POLL_MS),
  })),
)
const run = computed(() => (runId.value ? (query.data.value as AgentRunSummary | undefined) : undefined))
const running = computed(() => start.isPending.value || (!!runId.value && !finished(run.value)))
const drift = computed(() => run.value?.findings.find((f) => f.apiDrift)?.apiDrift ?? null)
const shown = computed(() => drift.value?.mismatches.slice(0, SHOWN) ?? [])
const more = computed(() => (drift.value ? drift.value.mismatchTotal - shown.value.length : 0))

function finished(r: AgentRunSummary | undefined): boolean {
  return !!r && (r.status === 'succeeded' || r.status === 'failed' || r.status === 'cancelled')
}

function subject(m: ApiDriftMismatch): string {
  return `${m.methods.map((x) => (x === '*' ? 'ANY' : x)).join(', ')} ${m.path}`
}
</script>

<template>
  <div class="space-y-2">
    <Button size="sm" variant="outline" :disabled="running" @click="check">
      <Loader2 v-if="running" class="size-3.5 animate-spin" aria-hidden="true" />
      <ScanSearch v-else class="size-3.5" aria-hidden="true" />
      {{ running ? t('apiDrift.checking') : t('apiDrift.check') }}
    </Button>

    <p v-if="startError" class="text-xs text-destructive">{{ startError }}</p>
    <p v-else-if="run && (run.status === 'failed' || run.status === 'cancelled')" class="text-xs text-destructive">
      {{ run.error || t('apiDrift.failed') }}
    </p>
    <div v-else-if="run && run.status === 'succeeded'" class="space-y-2" role="status">
      <p class="text-xs text-muted-foreground">{{ run.summary }}</p>
      <p v-for="w in run.warnings" :key="w" class="text-xs text-muted-foreground">{{ w }}</p>
      <ul v-if="shown.length" class="space-y-1.5">
        <li v-for="(m, i) in shown" :key="i" class="space-y-0.5 text-xs">
          <div class="flex flex-wrap items-center gap-1.5">
            <ApiTone :tone="TONES[m.kind]" size="sm" class="px-1.5">{{ t(`apiDrift.kind.${m.kind}`) }}</ApiTone>
            <code class="font-mono text-xs break-all text-foreground">{{ subject(m) }}</code>
          </div>
          <p v-if="m.codeMethods?.length" class="text-muted-foreground">{{ t('apiDrift.codeServes', { methods: m.codeMethods.join(', ') }) }}</p>
          <p v-if="m.file" class="truncate font-mono text-caption text-muted-foreground" :title="m.file">
            {{ m.file }}<template v-if="m.line">:{{ m.line }}</template>
          </p>
        </li>
      </ul>
      <p v-if="more > 0" class="text-xs text-muted-foreground">{{ t('apiDrift.more', { n: more }, more) }}</p>
    </div>
  </div>
</template>
