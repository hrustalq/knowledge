<script setup lang="ts">
// The captures inbox (/captures, issue #73): what coding agents proposed from
// their sessions, by where it stands.
//
// The tabs are stored statuses, not the derived state. A capture whose merge
// request merged still lives under Proposed, badged "merged" — it was proposed,
// and the merge request is where it was decided. Staged is the tab that asks
// for something: a glossary term waiting on approval, or a capture that has not
// reached a merge request yet.
//
// Workspace-wide, like the merge-request list, with the project as a filter
// rather than a scope: a reviewer clearing what agents proposed should not have
// to switch projects to find the rest of it. Every narrowing goes to the
// server, because the list is cursor-paginated.
//
// One key (issue #235): `?apiKeyId=` — or the key on a row — narrows the inbox
// to everything that key proposed, and an editor can turn down what is still
// pending in one act. The dialog asks the API for a dry run first, so the
// counts it confirms are the server's, not a count of the rows loaded here.
// Like `?tab=`, the param is an opening instruction, not two-way state.
//
// Live: a `capture.*` frame, and any `merge-request.*` frame (a capture's
// merged/closed is its merge request's), invalidate `/v1/captures` through the
// live-cache rules — so there is no store to rescope and nothing to poll.
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { BookmarkPlus, KeyRound, SearchX, X } from 'lucide-vue-next'
import {
  CAPTURE_KINDS,
  type BulkRejectCapturesResponse,
  type CaptureApiKey,
  type CaptureInfo,
  type CaptureKind,
  type ListCapturesResponse,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PageLayout, PageState, PageTabs, panelId, tabId, usePageTabs, type PageTab } from '@/components/layout/page'
import CaptureRow from '@/components/captures/CaptureRow.vue'
import { CAPTURE_TABS, type CaptureTab } from '@/components/captures/capture-ui'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()
const projects = useProjectsStore()

const ALL = 'all'

const tabs = computed<PageTab<CaptureTab>[]>(() =>
  CAPTURE_TABS.map((key) => ({ key, label: t(`captures.tab.${key}`) })),
)
// `?tab=` opens a tab; bare `/captures` lands on Staged, the only tab that
// asks for anything.
const tab = usePageTabs(tabs, 'staged')

const kind = ref<CaptureKind | typeof ALL>(ALL)
const projectId = ref<string>(ALL)
const mine = ref(false)
const apiKeyId = ref<string | undefined>(typeof route.query.apiKeyId === 'string' ? route.query.apiKeyId : undefined)
const cursor = ref<string | undefined>(undefined)
const older = ref<CaptureInfo[]>([])

const queryParams = computed(() => ({
  workspaceId: getWorkspaceId(),
  status: tab.value,
  ...(kind.value !== ALL ? { kind: kind.value } : {}),
  ...(projectId.value !== ALL ? { projectId: projectId.value } : {}),
  ...(mine.value ? { mine: 'true' } : {}),
  ...(apiKeyId.value ? { apiKeyId: apiKeyId.value } : {}),
  ...(cursor.value ? { cursor: cursor.value } : {}),
}))

watch([tab, kind, projectId, mine, apiKeyId], () => {
  cursor.value = undefined
  older.value = []
})

const listQuery = useQuery(computed(() => apiQueryOptions('/v1/captures', { query: queryParams.value })))
const page = computed(() => listQuery.data.value as ListCapturesResponse | undefined)
const rows = computed(() => [...older.value, ...(page.value?.captures ?? [])])

function loadMore() {
  if (!page.value?.nextCursor) return
  older.value = rows.value
  cursor.value = page.value.nextCursor
}

const narrowed = computed(() => kind.value !== ALL || projectId.value !== ALL || mine.value || !!apiKeyId.value)
function clearNarrowing() {
  kind.value = ALL
  projectId.value = ALL
  mine.value = false
  apiKeyId.value = undefined
}

