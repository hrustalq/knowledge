<script setup lang="ts">
/**
 * Plaud on /memos (#864): the person's own Plaud account as a source of
 * memos. One panel, in the order they act — what waits for their yes, what a
 * retry could fix, then what only Plaud can move. It collapses to a single
 * line when nothing needs them, and is absent on a server that does not offer
 * Plaud at all.
 *
 * Nothing here imports on its own: every row is a yes, a no, or (for a
 * recording Plaud has not transcribed) an explicit "transcribe here", whose
 * dialog says what it spends before it spends it.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { useDocumentVisibility } from '@vueuse/core'
import { toast } from 'vue-sonner'
import { AudioLines, ChevronRight, Hourglass, MoreVertical, RefreshCw, SlidersHorizontal, TriangleAlert } from 'lucide-vue-next'
import type { PlaudImportEntry, PlaudImportsResponse, PlaudLinkResponse, PlaudSettingsResponse } from '@knowledge/contracts'
import { openOauthTab } from '@/entities/connector'
import { api, request } from '@/shared/api/client'
import { errorMessage } from '@/shared/api/errors'
import { apiQueryOptions } from '@/shared/api/queries'
import { formatDateTime, formatDuration } from '@/shared/utils/format'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { Collapse } from '@/shared/ui/collapse'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/shared/ui/dropdown-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import PlaudRulesDialog from './PlaudRulesDialog.vue'
import { groupPlaudImports } from '../model/plaud-ui'

const props = defineProps<{ workspaceId: string }>()

const { t } = useI18n()
const queryClient = useQueryClient()
const query = { workspaceId: props.workspaceId }

const linkQuery = useQuery(apiQueryOptions('/v1/plaud/link', { query }))
const link = computed(() => linkQuery.data.value as PlaudLinkResponse | undefined)
const usable = computed(() => Boolean(link.value?.linked && !link.value.needsReconnect))

const settingsQuery = useQuery(computed(() => ({ ...apiQueryOptions('/v1/plaud/settings', { query }), enabled: usable.value })))
const settings = computed(() => settingsQuery.data.value as PlaudSettingsResponse | undefined)
const importsQuery = useQuery(computed(() => ({ ...apiQueryOptions('/v1/plaud/imports', { query }), enabled: usable.value })))
const queue = computed(() => groupPlaudImports((importsQuery.data.value as PlaudImportsResponse | undefined)?.imports ?? []))

const rulesOpen = ref(false)
const waitingOpen = ref(false)
const selected = ref(new Set<string>())
const acting = ref(false)
const linking = ref(false)
const toTranscribe = ref<PlaudImportEntry | null>(null)

/** The rows a bulk action takes: the ticked ones, or all of them when none is. */
const chosen = computed(() => {
  const ticked = queue.value.ready.filter((r) => selected.value.has(r.id))
  return ticked.length ? ticked : queue.value.ready
})
const allTicked = computed(() => queue.value.ready.length > 0 && queue.value.ready.every((r) => selected.value.has(r.id)))

/**
 * Where each recording goes (#877): the person's pick here, else what the row
 * already remembers, else the settings' project. Always sent with a yes, so a
 * recording confirmed ahead keeps the project it was confirmed for.
 */
const projects = useProjectsStore()
const picked = ref(new Map<string, string>())
const projectOf = (row: PlaudImportEntry) => picked.value.get(row.id) ?? row.projectId ?? settings.value?.projectId ?? undefined
function pick(rows: readonly PlaudImportEntry[], projectId: string) {
  const next = new Map(picked.value)
  for (const row of rows) next.set(row.id, projectId)
  picked.value = next
}

function refresh() {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['/v1/plaud/link'] }),
    queryClient.invalidateQueries({ queryKey: ['/v1/plaud/settings'] }),
    queryClient.invalidateQueries({ queryKey: ['/v1/plaud/imports'] }),
    queryClient.invalidateQueries({ queryKey: ['/v1/memos'] }),
  ])
}

async function linkAccount() {
  linking.value = true
  try {
    await openOauthTab(async () => (await api.get('/v1/plaud/authorize', { query: { ...query, returnTo: '/memos' } })).url, refresh)
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    linking.value = false
  }
}

function tick(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}

