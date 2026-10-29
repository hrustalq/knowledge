<script setup lang="ts">
/**
 * The audit trail (#75): the first web reader of /v1/audit-logs. A workspace
 * admin sees their workspace; a platform admin may widen it to the whole
 * platform, which is the only place sign-ins show — they belong to no
 * workspace. Read-only: nothing here acts on an entry.
 *
 * Who did it is resolved against a people list read once (the members, or for
 * the platform view every account), not per row; a name it cannot resolve
 * shows as a short id, because an actor is also a synthetic name ("dev").
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { AUDIT_ACTIONS, type AuditLogEntry, type ListUsersResponse, type ListWorkspaceMembersResponse } from '@knowledge/contracts'
import { apiInfiniteQueryOptions, apiQueryOptions } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { formatDateTime } from '@/shared/utils/format'
import { labelFor } from '@/shared/i18n/labels'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/shared/ui/button'
import { PageState } from '@/shared/layout'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/shared/ui/table'

const { t } = useI18n()
const auth = useAuthStore()

// A Select item cannot carry the empty string, so "no filter" needs a value of its own.
const ALL = '__all__'
const action = ref<string>(ALL)
const scope = ref<'workspace' | 'platform'>('workspace')
const workspaceId = getWorkspaceId()

const filter = computed(() => (action.value === ALL ? {} : { action: action.value }))

const workspaceLog = useInfiniteQuery(
  computed(() => ({
    ...apiInfiniteQueryOptions('/v1/audit-logs', { query: { workspaceId, ...filter.value } }),
    enabled: scope.value === 'workspace',
  })),
)
const platformLog = useInfiniteQuery(
  computed(() => ({
    ...apiInfiniteQueryOptions('/v1/admin/audit-logs', { query: filter.value }),
    enabled: scope.value === 'platform' && auth.isAdmin,
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
  computed(() => ({ ...apiQueryOptions('/v1/users'), enabled: scope.value === 'platform' && auth.isAdmin })),
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
</script>

<template>
  <section class="flex min-w-0 flex-col gap-4">
    <div>
      <h2 class="font-display text-lg font-semibold tracking-tight">{{ t('security.audit.title') }}</h2>
      <p class="mt-0.5 text-sm text-muted-foreground">{{ t('security.audit.hint') }}</p>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <div v-if="auth.isAdmin" class="flex gap-1" role="group" :aria-label="t('security.audit.scope.label')">
        <Button
          v-for="s in (['workspace', 'platform'] as const)"
          :key="s"
          size="sm"
          :variant="scope === s ? 'default' : 'outline'"
          :aria-pressed="scope === s"
          @click="scope = s"
        >{{ t(`security.audit.scope.${s}`) }}</Button>
      </div>
      <Select v-model="action">
        <SelectTrigger class="h-8 w-auto min-w-44 text-sm" :aria-label="t('security.audit.filter.label')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL">{{ t('security.audit.filter.all') }}</SelectItem>
          <SelectItem v-for="a in AUDIT_ACTIONS" :key="a" :value="a">{{ actionLabel(a) }}</SelectItem>
        </SelectContent>
      </Select>
    </div>
    <p v-if="scope === 'platform'" class="text-xs text-muted-foreground">{{ t('security.audit.platformHint') }}</p>

    <PageState v-if="log.isPending.value" state="loading" :rows="4" row-class="h-9" />
    <PageState v-else-if="log.isError.value" state="error" :error="log.error.value" />
    <PageState
      v-else-if="!entries.length"
      state="empty"
      :title="action === ALL ? t('security.audit.empty') : t('security.audit.emptyFiltered')"
    />
    <div v-else class="min-w-0 overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('security.audit.columns.when') }}</TableHead>
            <TableHead>{{ t('security.audit.columns.action') }}</TableHead>
            <TableHead>{{ t('security.audit.columns.actor') }}</TableHead>
            <TableHead>{{ t('security.audit.columns.target') }}</TableHead>
            <TableHead>{{ t('security.audit.columns.ip') }}</TableHead>
            <TableHead>{{ t('security.audit.columns.result') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="e in entries" :key="e.id">
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