// --- one key --------------------------------------------------------------
/** The key the inbox is narrowed to, as the API named it. */
const key = ref<CaptureApiKey | null>(null)
watch(
  () => page.value?.apiKey,
  (named) => {
    if (named) key.value = named
  },
)
watch(apiKeyId, (id) => {
  if (key.value?.id !== id) key.value = null
})

const canFilterKey = (c: CaptureInfo) => auth.canEdit || c.createdBy === auth.me?.userId

const invalidates = () => [['/v1/captures']]
const bulk = useApiMutation('post', '/v1/captures/bulk-reject', { invalidates })
const confirming = ref(false)
const preview = ref<BulkRejectCapturesResponse | null>(null)
const bulkReason = ref('')

async function openBulk() {
  if (!apiKeyId.value) return
  preview.value = null
  bulkReason.value = ''
  confirming.value = true
  try {
    preview.value = (await bulk.mutateAsync({
      body: { workspaceId: getWorkspaceId(), apiKeyId: apiKeyId.value, dryRun: true },
    })) as BulkRejectCapturesResponse
  } catch (e) {
    confirming.value = false
    toast.error(errorMessage(e, t))
  }
}

const nothingPending = computed(() => !!preview.value && preview.value.rejected + preview.value.closed === 0)

async function runBulk() {
  if (!apiKeyId.value) return
  try {
    const why = bulkReason.value.trim()
    const res = (await bulk.mutateAsync({
      body: { workspaceId: getWorkspaceId(), apiKeyId: apiKeyId.value, ...(why ? { reason: why } : {}) },
    })) as BulkRejectCapturesResponse
    confirming.value = false
    toast.success(
      t('captures.bulk.done', {
        rejected: t('captures.bulk.rejectedN', { n: res.rejected }, res.rejected),
        closed: t('captures.bulk.closedN', { n: res.closed }, res.closed),
      }),
    )
    const skipped = res.skippedInFlight + res.skippedNoAccess
    if (skipped) toast.info(t('captures.bulk.skipped', { n: skipped }, skipped))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

const projectNames = computed(() => new Map(projects.items.map((p) => [p.projectId, p.name])))
</script>

<template>
  <PageLayout variant="list" :title="t('nav.captures')" :subtitle="t('captures.subtitle')">
    <template #tabs>
      <PageTabs v-model="tab" :tabs="tabs" :label="t('filters.status')" />
    </template>

    <!-- Three narrowings, each one a query param the API serves. -->
    <div class="flex flex-wrap items-center gap-2">
      <Select v-model="kind">
        <SelectTrigger class="h-8 w-auto min-w-36 text-sm" :aria-label="t('captures.filter.kind')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL">{{ t('captures.filter.allKinds') }}</SelectItem>
          <SelectItem v-for="k in CAPTURE_KINDS" :key="k" :value="k">{{ t(`captures.kind.${k}`) }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="projectId">
        <SelectTrigger class="h-8 w-auto min-w-36 text-sm" :aria-label="t('captures.filter.project')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL">{{ t('captures.filter.allProjects') }}</SelectItem>
          <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</SelectItem>
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="sm"
        :aria-pressed="mine"
        :class="mine && 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'"
        @click="mine = !mine"
      >
        {{ t('captures.filter.mine') }}
      </Button>
      <!-- The fourth narrowing has no picker: it is opened from a row's key or from Connect AI. -->
      <span
        v-if="apiKeyId"
        class="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 pr-1 pl-2.5 text-sm text-primary"
      >
        <KeyRound class="size-3.5 shrink-0" aria-hidden="true" />
        <span class="max-w-48 truncate">{{ key?.name ?? t('captures.key.unnamed') }}</span>
        <code v-if="key" class="font-mono text-xs">{{ key.prefix }}…</code>
        <span v-if="key?.revoked" class="text-xs text-destructive">{{ t('captures.key.revoked') }}</span>
        <button
          type="button"
          class="grid size-6 place-items-center rounded hover:bg-primary/15"
          :aria-label="t('captures.key.clear')"
          @click="apiKeyId = undefined"
        >
          <X class="size-3.5" aria-hidden="true" />
        </button>
      </span>
      <Button
        v-if="apiKeyId && auth.canEdit && !listQuery.isError.value"
        variant="outline"
        size="sm"
        class="text-destructive hover:text-destructive"
        :disabled="bulk.isPending.value"
        @click="openBulk"
      >
        {{ t('captures.bulk.open') }}
      </Button>
      <Button v-if="narrowed" variant="ghost" size="sm" @click="clearNarrowing">{{ t('captures.filter.clear') }}</Button>
    </div>

    <div :id="panelId(tab)" role="tabpanel" :aria-labelledby="tabId(tab)" class="flex min-w-0 flex-col gap-2">
      <PageState v-if="listQuery.isPending.value && rows.length === 0" state="loading" :rows="3" row-class="h-20" />
      <PageState v-else-if="listQuery.isError.value" state="error" :error="listQuery.error.value" />
      <PageState
        v-else-if="rows.length === 0 && narrowed"
        state="empty"
        :icon="SearchX"
        :title="t('captures.empty.narrowedTitle')"
        :description="t('captures.empty.narrowedHint')"
      />
      <PageState
        v-else-if="rows.length === 0"
        state="empty"
        :icon="BookmarkPlus"
        :title="t(`captures.empty.${tab}.title`)"
        :description="t(`captures.empty.${tab}.hint`)"
      />

      <template v-else>
        <CaptureRow
          v-for="c in rows"
          :key="c.captureId"
          :capture="c"
          :project-name="projectNames.get(c.projectId)"
          :can-decide="auth.canEdit"
          :can-filter-key="canFilterKey(c)"
          @filter-key="(id: string) => (apiKeyId = id)"
        />
        <div v-if="page?.nextCursor" class="flex justify-center pt-2">
          <Button variant="outline" size="sm" :disabled="listQuery.isFetching.value" @click="loadMore">
            {{ listQuery.isFetching.value ? t('common.loading') : t('common.loadMore') }}
          </Button>
        </div>
      </template>
    </div>

    <AlertDialog :open="confirming" @update:open="(open: boolean) => { if (!open) confirming = false }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('captures.bulk.title', { name: key?.name ?? t('captures.key.unnamed') }) }}</AlertDialogTitle>
          <AlertDialogDescription>
            <template v-if="!preview">{{ t('captures.bulk.counting') }}</template>
            <template v-else-if="nothingPending">{{ t('captures.bulk.nothing') }}</template>
            <template v-else>{{ t('captures.bulk.body') }}</template>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul v-if="preview && !nothingPending" class="list-disc space-y-0.5 pl-5 text-sm">
          <li v-if="preview.rejected">{{ t('captures.bulk.willReject', { n: preview.rejected }, preview.rejected) }}</li>
          <li v-if="preview.closed">{{ t('captures.bulk.willClose', { n: preview.closed }, preview.closed) }}</li>
        </ul>
        <p v-if="preview && preview.skippedInFlight + preview.skippedNoAccess" class="text-xs text-muted-foreground">
          {{ t('captures.bulk.willSkip', { n: preview.skippedInFlight + preview.skippedNoAccess }, preview.skippedInFlight + preview.skippedNoAccess) }}
        </p>
        <Input
          v-if="preview && !nothingPending"
          v-model="bulkReason"
          :placeholder="t('captures.reasonPlaceholder')"
          :aria-label="t('captures.reason')"
          maxlength="1000"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
          <!-- A plain button, not AlertDialogAction: the dialog stays open until the request settles. -->
          <Button
            v-if="!nothingPending"
            variant="destructive"
            :disabled="!preview || bulk.isPending.value"
            @click="runBulk"
          >
            {{ bulk.isPending.value && preview ? t('captures.rejecting') : t('captures.bulk.confirm') }}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </PageLayout>
</template>
