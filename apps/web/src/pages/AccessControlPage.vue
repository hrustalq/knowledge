<script setup lang="ts">
// Access control management: workspaces + member roles (RBAC lives in the API;
// mutations here are admin-only and 403 for everyone else).
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import type {
  ListWorkspaceMembersResponse,
  ListWorkspacesResponse,
  WorkspaceMemberEntry,
  WorkspaceRole,
  WorkspaceSummary,
} from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

const ROLES: WorkspaceRole[] = ['viewer', 'editor', 'admin']

const auth = useAuthStore()
const workspaces = ref<WorkspaceSummary[]>([])
const selected = ref<string>(getWorkspaceId())
const members = ref<WorkspaceMemberEntry[]>([])
const loadingMembers = ref(false)

const newWorkspaceName = ref('')
const addEmail = ref('')
const addRole = ref<WorkspaceRole>('viewer')

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

async function createWorkspace() {
  try {
    await apiFetch('/v1/workspaces', { method: 'POST', body: JSON.stringify({ name: newWorkspaceName.value }) })
    toast.success(`Workspace "${newWorkspaceName.value}" created`)
    newWorkspaceName.value = ''
    await loadWorkspaces()
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function addMember() {
  try {
    const res = await apiFetch<ListWorkspaceMembersResponse>(`/v1/workspaces/${selected.value}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: addEmail.value, role: addRole.value }),
    })
    members.value = res.members
    toast.success(`${addEmail.value} added as ${addRole.value}`)
    addEmail.value = ''
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
    toast.success(`Updated ${member.email}`)
  } catch (e) {
    toast.error((e as Error).message)
    await loadMembers() // roll back the optimistic <select> state
  }
}

async function removeMember(member: WorkspaceMemberEntry) {
  try {
    const res = await apiFetch<ListWorkspaceMembersResponse>(
      `/v1/workspaces/${selected.value}/members/${member.userId}`,
      { method: 'DELETE' },
    )
    members.value = res.members
    toast.success(`Removed ${member.email}`)
  } catch (e) {
    toast.error((e as Error).message)
  }
}

function useWorkspace() {
  auth.setWorkspace(selected.value)
  toast.success(`Active workspace: ${selectedWorkspace.value?.name ?? selected.value}`)
}
</script>

<template>
  <div class="space-y-6">
    <h1 class="font-display text-2xl font-bold tracking-tight">Access control</h1>

    <div class="flex flex-wrap items-end gap-3">
      <div class="space-y-1">
        <label class="text-sm font-medium" for="ws">Workspace</label>
        <select
          id="ws" v-model="selected"
          class="h-9 w-72 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
        >
          <option v-for="w in workspaces" :key="w.workspaceId" :value="w.workspaceId">
            {{ w.name }} ({{ w.memberCount }} members{{ w.myRole ? `, you: ${w.myRole}` : '' }})
          </option>
        </select>
      </div>
      <Button variant="outline" :disabled="selected === getWorkspaceId()" @click="useWorkspace">
        Set as active workspace
      </Button>
      <form class="ml-auto flex items-end gap-2" @submit.prevent="createWorkspace">
        <div class="space-y-1">
          <label class="text-sm font-medium" for="new-ws">New workspace</label>
          <Input id="new-ws" v-model="newWorkspaceName" required placeholder="Platform Team" class="w-48" />
        </div>
        <Button type="submit" variant="outline">Create</Button>
      </form>
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">
          Members
          <Badge v-if="!canManage" variant="outline" class="ml-2">read-only — workspace admin required</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent class="space-y-4">
        <form v-if="canManage" class="flex flex-wrap items-end gap-2" @submit.prevent="addMember">
          <div class="space-y-1">
            <label class="text-sm font-medium" for="add-email">Add member by email</label>
            <Input id="add-email" v-model="addEmail" type="email" required placeholder="teammate@example.com" class="w-64" />
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="add-role">Role</label>
            <select id="add-role" v-model="addRole" class="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs">
              <option v-for="r in ROLES" :key="r" :value="r">{{ r }}</option>
            </select>
          </div>
          <Button type="submit">Add</Button>
        </form>

        <div v-if="loadingMembers" class="space-y-2">
          <Skeleton v-for="i in 3" :key="i" class="h-10 w-full" />
        </div>
        <p v-else-if="members.length === 0" class="text-sm text-muted-foreground">
          No members visible — you may not have access to this workspace's roster.
        </p>
        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Trusted operator</TableHead>
              <TableHead class="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="member in members" :key="member.userId">
              <TableCell>
                <div class="font-medium">
                  {{ member.displayName }}
                  <Badge v-if="member.disabled" variant="destructive" class="ml-1">disabled</Badge>
                </div>
                <div class="text-xs text-muted-foreground">{{ member.email }}</div>
              </TableCell>
              <TableCell>
                <select
                  v-if="canManage"
                  class="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                  :value="member.role"
                  @change="patchMember(member, { role: ($event.target as HTMLSelectElement).value })"
                >
                  <option v-for="r in ROLES" :key="r" :value="r">{{ r }}</option>
                </select>
                <Badge v-else variant="outline">{{ member.role }}</Badge>
              </TableCell>
              <TableCell>
                <input
                  v-if="canManage"
                  type="checkbox" class="size-4 accent-primary"
                  :checked="member.trustedOperator"
                  @change="patchMember(member, { trustedOperator: ($event.target as HTMLInputElement).checked })"
                />
                <span v-else class="text-sm text-muted-foreground">{{ member.trustedOperator ? 'yes' : 'no' }}</span>
              </TableCell>
              <TableCell class="text-right">
                <Button v-if="canManage" size="sm" variant="destructive" @click="removeMember(member)">Remove</Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  </div>
</template>
