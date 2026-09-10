<script setup lang="ts">
// Access control management: workspaces + member roles (RBAC lives in the API;
// mutations here are admin-only and 403 for everyone else).
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { AtSign, Library, ShieldCheck, UserPlus, Wrench } from 'lucide-vue-next'
import type {
  ListWorkspaceCandidatesResponse,
  ListWorkspaceMembersResponse,
  ListWorkspacesResponse,
  WorkspaceCandidate,
  WorkspaceMemberEntry,
  WorkspaceRole,
  WorkspaceSummary,
} from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { Autocomplete, type AutocompleteOption } from '@/components/ui/autocomplete'
import { Badge } from '@/components/ui/badge'
import UserChip from '@/components/people/UserChip.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  FilterBar,
  filterRows,
  type ActiveFilter,
  type FilterAccessors,
  type FilterField,
} from '@/components/ui/filter-bar'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

const { t } = useI18n()

const ROLES: WorkspaceRole[] = ['viewer', 'editor', 'admin']

const auth = useAuthStore()
const workspaces = ref<WorkspaceSummary[]>([])
const selected = ref<string>(getWorkspaceId())
const members = ref<WorkspaceMemberEntry[]>([])
const loadingMembers = ref(false)

const addRole = ref<WorkspaceRole>('viewer')
const addOpen = ref(false)

// --- filters ---------------------------------------------------------------
// The roster for one workspace is small and already loaded, so every field
// matches client-side against the in-memory members.
const filters = ref<ActiveFilter[]>([
  { key: 'workspace', operator: 'is', values: [selected.value] },
])

const WORKSPACE_KEY = 'workspace'

const filterFields = computed<FilterField[]>(() => [
  {
    // A scope, not a predicate: it decides whose roster is fetched, so it is
    // pinned to the bar and has no accessor — `matchesFilters` ignores keys it
    // has no accessor for, which is exactly right here.
    key: WORKSPACE_KEY,
    label: t('filter.workspace'),
    icon: Library,
    pinned: true,
    multiple: false,
    operators: ['is'],
    options: workspaceOptions.value,
  },
  {
    key: 'role',
    label: t('filter.role'),
    icon: ShieldCheck,
    options: ROLES.map((r) => ({ value: r, label: r })),
  },
  {
    key: 'trustedOperator',
    label: t('filter.trustedOperator'),
    icon: Wrench,
    options: [
      { value: 'true', label: t('common.yes') },
      { value: 'false', label: t('common.no') },
    ],
  },
  {
    key: 'text',
    label: t('filter.nameOrEmail'),
    icon: AtSign,
    group: t('filter.groupText'),
    type: 'text',
    placeholder: 'alice@…',
  },
])

const filterAccessors: FilterAccessors<WorkspaceMemberEntry> = {
  role: (m) => m.role,
  trustedOperator: (m) => m.trustedOperator,
  text: (m) => [m.displayName, m.email],
}

const visibleMembers = computed(() => filterRows(members.value, filters.value, filterAccessors))

// --- pickers ---------------------------------------------------------------
// Both fields are "find an existing record", so both are autocompletes rather
// than a <select> and a typed email.

const workspaceOptions = computed(() =>
  workspaces.value.map((w) => ({
    value: w.workspaceId,
    label: w.name,
    meta: w.myRole ? `${w.memberCount} · ${w.myRole}` : String(w.memberCount),
  })),
)

/**
 * Candidate lookup is server-side and workspace-scoped (existing members are
 * filtered out there), so the picker never offers someone already on the list.
 */
const candidateCache = new Map<string, WorkspaceCandidate>()
async function loadCandidates(query: string): Promise<AutocompleteOption[]> {
  if (!selected.value) return []
  const params = new URLSearchParams({ limit: '20' })
  if (query.trim()) params.set('q', query.trim())
  const res = await apiFetch<ListWorkspaceCandidatesResponse>(
    `/v1/workspaces/${selected.value}/candidates?${params}`,
  )
  for (const c of res.candidates) candidateCache.set(c.userId, c)
  return res.candidates.map((c) => ({
    value: c.userId,
    label: `${c.displayName} · ${c.email}`,
    meta: c.disabled ? 'disabled' : undefined,
  }))
}

/** Held between pick and submit — `addMember` posts the email, not the id. */
const pickedUser = ref<WorkspaceCandidate | null>(null)
const pickedValue = computed<string[]>({
  get: () => (pickedUser.value ? [pickedUser.value.userId] : []),
  set: (v) => {
    pickedUser.value = v[0] ? (candidateCache.get(v[0]) ?? null) : null
  },
})
// A candidate of the previous workspace is not a candidate of the next one.
watch(selected, () => {
  pickedUser.value = null
  candidateCache.clear()
})

const selectedWorkspace = computed(() => workspaces.value.find((w) => w.workspaceId === selected.value))
/** Can the caller manage the selected workspace? (dev + platform admins always can) */
const canManage = computed(
  () => auth.isDev || auth.isAdmin || selectedWorkspace.value?.myRole === 'admin',
)

