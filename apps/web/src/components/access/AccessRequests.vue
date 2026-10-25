<script setup lang="ts">
/**
 * Access requests (#76, phase 5): the managers' inbox, plus the caller's own.
 *
 * "To decide" lists what the API says the caller may decide — every request
 * for a workspace admin, the ones under nodes they manage for anyone else.
 * "Mine" is what the caller asked for. Both read one query key prefix
 * (`/v1/access-requests`), which `acl.changed` invalidates, so a request
 * approved in another tab drops out here without a reload.
 *
 * Approving asks for a level, defaulting to the one requested. The API writes
 * it on every restricted node that kept the requester out; the row says so
 * rather than leaving it to surprise anyone.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Check, KeyRound, X } from 'lucide-vue-next'
import type {
  AccessLevel,
  AccessRequestEntry,
  AccessRequestStatus,
} from '@knowledge/contracts'
import { api } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { formatRelative } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import PageState from '@/components/layout/page/PageState.vue'
import UserChip from '@/components/people/UserChip.vue'

const { t } = useI18n()

const props = defineProps<{ workspaceId: string }>()

const view = ref<'decide' | 'mine'>('decide')
const status = ref<AccessRequestStatus | 'all'>('pending')

const queryClient = useQueryClient()
const key = computed(() => [
  '/v1/access-requests',
  null,
  { workspaceId: props.workspaceId, mine: view.value === 'mine', status: status.value },
])
const requests = useQuery({
  queryKey: key,
  queryFn: async ({ signal }) =>
    await api.get('/v1/access-requests', {
      query: {
        workspaceId: props.workspaceId,
        ...(view.value === 'mine' ? { mine: '1' } : {}),
        ...(status.value !== 'all' ? { status: status.value } : {}),
      },
      signal,
    }),
})
const rows = computed(() => requests.data.value?.requests ?? [])

const LEVELS: AccessLevel[] = ['view', 'edit', 'manage']
const STATUSES: (AccessRequestStatus | 'all')[] = ['pending', 'approved', 'denied', 'expired', 'cancelled', 'all']

const busy = ref<string | null>(null)
const approving = ref<AccessRequestEntry | null>(null)
const approveLevel = ref<AccessLevel>('view')
const denying = ref<AccessRequestEntry | null>(null)
const denyReason = ref('')

function openApprove(row: AccessRequestEntry) {
  approving.value = row
  approveLevel.value = row.level
}

function openDeny(row: AccessRequestEntry) {
  denying.value = row
  denyReason.value = ''
}

async function act(row: AccessRequestEntry, path: 'approve' | 'deny' | 'cancel', body: object, done: string) {
  busy.value = row.requestId
  try {
    await api.post(`/v1/access-requests/{id}/${path}` as const, { path: { id: row.requestId }, body: body as never })
    toast.success(done)
    approving.value = null
    denying.value = null
    await queryClient.invalidateQueries({ queryKey: ['/v1/access-requests'] })
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = null
  }
}

function resourceLabel(row: AccessRequestEntry): string {
  if (row.resourceTitle) return row.resourceTitle
  return row.resourceType === 'project' ? t('access.restrictedProject') : t('access.restrictedPage')
}

function resourceLink(row: AccessRequestEntry): string {
  return row.resourceType === 'project' ? `/projects/${row.resourceId}` : `/documents/${row.resourceId}`
}

const statusVariant = (s: AccessRequestStatus) =>
  s === 'pending' ? 'default' : s === 'approved' ? 'secondary' : 'outline'
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="inline-flex rounded-md border p-0.5" role="tablist">
        <button
          v-for="v in (['decide', 'mine'] as const)"
          :key="v"
          type="button"
          role="tab"
          :aria-selected="view === v"
          class="rounded px-3 py-1 text-sm transition-colors"
          :class="view === v ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'"
          @click="view = v"
        >
          {{ t(v === 'decide' ? 'access.requests.toDecide' : 'access.requests.mine') }}
        </button>
      </div>
      <Select v-model="status">
        <SelectTrigger class="h-8 w-40" :aria-label="t('access.requests.statusFilter')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="s in STATUSES" :key="s" :value="s">{{ t(`access.requests.status.${s}`) }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <PageState v-if="requests.isPending.value" state="loading" :rows="3" row-class="h-16" />
    <PageState v-else-if="requests.isError.value" state="error" :error="requests.error.value" />
    <PageState
      v-else-if="rows.length === 0"
      state="empty"
      :icon="KeyRound"
      :title="t(view === 'decide' ? 'access.requests.emptyDecide' : 'access.requests.emptyMine')"
      :description="t('access.requests.emptyHint')"
    />

    <ul v-else class="divide-y rounded-lg border">
      <li v-for="row in rows" :key="row.requestId" class="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0 space-y-1">
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <UserChip v-if="view === 'decide'" :user-id="row.requester.userId" :name="row.requester.displayName ?? row.requester.email ?? undefined" size="sm" />
            <span class="text-muted-foreground">{{ t('access.requests.asksFor', { level: t(`access.level.${row.level}`) }) }}</span>
            <RouterLink :to="resourceLink(row)" class="truncate font-medium hover:underline">{{ resourceLabel(row) }}</RouterLink>
            <Badge :variant="statusVariant(row.status)">{{ t(`access.requests.status.${row.status}`) }}</Badge>
          </div>
          <p v-if="row.message" class="text-sm whitespace-pre-line text-muted-foreground">“{{ row.message }}”</p>
          <p v-if="row.reason" class="text-sm text-muted-foreground">{{ t('access.requests.reason', { reason: row.reason }) }}</p>
          <p class="text-xs text-muted-foreground">
            {{ formatRelative(row.createdAt) }}
            <template v-if="row.status === 'pending'"> · {{ t('access.requests.expires', { when: formatRelative(row.expiresAt) }) }}</template>
            <template v-else-if="row.decidedAt"> · {{ t('access.requests.decided', { when: formatRelative(row.decidedAt) }) }}</template>
          </p>
        </div>
        <div class="flex shrink-0 gap-2">
          <template v-if="row.status === 'pending' && row.canDecide">
            <Button size="sm" :disabled="busy === row.requestId" @click="openApprove(row)">
              <Check class="size-3.5" /> {{ t('access.requests.approve') }}
            </Button>
            <Button size="sm" variant="outline" :disabled="busy === row.requestId" @click="openDeny(row)">
              <X class="size-3.5" /> {{ t('access.requests.deny') }}
            </Button>
          </template>
          <Button
            v-else-if="row.status === 'pending' && view === 'mine'"
            size="sm"
            variant="ghost"
            :disabled="busy === row.requestId"
            @click="act(row, 'cancel', {}, t('access.requests.cancelled'))"
          >
            {{ t('access.requests.withdraw') }}
          </Button>
        </div>
      </li>
    </ul>

    <Dialog :open="!!approving" @update:open="(v) => { if (!v) approving = null }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('access.requests.approveTitle') }}</DialogTitle>
          <DialogDescription>{{ t('access.requests.approveHint') }}</DialogDescription>
        </DialogHeader>
        <div class="space-y-2">
          <Label for="approve-level">{{ t('access.requests.level') }}</Label>
          <Select v-model="approveLevel">
            <SelectTrigger id="approve-level"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="l in LEVELS" :key="l" :value="l">{{ t(`access.level.${l}`) }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="approving = null">{{ t('common.cancel') }}</Button>
          <Button
            :disabled="busy !== null"
            @click="approving && act(approving, 'approve', { level: approveLevel }, t('access.requests.approved'))"
          >
            {{ t('access.requests.approve') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!denying" @update:open="(v) => { if (!v) denying = null }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('access.requests.denyTitle') }}</DialogTitle>
          <DialogDescription>{{ t('access.requests.denyHint') }}</DialogDescription>
        </DialogHeader>
        <div class="space-y-2">
          <Label for="deny-reason">{{ t('access.requests.reasonLabel') }}</Label>
          <Textarea id="deny-reason" v-model="denyReason" rows="3" maxlength="1000" />
        </div>
        <DialogFooter>
          <Button variant="outline" @click="denying = null">{{ t('common.cancel') }}</Button>
          <Button
            variant="destructive"
            :disabled="busy !== null"
            @click="denying && act(denying, 'deny', { reason: denyReason.trim() || null }, t('access.requests.denied'))"
          >
            {{ t('access.requests.deny') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
