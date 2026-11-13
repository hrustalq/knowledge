<script setup lang="ts">
/**
 * /settings/memory (#994, docs/features/80): the workspace's memory banks —
 * what agents keep for themselves through the Hindsight-compatible API.
 *
 * Three states, from the outside in. The server's ceiling (`MEMORY_ENABLED`)
 * is off: the nav row is gone and this page says so instead of offering a
 * switch that does nothing. The workspace switched the section off: an admin
 * gets the switch back here — which is why this route carries no
 * `meta.feature`, unlike a bank's page — and everyone else one line. Both on:
 * the switch, how to connect a client, and the banks.
 *
 * Connecting (#1010) lists every wire into a bank: the Hindsight base URL,
 * the three MCP endpoints, the memory tool's REST endpoint with a handler to
 * paste, and the `mcp-remote` bridge for clients that start only stdio
 * servers. They all read and write the same bank.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Brain, Check, Copy, Trash2 } from 'lucide-vue-next'
import { CopyBlock } from '@/entities/access'
import type { MemoryBankListResponse, MemoryBankSummary } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { getWorkspaceId } from '@/shared/api/api'
import { useCopy } from '@/shared/composables/use-copy'
import { formatDateTime, formatRelative } from '@/shared/utils/format'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@knowledge/ui/button'
import { Checkbox } from '@knowledge/ui/checkbox'
import { PageHeader, PageState, PageTabs, panelId, tabId, type PageTab } from '@knowledge/ui/layout'
import DeleteBankDialog from '../components/DeleteBankDialog.vue'
import { BRIDGE_COMMAND, HANDLER_LANGS, MEMORY_TOOL_TYPE, memoryEndpoints, memoryToolHandler, stdioBridgeConfig, type HandlerLang } from '../model/connection'

const { t } = useI18n()
const auth = useAuthStore()
const features = useFeaturesStore()
const projects = useProjectsStore()
const queryClient = useQueryClient()
const workspaceId = getWorkspaceId()

const available = computed(() => !features.unavailable.includes('memory'))
const on = computed(() => features.isOn('memory'))

const options = apiQueryOptions('/v1/memory/banks', { query: { workspaceId } })
const listQuery = useQuery(computed(() => ({ ...options, enabled: on.value })))
const list = computed(() => listQuery.data.value as MemoryBankListResponse | undefined)

if (!projects.loaded) void projects.fetchList().catch(() => undefined)
const projectName = (id: string | null) => (id ? (projects.items.find((p) => p.projectId === id)?.name ?? t('memory.hiddenProject')) : t('memory.wholeWorkspace'))

/* ------------------------------------------------------------------ switch */