async function loadWorkspaces() {
  try {
    workspaces.value = (await apiFetch<ListWorkspacesResponse>('/v1/workspaces')).workspaces
    if (!workspaces.value.some((w) => w.workspaceId === selected.value) && workspaces.value.length > 0) {
      selected.value = workspaces.value[0].workspaceId
    }
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function loadMembers() {
  if (!selected.value) return
  loadingMembers.value = true
  try {
    members.value = (await apiFetch<ListWorkspaceMembersResponse>(`/v1/workspaces/${selected.value}/members`)).members
  } catch (e) {
    members.value = []
    toast.error((e as Error).message)
  } finally {
    loadingMembers.value = false
  }
}

onMounted(async () => {
  await loadWorkspaces()
  await loadMembers()
})
watch(selected, loadMembers)

// The scope lives in two places — the chip the user clicks, and `selected`,
// which `loadWorkspaces` may also rewrite when the stored id is stale. Mirror
// them in both directions, guarding on equality so neither watcher re-triggers
// the other.
watch(
  filters,
  (list) => {
    const next = list.find((f) => f.key === WORKSPACE_KEY)?.values[0]
    if (next && next !== selected.value) selected.value = next
  },
  { deep: true },
)
watch(selected, (next) => {
  const chip = filters.value.find((f) => f.key === WORKSPACE_KEY)
  if (chip && chip.values[0] !== next) chip.values = [next]
})

async function addMember() {
  const user = pickedUser.value
  if (!user) return
  try {
    const res = await apiFetch<ListWorkspaceMembersResponse>(`/v1/workspaces/${selected.value}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: user.email, role: addRole.value }),
    })
    members.value = res.members
    toast.success(t('access.memberAdded', { email: user.email, role: t(`role.${addRole.value}`) }))
    addOpen.value = false
    pickedUser.value = null
    candidateCache.delete(user.userId) // now a member — no longer a candidate
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function patchMember(member: WorkspaceMemberEntry, patch: Record<string, unknown>) {
  try {
    const res = await apiFetch<ListWorkspaceMembersResponse>(
      `/v1/workspaces/${selected.value}/members/${member.userId}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    )
    members.value = res.members
    toast.success(t('access.memberUpdated', { email: member.email }))
  } catch (e) {
    toast.error((e as Error).message)
    await loadMembers() // roll back the optimistic role/flag state
  }
}

async function removeMember(member: WorkspaceMemberEntry) {
  try {
    const res = await apiFetch<ListWorkspaceMembersResponse>(
      `/v1/workspaces/${selected.value}/members/${member.userId}`,
      { method: 'DELETE' },
    )
    members.value = res.members
    toast.success(t('access.memberRemoved', { email: member.email }))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('access.title') }}</h1>
      <Button v-if="canManage" size="sm" @click="addOpen = true">
        <UserPlus class="size-3.5" /> {{ t('access.addMember') }}
      </Button>
      <Badge v-else variant="outline">{{ t('access.readOnly') }}</Badge>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <FilterBar v-model="filters" :fields="filterFields" />
      <p class="text-muted-foreground text-xs tabular-nums">
        {{ t('documents.ofMembers', { shown: visibleMembers.length, total: t('count.members', { n: members.length }, members.length) }) }}
      </p>
    </div>

    <div v-if="loadingMembers" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-10 w-full" />
    </div>
    <p v-else-if="members.length === 0" class="text-muted-foreground py-10 text-center text-sm">
      {{ t('access.noMembersVisible') }}
    </p>
    <p v-else-if="visibleMembers.length === 0" class="text-muted-foreground py-10 text-center text-sm">
      {{ t('access.noMembersMatch') }}
    </p>

    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('access.member') }}</TableHead>
          <TableHead>{{ t('access.role') }}</TableHead>
          <TableHead>{{ t('access.trustedOperator') }}</TableHead>
          <TableHead class="text-right">{{ t('access.actions') }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="member in visibleMembers" :key="member.userId">
          <TableCell>
            <div class="flex items-center gap-1.5">
              <UserChip :user-id="member.userId" :name="member.displayName" class="font-medium" />
              <Badge v-if="member.disabled" variant="destructive">{{ t('access.disabled') }}</Badge>
            </div>
            <div class="text-muted-foreground pl-[1.875rem] text-xs">{{ member.email }}</div>
          </TableCell>
          <TableCell>
            <Select
              v-if="canManage"
              :model-value="member.role"
              @update:model-value="patchMember(member, { role: $event as string })"
            >
              <SelectTrigger size="sm" class="text-sm" :aria-label="`Role for ${member.displayName}`">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="r in ROLES" :key="r" :value="r">{{ r }}</SelectItem>
              </SelectContent>
            </Select>
            <Badge v-else variant="outline">{{ member.role }}</Badge>
          </TableCell>
          <TableCell>
            <Checkbox
              v-if="canManage"
              :model-value="member.trustedOperator"
              :aria-label="`Trusted operator for ${member.displayName}`"
              @update:model-value="patchMember(member, { trustedOperator: $event === true })"
            />
            <span v-else class="text-muted-foreground text-sm">{{ member.trustedOperator ? 'yes' : 'no' }}</span>
          </TableCell>
          <TableCell class="text-right">
            <Button v-if="canManage" size="sm" variant="destructive" @click="removeMember(member)">{{ t('access.remove') }}</Button>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>

    <Dialog v-model:open="addOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('access.addMember') }}</DialogTitle>
          <DialogDescription>
            {{ t('access.pickerSearchesNonMembers') }}
          </DialogDescription>
        </DialogHeader>
        <form id="add-member" class="space-y-3" @submit.prevent="addMember">
          <Autocomplete
            v-model="pickedValue"
            :label="t('access.user')"
            :placeholder="t('access.searchUsers')"
            :multiple="false"
            :load="loadCandidates"
          />
          <div class="space-y-1.5">
            <Label
              for="add-role"
              class="text-muted-foreground block text-[11px] font-semibold tracking-wider uppercase"
            >
              {{ t('access.role') }}
            </Label>
            <Select v-model="addRole">
              <SelectTrigger id="add-role" class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="r in ROLES" :key="r" :value="r">{{ r }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" @click="addOpen = false">{{ t('common.cancel') }}</Button>
          <Button type="submit" form="add-member" :disabled="!pickedUser">Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
