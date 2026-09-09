<script setup lang="ts">
// Users management (platform admin; the /admin/users route is RBAC-guarded).
//
// Layout is toolbar + table: the roster is the page, so creating an account
// lives behind a dialog and narrowing the list lives in the filter bar rather
// than in stacked cards above the thing you came to read.
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { AtSign, CircleDashed, Library, Plus, ShieldCheck } from 'lucide-vue-next'
import type {
  ListUsersResponse,
  ListWorkspacesResponse,
  UserSummary,
  WorkspaceSummary,
} from '@knowledge/contracts'
import { apiFetch } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
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
import {
  FilterBar,
  filterRows,
  type ActiveFilter,
  type FilterAccessors,
  type FilterField,
} from '@/components/ui/filter-bar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

const { t } = useI18n()

const auth = useAuthStore()
const users = ref<UserSummary[]>([])
const workspaces = ref<WorkspaceSummary[]>([])
const loading = ref(true)

const createOpen = ref(false)
const newEmail = ref('')
const newName = ref('')
const newPassword = ref('')
const creating = ref(false)

// --- filters ---------------------------------------------------------------
// The whole roster is already in memory, so every field matches client-side.
const filters = ref<ActiveFilter[]>([])

const fields = computed<FilterField[]>(() => [
  {
    key: 'status',
    label: t('filter.status'),
    icon: CircleDashed,
    options: [
      { value: 'active', label: t('filter.active') },
      { value: 'disabled', label: t('filter.disabled') },
      { value: 'admin', label: t('filter.platformAdmin') },
    ],
  },
  {
    key: 'role',
    label: t('filter.role'),
    icon: ShieldCheck,
    options: [
      { value: 'viewer', label: t('role.viewer') },
      { value: 'editor', label: t('role.editor') },
      { value: 'admin', label: t('role.admin') },
    ],
  },
  {
    key: 'workspace',
    label: t('filter.workspace'),
    icon: Library,
    options: workspaces.value.map((w) => ({
      value: w.workspaceId,
      label: w.name,
      meta: w.memberCount,
    })),
  },
  {
    key: 'text',
    label: t('filter.nameOrEmail'),
    icon: AtSign,
    group: 'Text',
    type: 'text',
    placeholder: 'alice@…',
  },
])

const accessors: FilterAccessors<UserSummary> = {
  // A user is one of active/disabled, and separately may be a platform admin,
  // so status is multi-valued rather than a single enum.
  status: (u) => [u.disabled ? 'disabled' : 'active', ...(u.isAdmin ? ['admin'] : [])],
  role: (u) => u.memberships.map((m) => m.role),
  workspace: (u) => u.memberships.map((m) => m.workspaceId),
  text: (u) => [u.displayName, u.email],
}

const visibleUsers = computed(() => filterRows(users.value, filters.value, accessors))