function tickAll(on: boolean) {
  selected.value = on ? new Set(queue.value.ready.map((r) => r.id)) : new Set()
}

async function act(action: 'confirm' | 'skip', rows: readonly PlaudImportEntry[]) {
  if (!rows.length || acting.value) return
  acting.value = true
  try {
    // One call per destination: a yes carries one project.
    const groups = new Map<string | undefined, string[]>()
    for (const row of rows) {
      const key = action === 'confirm' ? projectOf(row) : undefined
      groups.set(key, [...(groups.get(key) ?? []), row.id])
    }
    const done: PlaudImportEntry[] = []
    for (const [projectId, ids] of groups) {
      const res = await request('post', `/v1/plaud/imports/${action}`, { body: { workspaceId: props.workspaceId, ids, ...(projectId ? { projectId } : {}) } })
      done.push(...(res as PlaudImportsResponse).imports)
    }
    const failed = done.filter((r) => r.status === 'failed')
    // A refused import says why on its own row; the toast only points there.
    if (failed.length) toast.error(t('memos.plaud.toast.failed', failed.length))
    else if (action === 'confirm') {
      const imported = done.filter((r) => r.status === 'imported').length
      const later = done.filter((r) => r.status === 'confirmed').length
      if (imported) toast.success(t('memos.plaud.toast.imported', imported))
      if (later) toast.message(t('memos.plaud.toast.later', later))
    }
    selected.value = new Set()
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    acting.value = false
    await refresh()
  }
}

/**
 * Looks at Plaud now (#873) rather than at the sweeper's next turn, which can
 * be ten minutes off. Asked for by the button, and quietly whenever the
 * person comes (back) to a page with recordings still waiting: that is the
 * moment they have just generated a transcript in the Plaud app. The server
 * answers the list as it stands when asked twice within its floor.
 */
const checking = ref(false)
async function checkNow(quiet = false) {
  if (checking.value) return
  checking.value = true
  try {
    await request('post', '/v1/plaud/imports/refresh', { body: { workspaceId: props.workspaceId } })
    await refresh()
  } catch (e) {
    if (!quiet) toast.error(errorMessage(e, t))
  } finally {
    checking.value = false
  }
}
const visibility = useDocumentVisibility()
watch(
  () => visibility.value === 'visible' && queue.value.waiting.length > 0,
  (due) => due && void checkNow(true),
  { immediate: true },
)

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60))
const overAllowance = computed(() =>
  Boolean(toTranscribe.value && settings.value && toTranscribe.value.durationSeconds > settings.value.transcribe.remainingSeconds),
)

async function transcribe() {
  const row = toTranscribe.value
  if (!row || acting.value) return
  acting.value = true
  try {
    await request('post', '/v1/plaud/imports/transcribe', { body: { workspaceId: props.workspaceId, id: row.id, ...(projectOf(row) ? { projectId: projectOf(row) } : {}) } })
    toast.success(t('memos.plaud.toast.transcribing'))
    toTranscribe.value = null
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    acting.value = false
    await refresh()
  }
}

const meta = (row: PlaudImportEntry) =>
  [row.startAt ? formatDateTime(row.startAt) : null, formatDuration(row.durationSeconds * 1000)].filter(Boolean).join(' · ')
</script>

