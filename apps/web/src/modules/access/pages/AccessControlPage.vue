<script setup lang="ts">
/**
 * Access — who is in this workspace, what a role grants, which groups they
 * form and who is asking for what. One surface, four tabs. The Roles tab
 * answers the question under the roster: what *is* an editor.
 *
 * Who has an account at all is the platform's question, not the workspace's:
 * it lives in the admin console (/admin/users, #1239), which the header links
 * for a platform admin. That is a full page load into another app, so it is a
 * plain link, never a router push.
 *
 * Tabs are the shared PageTabs strip over `usePageTabs`, as on the
 * merge-request and AI pages: `?tab=` is an opening instruction, replaced
 * rather than pushed, so Back does not walk every tab you tried on the way here.
 */
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { AtSign, ExternalLink, Library, ShieldCheck, UserPlus, Wrench } from 'lucide-vue-next'
import { WORKSPACE_ROLES } from '@knowledge/contracts'
import type {
  ListWorkspaceMembersResponse,
  MemberCapability,
  WorkspaceCandidate,
  WorkspaceMemberEntry,
  WorkspaceRole,
  WorkspaceSummary,
} from '@knowledge/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { api, fetchApi } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { usePermission } from '@/stores/permissions'
import { Autocomplete, type AutocompleteOption } from '@knowledge/ui/autocomplete'
import { Badge } from '@knowledge/ui/badge'
import { UserChip } from '@/entities/person'
import { Button } from '@knowledge/ui/button'
import { confirm } from '@knowledge/ui/confirm'
import { Checkbox } from '@knowledge/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@knowledge/ui/dialog'
import {
  FilterBar,
  filterRows,
  type ActiveFilter,
  type FilterAccessors,
  type FilterField,
} from '@knowledge/ui/filter-bar'
import { Label } from '@knowledge/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@knowledge/ui/select'
import { Skeleton } from '@knowledge/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@knowledge/ui/tooltip'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@knowledge/ui/table'
import { PageTabs, panelId, tabId, usePageTabs, type PageTab } from '@knowledge/ui/layout'
import AccessRoles from '@/modules/access/components/AccessRoles.vue'
import AccessGroups from '@/modules/access/components/AccessGroups.vue'
import AccessRequests from '@/modules/access/components/AccessRequests.vue'

const { t } = useI18n()

const ROLES: readonly WorkspaceRole[] = WORKSPACE_ROLES

const queryClient = useQueryClient()
const workspaces = ref<WorkspaceSummary[]>([])
const selected = ref<string>(getWorkspaceId())
const members = ref<WorkspaceMemberEntry[]>([])
const loadingMembers = ref(false)

const addRole = ref<WorkspaceRole>('viewer')
const addCapabilities = ref<MemberCapability[]>([])
const addOpen = ref(false)

/**
 * Member capabilities (#468, #483), one column each. Admins hold every one
 * implicitly, so their cell says so rather than offering a box that would
 * change nothing. `key` names the column's messages under `access.`.
 */
