<script setup lang="ts">
/**
 * The audit trail (#75): the first web reader of /v1/audit-logs. A workspace
 * admin sees their workspace; a platform admin may widen it to the whole
 * platform, which is the only place sign-ins show — they belong to no
 * workspace. Read-only: nothing here acts on an entry.
 *
 * Every filter is applied by the API (#1251), so the list and the CSV/JSON
 * export answer the same question: the export sends exactly this query. A
 * subject has no picker (it may be any id); a row's details offer "only this
 * actor / subject" instead, which is the way one is ever found.
 *
 * Who did it is resolved against a people list read once (the members, or for
 * the platform view every account), not per row; a name it cannot resolve
 * shows as a short id, because an actor is also a synthetic name ("dev").
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { ChevronRight, CircleCheck, Download, Layers, Tag, User, Crosshair } from 'lucide-vue-next'
import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  auditActionsIn,
  type AuditCategory,
  type AuditLogEntry,
  type ListUsersResponse,
  type ListWorkspaceMembersResponse,
} from '@knowledge/contracts'
import { apiInfiniteQueryOptions, apiQueryOptions } from '@/shared/api/queries'
import { getWorkspaceId, saveFile } from '@/shared/api/api'
import { requestFile } from '@/shared/api/client'
import { errorMessage } from '@/shared/api/errors'
import { formatDateTime } from '@/shared/utils/format'
import { labelFor } from '@/shared/i18n/labels'
import { usePermission } from '@/stores/permissions'
import { Button } from '@knowledge/ui/button'
import { Input } from '@knowledge/ui/input'
import { PageState } from '@knowledge/ui/layout'
import { FilterBar, type ActiveFilter, type FilterField } from '@knowledge/ui/filter-bar'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@knowledge/ui/table'

const { t } = useI18n()
const isPlatformAdmin = usePermission('platform:admin')

const scope = ref<'workspace' | 'platform'>('workspace')
const workspaceId = getWorkspaceId()

// --- filters ---------------------------------------------------------------
const filters = ref<ActiveFilter[]>([])
/** Local calendar days, YYYY-MM-DD — what `<input type="date">` speaks. Both inclusive. */
const fromDay = ref('')
const toDay = ref('')

/** The one value a single-pick `is` chip holds, or undefined while it is unfilled. */
function picked(key: string): string | undefined {
  const f = filters.value.find((x) => x.key === key && x.operator === 'is')
  return f?.values[0] || undefined
}

const category = computed(() => picked('category') as AuditCategory | undefined)

const query = computed(() => {
  const q: Record<string, string> = {}
  for (const key of ['category', 'action', 'actor', 'target', 'ok'] as const) {
    const v = picked(key)
    if (v) q[key] = v
  }
  // A day is the viewer's day: from its first to its last local millisecond.
  if (fromDay.value) q.from = new Date(`${fromDay.value}T00:00:00`).toISOString()
  if (toDay.value) q.to = new Date(`${toDay.value}T23:59:59.999`).toISOString()
  return q
})
const filtered = computed(() => Object.keys(query.value).length > 0)

function only(key: 'actor' | 'target', value: string) {
  filters.value = [...filters.value.filter((f) => f.key !== key), { key, operator: 'is', values: [value] }]
}
function clearAll() {
  filters.value = []
  fromDay.value = ''
  toDay.value = ''
}

// --- data ------------------------------------------------------------------
const workspaceLog = useInfiniteQuery(
  computed(() => ({
    ...apiInfiniteQueryOptions('/v1/audit-logs', { query: { workspaceId, ...query.value } }),
    enabled: scope.value === 'workspace',
  })),
)
const platformLog = useInfiniteQuery(
  computed(() => ({
    ...apiInfiniteQueryOptions('/v1/admin/audit-logs', { query: query.value }),
    enabled: scope.value === 'platform' && isPlatformAdmin.value,
  })),
)
const log = computed(() => (scope.value === 'platform' ? platformLog : workspaceLog))
const entries = computed<AuditLogEntry[]>(() =>
  (log.value.data.value?.pages ?? []).flatMap((p) => (p as { entries: AuditLogEntry[] }).entries),
)

const members = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/workspaces/{id}/members', { path: { id: workspaceId } }),
    enabled: scope.value === 'workspace',
  })),
)
const users = useQuery(
  computed(() => ({ ...apiQueryOptions('/v1/users'), enabled: scope.value === 'platform' && isPlatformAdmin.value })),
)
const names = computed(() => {
  const map = new Map<string, string>()
  for (const m of (members.data.value as ListWorkspaceMembersResponse | undefined)?.members ?? []) map.set(m.userId, m.displayName)
  for (const u of (users.data.value as ListUsersResponse | undefined)?.users ?? []) map.set(u.userId, u.displayName)
  return map
})

function person(id: string | null): string {
  if (!id) return '—'
  if (id === 'anonymous') return t('security.audit.anonymous')
  return names.value.get(id) ?? (id.length > 12 ? `${id.slice(0, 8)}…` : id)
}