const switching = ref(false)
async function toggle(next: boolean) {
  if (switching.value) return
  switching.value = true
  try {
    await features.save(next ? features.disabled.filter((f) => f !== 'memory') : [...features.disabled, 'memory'])
    toast.success(next ? t('memory.switchedOn') : t('memory.switchedOff'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    switching.value = false
  }
}

/* -------------------------------------------------------------- connection */

const endpoints = computed(() => (list.value ? memoryEndpoints(list.value.apiUrl) : null))
const rows = computed(() =>
  endpoints.value
    ? (
        [
          ['base', t('memory.connect.baseUrl')],
          ['mcp', t('memory.connect.mcpUrl')],
          ['graph', t('memory.connect.graphUrl')],
          ['files', t('memory.connect.filesUrl')],
          ['tool', t('memory.connect.toolUrl')],
        ] as const
      ).map(([key, label]) => ({ key, label, value: endpoints.value![key] }))
    : [],
)
const copies = { base: useCopy(), mcp: useCopy(), graph: useCopy(), files: useCopy(), tool: useCopy() }

const HANDLER_SCOPE = 'memory-handler'
const lang = ref<HandlerLang>('typescript')
const langs: PageTab<HandlerLang>[] = HANDLER_LANGS.map((key) => ({ key, label: key === 'typescript' ? 'TypeScript' : 'Python' }))
const handler = computed(() => (endpoints.value ? memoryToolHandler(lang.value, endpoints.value.tool) : ''))
const bridge = computed(() => (endpoints.value ? stdioBridgeConfig(endpoints.value.graph) : ''))

/* ------------------------------------------------------------------ delete */

// Kept after the dialog closes: AlertDialogAction closes it on click, before the delete answers, and the dialog must still be mounted to report back.
const removing = ref<MemoryBankSummary | null>(null)
const removeOpen = ref(false)
function askRemove(bank: MemoryBankSummary) {
  removing.value = bank
  removeOpen.value = true
}
async function deleted(bank: MemoryBankSummary) {
  toast.success(t('memory.deleted', { bank: bank.bankId }))
  await queryClient.invalidateQueries({ queryKey: options.queryKey })
}
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-6">
    <PageHeader :title="t('memory.title')" :subtitle="t('memory.subtitle')" />

    <PageState v-if="!available" state="empty" :icon="Brain" :title="t('memory.unavailableTitle')" :description="t('memory.unavailable')" />

    <template v-else>
      <section aria-labelledby="memory-switch" class="space-y-1.5">
        <h2 id="memory-switch" class="sr-only">{{ t('memory.switch') }}</h2>
        <label v-if="auth.canAdminWorkspace" class="flex items-start gap-3">
          <Checkbox :model-value="on" :disabled="switching" class="mt-0.5" @update:model-value="(v) => toggle(v === true)" />
          <span>
            <span class="block text-sm font-medium">{{ t('memory.switch') }}</span>
            <span class="kn-measure block text-xs text-muted-foreground">{{ t('memory.switchHint') }}</span>
          </span>
        </label>
        <p v-else-if="!on" class="text-sm text-muted-foreground">{{ t('memory.offForMember') }}</p>
      </section>

      <template v-if="on">
        <section aria-labelledby="memory-connect" class="space-y-3">
          <div>
            <h2 id="memory-connect" class="text-base font-semibold">{{ t('memory.connect.title') }}</h2>
            <i18n-t keypath="memory.connect.hint" tag="p" class="kn-measure mt-0.5 text-sm text-muted-foreground" scope="global">
              <template #keys>
                <RouterLink to="/settings/ai/connect" class="text-primary underline-offset-4 hover:underline">{{ t('memory.connect.keys') }}</RouterLink>
              </template>
            </i18n-t>
          </div>
          <dl v-if="list" class="divide-y rounded-md border">
            <div v-for="row in rows" :key="row.key" class="grid gap-1 px-3 py-2 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
              <dt class="text-xs text-muted-foreground">{{ row.label }}</dt>
              <dd class="min-w-0 truncate font-mono text-ui" :title="row.value">{{ row.value }}</dd>
              <dd class="-my-1 -ml-2 justify-self-start sm:ml-0 sm:justify-self-end">
                <Button size="sm" variant="ghost" class="h-7 gap-1.5 text-muted-foreground" :aria-label="t('memory.connect.copy', { what: row.label })" @click="copies[row.key].copy(row.value)">
                  <Check v-if="copies[row.key].state.value === 'copied'" class="size-3.5" />
                  <Copy v-else class="size-3.5" />
                  {{ copies[row.key].state.value === 'copied' ? t('memory.connect.copied') : copies[row.key].state.value === 'failed' ? t('memory.connect.copyFailed') : t('memory.connect.copyShort') }}
                </Button>
              </dd>
            </div>
          </dl>

          <template v-if="list">
            <div class="space-y-2 pt-2">
              <h3 class="text-sm font-medium">{{ t('memory.connect.handlerTitle') }}</h3>
              <i18n-t keypath="memory.connect.handlerHint" tag="p" class="kn-measure text-sm text-muted-foreground" scope="global">
                <template #tool><code class="font-mono text-ui">{{ MEMORY_TOOL_TYPE }}</code></template>
              </i18n-t>
              <PageTabs v-model="lang" :tabs="langs" :label="t('memory.connect.lang')" :scope="HANDLER_SCOPE" />
              <div :id="panelId(lang, HANDLER_SCOPE)" role="tabpanel" :aria-labelledby="tabId(lang, HANDLER_SCOPE)">
                <CopyBlock :code="handler" :label="lang === 'typescript' ? 'memory.ts' : 'memory.py'" />
              </div>
            </div>

            <div class="space-y-2 pt-2">
              <h3 class="text-sm font-medium">{{ t('memory.connect.stdioTitle') }}</h3>
              <i18n-t keypath="memory.connect.stdioHint" tag="p" class="kn-measure text-sm text-muted-foreground" scope="global">
                <template #bridge><code class="font-mono text-ui break-all">{{ BRIDGE_COMMAND }}</code></template>
              </i18n-t>
              <CopyBlock :code="bridge" :label="t('memory.connect.stdioLabel')" />
            </div>
          </template>
        </section>

        <section aria-labelledby="memory-banks" class="space-y-3">
          <div>
            <h2 id="memory-banks" class="text-base font-semibold">{{ t('memory.banks.title') }}</h2>
            <p v-if="list && !list.consolidation" class="kn-measure mt-0.5 text-sm text-muted-foreground">{{ t('memory.banks.noConsolidation') }}</p>
          </div>

          <PageState v-if="listQuery.isPending.value" state="loading" :rows="3" row-class="h-11" />
          <PageState v-else-if="listQuery.isError.value" state="error" :error="listQuery.error.value" />
          <PageState v-else-if="!list?.banks.length" state="empty" :icon="Brain" :title="t('memory.banks.emptyTitle')" :description="t('memory.banks.empty')" />

          <div v-else class="overflow-x-auto rounded-md border">
            <table class="w-full text-sm">
              <thead class="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th class="px-3 py-2 font-medium">{{ t('memory.banks.bank') }}</th>
                  <th class="hidden px-3 py-2 font-medium sm:table-cell">{{ t('memory.banks.project') }}</th>
                  <th class="px-3 py-2 text-right font-medium">{{ t('memory.banks.facts') }}</th>
                  <th class="px-3 py-2 text-right font-medium">{{ t('memory.banks.observations') }}</th>
                  <th class="hidden px-3 py-2 font-medium sm:table-cell">{{ t('memory.banks.lastWrite') }}</th>
                  <th class="px-3 py-2"><span class="sr-only">{{ t('memory.banks.actions') }}</span></th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr v-for="bank in list.banks" :key="bank.id" class="align-top">
                  <td class="max-w-72 px-3 py-2">
                    <RouterLink :to="`/settings/memory/${bank.id}`" class="block truncate font-mono text-ui hover:underline" :title="bank.bankId">{{ bank.bankId }}</RouterLink>
                    <span v-if="bank.name !== bank.bankId" class="block truncate text-xs text-muted-foreground">{{ bank.name }}</span>
                  </td>
                  <td class="hidden px-3 py-2 text-muted-foreground sm:table-cell">{{ projectName(bank.projectId) }}</td>
                  <td class="px-3 py-2 text-right tabular-nums">{{ bank.facts }}</td>
                  <td class="px-3 py-2 text-right tabular-nums">{{ bank.observations }}</td>
                  <td class="hidden px-3 py-2 whitespace-nowrap text-muted-foreground sm:table-cell" :title="bank.lastWriteAt ? formatDateTime(bank.lastWriteAt) : undefined">
                    {{ bank.lastWriteAt ? formatRelative(bank.lastWriteAt) : t('memory.banks.never') }}
                  </td>
                  <td class="px-3 py-1.5 text-right">
                    <Button
                      v-if="auth.canEdit"
                      size="icon"
                      variant="ghost"
                      class="size-8 text-muted-foreground hover:text-destructive"
                      :aria-label="t('memory.delete.action', { bank: bank.bankId })"
                      @click="askRemove(bank)"
                    >
                      <Trash2 class="size-4" />
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </template>

    <DeleteBankDialog v-if="removing" v-model:open="removeOpen" :bank="removing" @deleted="deleted" />
  </div>
</template>