const CAPABILITIES = [
  { id: 'api-test-suites.generate', key: 'testSuites' },
  { id: 'api-test-suites.run', key: 'testRuns' },
] as const satisfies ReadonlyArray<{ id: MemberCapability; key: string }>
const holds = (m: WorkspaceMemberEntry, c: MemberCapability) => m.capabilities.includes(c)
function setCapability(member: WorkspaceMemberEntry, c: MemberCapability, on: boolean) {
  const rest = member.capabilities.filter((x) => x !== c)
  void patchMember(member, { capabilities: on ? [...rest, c] : rest })
}
function toggleAddCapability(c: MemberCapability, on: boolean) {
  addCapabilities.value = on ? [...addCapabilities.value.filter((x) => x !== c), c] : addCapabilities.value.filter((x) => x !== c)
}

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
  const q = query.trim()
  // Fresh: an add on this page makes a candidate a member, and nothing announces it.
  const res = await fetchApi(
    queryClient,
    '/v1/workspaces/{id}/candidates',
    { path: { id: selected.value }, query: { limit: 20, ...(q ? { q } : {}) } },
    { fresh: true },
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

/** Can the caller manage the selected workspace? Asked of that workspace, not the active one. */
const canManage = usePermission('workspace:admin', selected)

// Fresh, here and for members: this page writes both, and no live event re-asks either.
async function loadWorkspaces() {
  try {
    workspaces.value = (await fetchApi(queryClient, '/v1/workspaces', undefined, { fresh: true }))
      .workspaces
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
    members.value = (
      await fetchApi(
        queryClient,
        '/v1/workspaces/{id}/members',
        { path: { id: selected.value } },
        { fresh: true },
      )
    ).members
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
    const res = (await api.post('/v1/workspaces/{id}/members', {
      path: { id: selected.value },
      // trustedOperator: the server's default; the generated type marks it required.
      body: { email: user.email, role: addRole.value, trustedOperator: false, capabilities: addCapabilities.value },
    })) as ListWorkspaceMembersResponse
    members.value = res.members
    toast.success(t('access.memberAdded', { email: user.email, role: t(`role.${addRole.value}`) }))
    addOpen.value = false
    addCapabilities.value = []
    pickedUser.value = null
    candidateCache.delete(user.userId) // now a member — no longer a candidate
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function patchMember(member: WorkspaceMemberEntry, patch: Record<string, unknown>) {
  try {
    const res = await api.patch('/v1/workspaces/{id}/members/{userId}', {
      path: { id: selected.value, userId: member.userId },
      body: patch as never,
    })
    members.value = res.members
    toast.success(t('access.memberUpdated', { email: member.email }))
  } catch (e) {
    toast.error((e as Error).message)
    await loadMembers() // roll back the optimistic role/flag state
  }
}

/**
 * A bulk role change from the Roles tab.
 *
 * Sequential rather than `Promise.all`: each response is the whole roster, so
 * three concurrent PATCHes would race to be the copy that lands, and the one
 * that finished first could overwrite the other two's effects. One at a time,
 * and the last answer is the true one.
 */
async function assignRole(userIds: string[], role: WorkspaceRole) {
  for (const userId of userIds) {
    const member = members.value.find((m) => m.userId === userId)
    if (member && member.role !== role) await patchMember(member, { role })
  }
}

/**
 * A row JIT, group sync or SCIM wrote is the identity provider's (#75): the API
 * refuses a hand edit of it (409), because the next sign-in would undo it.
 * Taking it over is an explicit act, and from then on sync leaves it alone.
 */
const isManaged = (m: WorkspaceMemberEntry) => m.source !== 'manual'

async function takeOver(member: WorkspaceMemberEntry) {
  const ok = await confirm({
    title: t('access.source.takeOverTitle', { name: member.displayName }),
    description: t('access.source.takeOverBody'),
    action: t('access.source.takeOver'),
  })
  if (!ok) return
  await patchMember(member, { convertToManual: true })
}

async function removeMember(member: WorkspaceMemberEntry) {
  try {
    const res = await api.delete('/v1/workspaces/{id}/members/{userId}', {
      path: { id: selected.value, userId: member.userId },
    })
    members.value = res.members
    toast.success(t('access.memberRemoved', { email: member.email }))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/* ------------------------------------------------------------------- tabs */

/** A platform admin (or the dev principal) searches every account in the picker and gets the console link. */
const isPlatformAdmin = usePermission('platform:admin')

const tabs = computed<PageTab[]>(() => [
  { key: 'members', label: t('access.tabMembers'), count: members.value.length },
  { key: 'roles', label: t('access.tabRoles') },
  { key: 'groups', label: t('access.tabGroups') },
  // Every member: managers decide here, and anyone reads their own (#76).
  { key: 'requests', label: t('access.tabRequests') },
])

const tab = usePageTabs(tabs, 'members')
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('access.title') }}</h1>
      <div class="flex items-center gap-2">
        <Button v-if="isPlatformAdmin" as="a" href="/admin/users" size="sm" variant="ghost">
          {{ t('access.accountsInConsole') }} <ExternalLink class="size-3.5" aria-hidden="true" />
        </Button>
        <Button v-if="canManage && tab === 'members'" size="sm" @click="addOpen = true">
          <UserPlus class="size-3.5" /> {{ t('access.addMember') }}
        </Button>
        <Badge v-else-if="!canManage" variant="outline">{{ t('access.readOnly') }}</Badge>
      </div>
    </div>

    <PageTabs v-model="tab" :tabs="tabs" :label="t('access.title')" />

    <div :id="panelId(tab)" role="tabpanel" :aria-labelledby="tabId(tab)" class="space-y-4">
      <!-- Members ------------------------------------------------------------ -->
      <template v-if="tab === 'members'">
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

        <Table v-else sticky-first>
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('access.member') }}</TableHead>
            <TableHead>{{ t('access.role') }}</TableHead>
            <TableHead>{{ t('access.trustedOperator') }}</TableHead>
            <TableHead v-for="c in CAPABILITIES" :key="c.id">{{ t(`access.${c.key}`) }}</TableHead>
            <TableHead class="text-right">{{ t('access.actions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="member in visibleMembers" :key="member.userId">
            <TableCell>
              <div class="flex items-center gap-1.5">
                <UserChip :user-id="member.userId" :name="member.displayName" class="font-medium" />
                <Badge v-if="member.disabled" variant="destructive">{{ t('access.disabled') }}</Badge>
                <TooltipProvider v-if="isManaged(member)" :delay-duration="300">
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <Badge variant="secondary" tabindex="0">{{ t(`access.source.${member.source}`) }}</Badge>
                    </TooltipTrigger>
                    <TooltipContent class="max-w-xs">{{ t('access.source.managedHint') }}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div class="text-muted-foreground pl-[1.875rem] text-xs">{{ member.email }}</div>
            </TableCell>
            <TableCell>
              <Select
                v-if="canManage && !isManaged(member)"
                :model-value="member.role"
                @update:model-value="patchMember(member, { role: $event as string })"
              >
                <SelectTrigger size="sm" class="text-sm" :aria-label="t('access.roleFor', { name: member.displayName })">
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
                v-if="canManage && !isManaged(member)"
                :model-value="member.trustedOperator"
                :aria-label="t('access.trustedOperatorFor', { name: member.displayName })"
                @update:model-value="patchMember(member, { trustedOperator: $event === true })"
              />
              <span v-else class="text-muted-foreground text-sm">{{ member.trustedOperator ? t('common.yes') : t('common.no') }}</span>
            </TableCell>
            <TableCell v-for="c in CAPABILITIES" :key="c.id">
              <span v-if="member.role === 'admin'" class="text-muted-foreground text-sm">{{ t('access.implicitForAdmins') }}</span>
              <!-- Any row, managed or not: no identity provider writes capabilities, so editing one takes nothing over. -->
              <Checkbox
                v-else-if="canManage"
                :model-value="holds(member, c.id)"
                :aria-label="t(`access.${c.key}For`, { name: member.displayName })"
                @update:model-value="setCapability(member, c.id, $event === true)"
              />
              <span v-else class="text-muted-foreground text-sm">{{ holds(member, c.id) ? t('common.yes') : t('common.no') }}</span>
            </TableCell>
            <TableCell class="text-right">
              <div v-if="canManage" class="flex justify-end gap-1.5">
                <Button v-if="isManaged(member)" size="sm" variant="outline" @click="takeOver(member)">
                  {{ t('access.source.takeOver') }}
                </Button>
                <Button size="sm" variant="destructive" @click="removeMember(member)">{{ t('access.remove') }}</Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
        </Table>

      </template>

      <!-- Roles: the same roster, read as a ladder of what each rung grants. -->
      <div v-else-if="tab === 'roles'">
        <div v-if="loadingMembers" class="space-y-2">
          <Skeleton v-for="i in 3" :key="i" class="h-24 w-full" />
        </div>
        <AccessRoles
          v-else
          :members="members"
          :roles="ROLES"
          :can-manage="canManage"
          @assign="assignRole"
        />
      </div>

      <!-- Groups: what page and project restrictions grant to. -->
      <AccessGroups
        v-else-if="tab === 'groups'"
        :workspace-id="selected"
        :members="members"
        :can-manage="canManage"
      />

      <!-- Requests: access asked for, decided by whoever manages the page. -->
      <AccessRequests v-else-if="tab === 'requests'" :workspace-id="selected" />
    </div>

    <Dialog v-model:open="addOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('access.addMember') }}</DialogTitle>
          <DialogDescription>
            {{ isPlatformAdmin ? t('access.pickerSearchesNonMembers') : t('access.pickerExactEmail') }}
          </DialogDescription>
        </DialogHeader>
        <form id="add-member" class="space-y-3" @submit.prevent="addMember">
          <Autocomplete
            v-model="pickedValue"
            :label="t('access.user')"
            :placeholder="isPlatformAdmin ? t('access.searchUsers') : t('access.fullEmail')"
            :multiple="false"
            :load="loadCandidates"
          />
          <div class="space-y-1.5">
            <Label
              for="add-role"
              class="text-muted-foreground block text-caption font-semibold tracking-wider uppercase"
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
          <div v-for="c in CAPABILITIES" :key="c.id" class="flex items-start gap-2.5">
            <Checkbox
              :id="`add-${c.key}`"
              :model-value="addCapabilities.includes(c.id)"
              class="mt-0.5"
              @update:model-value="toggleAddCapability(c.id, $event === true)"
            />
            <Label :for="`add-${c.key}`" class="grid gap-0.5 font-normal">
              <span class="text-sm">{{ t(`access.${c.key}Grant`) }}</span>
              <span class="text-muted-foreground text-xs">{{ t(`access.${c.key}Hint`) }}</span>
            </Label>
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" @click="addOpen = false">{{ t('common.cancel') }}</Button>
          <Button type="submit" form="add-member" :disabled="!pickedUser">{{ t('common.add') }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