// Message keys cannot hold a dot (`acl.request` would shadow `acl.request.approve`),
// so the catalogue spells them with `_`; an action it does not know shows raw.
function actionLabel(a: string): string {
  const key = a.replaceAll('.', '_')
  const label = labelFor(t, 'security.audit.actions', key)
  return label === key ? a : label
}

const filterFields = computed<FilterField[]>(() => {
  const single = { multiple: false, operators: ['is' as const] }
  return [
    {
      key: 'category',
      label: t('security.audit.filter.category'),
      icon: Layers,
      ...single,
      options: AUDIT_CATEGORIES.map((c) => ({ value: c, label: t(`security.audit.categories.${c}`) })),
    },
    {
      key: 'action',
      label: t('security.audit.filter.action'),
      icon: Tag,
      ...single,
      // Narrowed to the chosen category: an action outside it would match nothing.
      options: (category.value ? auditActionsIn(category.value) : AUDIT_ACTIONS).map((a) => ({ value: a, label: actionLabel(a) })),
    },
    {
      key: 'actor',
      label: t('security.audit.filter.actor'),
      icon: User,
      ...single,
      options: [...names.value].map(([value, label]) => ({ value, label })),
    },
    {
      key: 'target',
      label: t('security.audit.filter.target'),
      icon: Crosshair,
      type: 'text',
      operators: ['is'],
      placeholder: t('security.audit.filter.targetPlaceholder'),
    },
    {
      key: 'ok',
      label: t('security.audit.filter.result'),
      icon: CircleCheck,
      ...single,
      options: [
        { value: 'true', label: t('common.ok') },
        { value: 'false', label: t('common.failed') },
      ],
    },
  ]
})

// --- details ---------------------------------------------------------------
const open = ref(new Set<string>())
function toggle(id: string) {
  const next = new Set(open.value)
  if (!next.delete(id)) next.add(id)
  open.value = next
}
const hasParams = (e: AuditLogEntry) => Object.keys(e.params ?? {}).length > 0

// --- export ----------------------------------------------------------------
const exporting = ref<'csv' | 'json' | null>(null)
async function exportAs(format: 'csv' | 'json') {
  exporting.value = format
  try {
    const { blob, filename } =
      scope.value === 'platform'
        ? await requestFile('get', '/v1/admin/audit-logs/export', { query: { ...query.value, format }, config: { timeout: 0 } })
        : await requestFile('get', '/v1/audit-logs/export', { query: { workspaceId, ...query.value, format }, config: { timeout: 0 } })
    saveFile(blob, filename ?? `audit.${format}`)
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    exporting.value = null
  }
}
</script>