<template>
  <section v-if="link?.configured" class="bg-card rounded-lg border" :aria-label="t('memos.plaud.title')">
    <header class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <AudioLines class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <h2 class="text-sm font-medium">{{ t('memos.plaud.title') }}</h2>
        <p class="text-muted-foreground truncate text-xs">
          <template v-if="!link.linked">{{ t('memos.plaud.notLinked') }}</template>
          <template v-else-if="link.needsReconnect">{{ t('memos.plaud.lapsed') }}</template>
          <template v-else-if="settings && !settings.projectId">{{ t('memos.plaud.off') }}</template>
          <template v-else>{{ link.accountLabel ? t('memos.plaud.linkedAs', { account: link.accountLabel }) : t('memos.plaud.linked') }}</template>
        </p>
      </div>
      <Button v-if="!link.linked || link.needsReconnect" size="sm" :disabled="linking" @click="linkAccount">
        {{ link.needsReconnect ? t('memos.plaud.linkAgain') : t('memos.plaud.link') }}
      </Button>
      <Button v-else-if="settings" size="sm" :variant="settings.projectId ? 'outline' : 'default'" @click="rulesOpen = true">
        <SlidersHorizontal class="size-4" aria-hidden="true" />
        {{ settings.projectId ? t('memos.plaud.rules.open') : t('memos.plaud.rules.setUp') }}
      </Button>
    </header>

    <template v-if="usable && settings?.projectId">
      <p v-if="importsQuery.isError.value" role="alert" class="text-destructive border-t px-4 py-3 text-sm">{{ errorMessage(importsQuery.error.value, t) }}</p>

      <!-- What waits for a yes. -->
      <div v-if="queue.ready.length" class="border-t">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
          <label class="flex min-w-0 flex-1 basis-56 items-center gap-2.5 text-sm font-medium">
            <Checkbox :model-value="allTicked" :aria-label="t('memos.plaud.selectAll')" @update:model-value="tickAll($event === true)" />
            {{ t('memos.plaud.ready', queue.ready.length) }}
          </label>
          <!-- One group, so the pair wraps together under a long Russian heading instead of splitting. -->
          <div class="flex flex-wrap items-center gap-1">
            <Select v-if="projects.items.length > 1" :model-value="undefined" @update:model-value="pick(chosen, String($event))">
              <SelectTrigger size="sm" class="max-w-44" :aria-label="t('memos.plaud.projectForAll')">
                <SelectValue :placeholder="t('memos.plaud.projectForAll')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" :disabled="acting" @click="act('confirm', chosen)">
              {{ selected.size ? t('memos.plaud.importSelected', chosen.length) : t('memos.plaud.importAll') }}
            </Button>
            <Button size="sm" variant="ghost" :disabled="acting" @click="act('skip', chosen)">
              {{ selected.size ? t('memos.plaud.skipSelected', chosen.length) : t('memos.plaud.skipAll') }}
            </Button>
          </div>
        </div>
        <ul class="divide-y border-t">
          <li v-for="row in queue.ready" :key="row.id" class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
            <!-- The label is the hit area: the box alone is 16 px. -->
            <label class="-m-2 flex cursor-pointer p-2">
              <Checkbox :model-value="selected.has(row.id)" :aria-label="t('memos.plaud.select', { name: row.name })" @update:model-value="tick(row.id, $event === true)" />
            </label>
            <div class="min-w-0 flex-1 basis-40">
              <p class="truncate text-sm">{{ row.name }}</p>
              <p class="text-muted-foreground text-xs tabular-nums">{{ meta(row) }}</p>
            </div>
            <div class="flex flex-wrap items-center gap-1">
              <Select v-if="projects.items.length > 1" :model-value="projectOf(row)" @update:model-value="pick([row], String($event))">
                <SelectTrigger size="sm" class="h-7 max-w-44 py-0 data-[size=sm]:h-7" :aria-label="t('memos.plaud.projectFor', { name: row.name })">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" class="h-7" :disabled="acting" @click="act('confirm', [row])">{{ t('memos.plaud.import') }}</Button>
              <Button size="sm" variant="ghost" class="h-7" :disabled="acting" @click="act('skip', [row])">{{ t('memos.plaud.skip') }}</Button>
            </div>
          </li>
        </ul>
      </div>

      <!-- What was refused: the reason is the row's own, and it can be tried again. -->
      <ul v-if="queue.failed.length" class="divide-y border-t">
        <li v-for="row in queue.failed" :key="row.id" class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
          <TriangleAlert class="text-destructive size-4 shrink-0" aria-hidden="true" />
          <div class="min-w-0 flex-1 basis-40">
            <p class="truncate text-sm">{{ row.name }}</p>
            <p class="text-destructive text-xs">{{ row.error ?? t('memos.plaud.failed') }}</p>
          </div>
          <div class="flex gap-1">
            <Button size="sm" variant="outline" class="h-7" :disabled="acting" @click="act('confirm', [row])">{{ t('memos.plaud.tryAgain') }}</Button>
            <Button size="sm" variant="ghost" class="h-7" :disabled="acting" @click="act('skip', [row])">{{ t('memos.plaud.skip') }}</Button>
          </div>
        </li>
      </ul>

      <!-- What only Plaud can move. Closed by default: it is the person's to act on in another app. -->
      <div v-if="queue.waiting.length" class="border-t">
        <button
          type="button"
          class="hover:bg-muted/50 focus-visible:ring-ring flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset"
          :aria-expanded="waitingOpen"
          aria-controls="plaud-waiting"
          @click="waitingOpen = !waitingOpen"
        >
          <ChevronRight class="text-muted-foreground size-4 shrink-0 transition-transform motion-reduce:transition-none" :class="waitingOpen ? 'rotate-90' : ''" aria-hidden="true" />
          <span class="text-muted-foreground">{{ t('memos.plaud.waiting', queue.waiting.length) }}</span>
        </button>
        <Collapse :open="waitingOpen">
          <div id="plaud-waiting">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-2.5">
              <p class="text-muted-foreground kn-measure min-w-0 flex-1 basis-56 text-xs">{{ t('memos.plaud.waitingHint') }}</p>
              <Button size="sm" variant="outline" class="h-7" :disabled="checking" @click="checkNow()">
                <RefreshCw class="size-3.5" :class="checking ? 'motion-safe:animate-spin' : ''" aria-hidden="true" />
                {{ checking ? t('memos.plaud.checking') : t('memos.plaud.checkNow') }}
              </Button>
            </div>
            <ul class="divide-y border-t">
              <li v-for="row in queue.waiting" :key="row.id" class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
                <Hourglass class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
                <div class="min-w-0 flex-1 basis-40">
                  <p class="truncate text-sm">{{ row.name }}</p>
                  <p class="text-muted-foreground text-xs tabular-nums">
                    {{ meta(row) }}<template v-if="row.status === 'confirmed'"> · {{ t('memos.plaud.confirmedAhead') }}</template>
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button variant="ghost" size="icon-sm" class="text-muted-foreground shrink-0" :disabled="acting" :aria-label="t('memos.plaud.actionsFor', { name: row.name })">
                      <MoreVertical class="size-4" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" class="w-56">
                    <DropdownMenuItem v-if="settings.transcribe.enabled" @select="toTranscribe = row">{{ t('memos.plaud.transcribe.action') }}</DropdownMenuItem>
                    <DropdownMenuItem v-if="row.status === 'waiting'" @select="act('confirm', [row])">{{ t('memos.plaud.importWhenReady') }}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" @select="act('skip', [row])">{{ t('memos.plaud.skip') }}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            </ul>
          </div>
        </Collapse>
      </div>

      <p
        v-if="importsQuery.isSuccess.value && !queue.ready.length && !queue.failed.length && !queue.waiting.length"
        class="text-muted-foreground kn-measure border-t px-4 py-3 text-sm"
      >
        {{ t('memos.plaud.empty') }}
      </p>
    </template>

    <PlaudRulesDialog
      v-if="settings && link.linked"
      v-model:open="rulesOpen"
      :workspace-id="workspaceId"
      :settings="settings"
      :account-label="link.accountLabel"
      @saved="refresh"
      @unlinked="refresh"
    />

    <Dialog :open="toTranscribe !== null" @update:open="!$event && (toTranscribe = null)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('memos.plaud.transcribe.title') }}</DialogTitle>
          <DialogDescription v-if="toTranscribe && settings">
            {{ t('memos.plaud.transcribe.body', { minutes: minutes(toTranscribe.durationSeconds), left: Math.floor(settings.transcribe.remainingSeconds / 60) }) }}
          </DialogDescription>
        </DialogHeader>
        <p v-if="overAllowance" role="alert" class="text-destructive text-sm">{{ t('memos.plaud.transcribe.over') }}</p>
        <p v-else class="text-muted-foreground text-sm">
          {{ t(settings?.transcribe.speakers ? 'memos.plaud.transcribe.numberedSpeakers' : 'memos.plaud.transcribe.noSpeakers') }}
        </p>
        <DialogFooter>
          <Button variant="outline" @click="toTranscribe = null">{{ t('memos.plaud.cancel') }}</Button>
          <Button :disabled="acting || overAllowance" @click="transcribe">{{ t('memos.plaud.transcribe.confirm') }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

  </section>
</template>