async function load() {
  loading.value = true
  try {
    const [userRes, wsRes] = await Promise.all([
      apiFetch<ListUsersResponse>('/v1/users'),
      // Platform admins see every workspace, so this is the full roster the
      // workspace filter needs.
      apiFetch<ListWorkspacesResponse>('/v1/workspaces'),
    ])
    users.value = userRes.users
    workspaces.value = wsRes.workspaces
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function createUser() {
  creating.value = true
  try {
    await apiFetch<UserSummary>('/v1/users', {
      method: 'POST',
      body: JSON.stringify({
        email: newEmail.value,
        displayName: newName.value,
        ...(newPassword.value ? { password: newPassword.value } : {}),
      }),
    })
    toast.success(`Created ${newEmail.value}`)
    newEmail.value = ''
    newName.value = ''
    newPassword.value = ''
    createOpen.value = false
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

async function patchUser(user: UserSummary, patch: Record<string, unknown>, okMessage: string) {
  try {
    await apiFetch<UserSummary>(`/v1/users/${user.userId}`, { method: 'PATCH', body: JSON.stringify(patch) })
    toast.success(okMessage)
    await load()
  } catch (e) {
    toast.error((e as Error).message)
  }
}

function setPassword(user: UserSummary) {
  // eslint-disable-next-line no-alert
  const password = window.prompt(`New password for ${user.email} (min 8 chars):`)
  if (!password) return
  void patchUser(user, { password }, 'Password set — existing sessions revoked')
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('users.title') }}</h1>
      <Button size="sm" @click="createOpen = true">
        <Plus class="size-3.5" /> New user
      </Button>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <FilterBar v-model="filters" :fields="fields" />
      <p class="text-muted-foreground text-xs tabular-nums">
        {{ t('documents.ofAccounts', { shown: visibleUsers.length, total: t('count.accounts', { n: users.length }, users.length) }) }}
      </p>
    </div>

    <div v-if="loading" class="space-y-2">
      <Skeleton v-for="i in 4" :key="i" class="h-10 w-full" />
    </div>

    <p v-else-if="visibleUsers.length === 0" class="text-muted-foreground py-10 text-center text-sm">
      No accounts match these filters.
    </p>

    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('users.user') }}</TableHead>
          <TableHead>{{ t('users.status') }}</TableHead>
          <TableHead>Workspaces</TableHead>
          <TableHead>Credentials</TableHead>
          <TableHead class="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="user in visibleUsers" :key="user.userId">
          <TableCell>
            <div class="font-medium">{{ user.displayName }}</div>
            <div class="text-muted-foreground text-xs">{{ user.email }}</div>
          </TableCell>
          <TableCell>
            <div class="flex flex-wrap gap-1">
              <Badge v-if="user.isAdmin" variant="default">platform admin</Badge>
              <Badge v-if="user.disabled" variant="destructive">disabled</Badge>
              <Badge v-if="!user.disabled && !user.isAdmin" variant="outline">active</Badge>
            </div>
          </TableCell>
          <TableCell class="text-muted-foreground text-sm">
            <span v-if="user.memberships.length === 0">—</span>
            <span v-else>{{ user.memberships.map((m) => m.role).join(', ') }} ({{ user.memberships.length }})</span>
          </TableCell>
          <TableCell class="text-muted-foreground text-xs">
            {{ [user.hasPassword ? 'password' : null, user.hasApiKey ? 'api key' : null].filter(Boolean).join(' + ') || 'none' }}
          </TableCell>
          <TableCell class="text-right">
            <div class="flex justify-end gap-1.5">
              <Button
                size="sm" variant="outline" :disabled="user.userId === auth.me?.userId"
                @click="patchUser(user, { isAdmin: !user.isAdmin }, user.isAdmin ? 'Admin removed' : 'Promoted to platform admin')"
              >
                {{ user.isAdmin ? 'Revoke admin' : 'Make admin' }}
              </Button>
              <Button size="sm" variant="outline" @click="setPassword(user)">Set password</Button>
              <Button
                size="sm" :variant="user.disabled ? 'outline' : 'destructive'" :disabled="user.userId === auth.me?.userId"
                @click="patchUser(user, { disabled: !user.disabled }, user.disabled ? 'Account enabled' : 'Account disabled')"
              >
                {{ user.disabled ? 'Enable' : 'Disable' }}
              </Button>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>

    <Dialog v-model:open="createOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
          <DialogDescription>
            Leave the password empty to have the account claimed through a reset link.
          </DialogDescription>
        </DialogHeader>
        <form id="create-user" class="space-y-3" @submit.prevent="createUser">
          <div class="space-y-1.5">
            <Label for="new-email">Email</Label>
            <Input id="new-email" v-model="newEmail" type="email" required placeholder="teammate@example.com" />
          </div>
          <div class="space-y-1.5">
            <Label for="new-name">Display name</Label>
            <Input id="new-name" v-model="newName" required placeholder="Teammate" />
          </div>
          <div class="space-y-1.5">
            <Label for="new-pass">
              Initial password <span class="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input id="new-pass" v-model="newPassword" type="text" minlength="8" placeholder="via reset link if empty" />
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" @click="createOpen = false">Cancel</Button>
          <Button type="submit" form="create-user" :disabled="creating">
            {{ creating ? 'Creating…' : 'Create' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