<template>
  <section class="flex min-w-0 flex-col gap-4">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div class="min-w-0">
        <h2 class="font-display text-lg font-semibold tracking-tight">{{ t('security.audit.title') }}</h2>
        <p class="mt-0.5 text-sm text-muted-foreground">{{ t('security.audit.hint') }}</p>
      </div>
      <div class="flex items-center gap-1" role="group" :aria-label="t('security.audit.export.label')">
        <Button
          v-for="f in (['csv', 'json'] as const)"
          :key="f"
          variant="outline"
          size="sm"
          :disabled="exporting !== null"
          :title="t('security.audit.export.hint')"
          @click="exportAs(f)"
        >
          <Download class="size-3.5" aria-hidden="true" />
          {{ exporting === f ? t('security.audit.export.working') : t(`security.audit.export.${f}`) }}
        </Button>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <div v-if="isPlatformAdmin" class="flex gap-1" role="group" :aria-label="t('security.audit.scope.label')">
        <Button
          v-for="s in (['workspace', 'platform'] as const)"
          :key="s"
          size="sm"
          :variant="scope === s ? 'default' : 'outline'"
          :aria-pressed="scope === s"
          @click="scope = s"
        >{{ t(`security.audit.scope.${s}`) }}</Button>
      </div>
      <FilterBar v-model="filters" :fields="filterFields" :empty-label="t('security.audit.filter.empty')" />
      <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <label for="audit-from">{{ t('security.audit.filter.from') }}</label>
        <Input id="audit-from" v-model="fromDay" type="date" :max="toDay || undefined" class="h-8 w-auto text-xs" />
        <label for="audit-to">{{ t('security.audit.filter.to') }}</label>
        <Input id="audit-to" v-model="toDay" type="date" :min="fromDay || undefined" class="h-8 w-auto text-xs" />
      </div>
      <Button v-if="filtered" variant="ghost" size="sm" @click="clearAll">{{ t('security.audit.filter.clear') }}</Button>
    </div>
    <p v-if="scope === 'platform'" class="text-xs text-muted-foreground">{{ t('security.audit.platformHint') }}</p>

    <PageState v-if="log.isPending.value" state="loading" :rows="4" row-class="h-9" />
    <PageState v-else-if="log.isError.value" state="error" :error="log.error.value" />
    <PageState
      v-else-if="!entries.length"
      state="empty"
      :title="filtered ? t('security.audit.emptyFiltered') : t('security.audit.empty')"
    />
    <div v-else class="min-w-0 overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="w-8"><span class="sr-only">{{ t('security.audit.detail.toggle') }}</span></TableHead>
            <TableHead>{{ t('security.audit.columns.when') }}</TableHead>
            <TableHead>{{ t('security.audit.columns.action') }}</TableHead>
            <TableHead>{{ t('security.audit.columns.actor') }}</TableHead>
            <TableHead>{{ t('security.audit.columns.target') }}</TableHead>
            <TableHead>{{ t('security.audit.columns.ip') }}</TableHead>
            <TableHead>{{ t('security.audit.columns.result') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-for="e in entries" :key="e.id">
            <TableRow>
              <TableCell class="w-8 pr-0">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  :aria-expanded="open.has(e.id)"
                  :aria-controls="`audit-detail-${e.id}`"
                  :aria-label="t('security.audit.detail.toggle')"
                  @click="toggle(e.id)"
                >
                  <ChevronRight
                    class="size-4 transition-transform motion-reduce:transition-none"
                    :class="open.has(e.id) && 'rotate-90'"
                    aria-hidden="true"
                  />
                </Button>
              </TableCell>
              <TableCell class="whitespace-nowrap text-xs text-muted-foreground">{{ formatDateTime(e.createdAt) }}</TableCell>
              <TableCell class="text-sm">{{ actionLabel(e.action) }}</TableCell>
              <TableCell class="text-sm">{{ person(e.actor) }}</TableCell>
              <TableCell class="text-sm">{{ person(e.target) }}</TableCell>
              <TableCell class="font-mono text-xs">{{ e.ip ?? '—' }}</TableCell>
              <TableCell class="text-sm">
                <span :class="e.ok ? 'text-muted-foreground' : 'font-medium text-destructive'">
                  {{ e.ok ? t('common.ok') : t('common.failed') }}
                </span>
              </TableCell>
            </TableRow>
            <TableRow v-if="open.has(e.id)" :id="`audit-detail-${e.id}`" class="bg-muted/30 hover:bg-muted/30">
              <TableCell />
              <TableCell colspan="6" class="py-3">
                <!-- Pinned to the visible width: on a narrow screen the table scrolls sideways, the details should not. -->
                <dl class="sticky left-0 grid max-w-[calc(100vw-6rem)] gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[auto_1fr]">
                  <dt class="text-muted-foreground">{{ t('security.audit.columns.actor') }}</dt>
                  <dd class="flex min-w-0 flex-wrap items-center gap-2">
                    <span class="break-all font-mono">{{ e.actor }}</span>
                    <Button variant="link" size="xs" class="h-auto p-0" @click="only('actor', e.actor)">
                      {{ t('security.audit.detail.onlyActor') }}
                    </Button>
                  </dd>
                  <template v-if="e.target">
                    <dt class="text-muted-foreground">{{ t('security.audit.columns.target') }}</dt>
                    <dd class="flex min-w-0 flex-wrap items-center gap-2">
                      <span class="break-all font-mono">{{ e.target }}</span>
                      <Button variant="link" size="xs" class="h-auto p-0" @click="only('target', e.target)">
                        {{ t('security.audit.detail.onlyTarget') }}
                      </Button>
                    </dd>
                  </template>
                  <template v-if="e.error">
                    <dt class="text-muted-foreground">{{ t('security.audit.detail.error') }}</dt>
                    <dd class="break-words text-destructive">{{ e.error }}</dd>
                  </template>
                  <template v-if="e.rowCount !== null">
                    <dt class="text-muted-foreground">{{ t('security.audit.detail.rows') }}</dt>
                    <dd class="tabular-nums">{{ e.rowCount }}</dd>
                  </template>
                  <template v-if="e.durationMs !== null">
                    <dt class="text-muted-foreground">{{ t('security.audit.detail.duration') }}</dt>
                    <dd class="tabular-nums">{{ t('security.audit.detail.ms', { n: e.durationMs }) }}</dd>
                  </template>
                  <dt class="text-muted-foreground">{{ t('security.audit.detail.params') }}</dt>
                  <dd class="min-w-0">
                    <pre
                      v-if="hasParams(e)"
                      class="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-background p-2 font-mono text-[0.7rem] leading-relaxed"
                    >{{ JSON.stringify(e.params, null, 2) }}</pre>
                    <span v-else class="text-muted-foreground">{{ t('security.audit.detail.noParams') }}</span>
                  </dd>
                </dl>
              </TableCell>
            </TableRow>
          </template>
        </TableBody>
      </Table>
    </div>

    <div v-if="log.hasNextPage.value">
      <Button variant="outline" size="sm" :disabled="log.isFetchingNextPage.value" @click="log.fetchNextPage()">
        {{ log.isFetchingNextPage.value ? t('common.loadingMore') : t('common.loadMore') }}
      </Button>
    </div>
  </section>
</template>
