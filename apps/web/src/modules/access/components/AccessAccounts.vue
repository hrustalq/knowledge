<script setup lang="ts">
// Platform accounts — the Accounts tab of /settings/access.
//
// This is the account layer rather than the workspace layer: who exists at all,
// whether they can sign in, and who is a platform admin. It used to be its own
// route (/settings/users, and /admin/users before that), which put two halves
// of one question — "can this person get in" and "what may they do here" — in
// two places, so answering it meant crossing the settings nav mid-thought.
//
// The tab only renders for a platform admin; the API is the real gate
// (@PlatformAdmin on UsersController), and a workspace admin who is not one
// never sees the tab rather than being offered a door that 403s.
//
// Layout is toolbar + table: the roster is the content, so creating an account
// lives behind a dialog and narrowing the list lives in the filter bar rather
// than in stacked cards above the thing you came to read.
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { AtSign, CircleDashed, Library, Plus, ShieldCheck } from 'lucide-vue-next'
import type {
  UserSummary,
  WorkspaceSummary,
} from '@knowledge/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { api, fetchApi } from '@/shared/api/queries'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/shared/ui/badge'
import { UserChip } from '@/entities/person'
import AccountSessions from './AccountSessions.vue'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import {
  FilterBar,
  filterRows,
  type ActiveFilter,
  type FilterAccessors,
  type FilterField,
} from '@/shared/ui/filter-bar'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Skeleton } from '@/shared/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/shared/ui/table'

const { t } = useI18n()

const auth = useAuthStore()
const users = ref<UserSummary[]>([])
const workspaces = ref<WorkspaceSummary[]>([])
const loading = ref(true)

const createOpen = ref(false)
// The account whose sessions dialog is open (#292); null while closed.
const sessionsOf = ref<UserSummary | null>(null)
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
    group: t('filter.groupText'),
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

const queryClient = useQueryClient()

/** `fresh` after a write on this tab. */
async function load(opts: { fresh?: boolean } = {}) {
  loading.value = true
  try {
    const [userRes, wsRes] = await Promise.all([
      fetchApi(queryClient, '/v1/users', undefined, opts),
      // Platform admins see every workspace, so this is the full roster the
      // workspace filter needs.
      fetchApi(queryClient, '/v1/workspaces', undefined, opts),
    ])
    users.value = userRes.users
    workspaces.value = wsRes.workspaces
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    loading.value = false
  }
}
onMounted(() => load())

async function createUser() {
  creating.value = true
  try {
    await api.post('/v1/users', {
      body: {
        email: newEmail.value,
        displayName: newName.value,
        isAdmin: false, // the server's default; the generated type marks it required
        ...(newPassword.value ? { password: newPassword.value } : {}),
      },
    })
    toast.success(t('users.created', { email: newEmail.value }))
    newEmail.value = ''
    newName.value = ''
    newPassword.value = ''
    createOpen.value = false
    await load({ fresh: true })
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

async function patchUser(user: UserSummary, patch: Record<string, unknown>, okMessage: string) {
  try {
    await api.patch('/v1/users/{id}', { path: { id: user.userId }, body: patch as never })
    toast.success(okMessage)
    await load({ fresh: true })
  } catch (e) {
    toast.error((e as Error).message)
  }
}

function setPassword(user: UserSummary) {
  // eslint-disable-next-line no-alert
  const password = window.prompt(t('users.passwordPrompt', { email: user.email }))
  if (!password) return
  void patchUser(user, { password }, t('users.passwordSet'))
}
</script>

<template>
  <div class="space-y-4">
    <!-- No heading of its own: the page above names the surface and the tab
         names this panel, so a third title would only repeat one of them. -->
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <FilterBar v-model="filters" :fields="fields" />
      <div class="flex items-center gap-3">
        <p class="text-muted-foreground text-xs tabular-nums">
          {{ t('documents.ofAccounts', { shown: visibleUsers.length, total: t('count.accounts', { n: users.length }, users.length) }) }}
        </p>
        <Button size="sm" @click="createOpen = true">
          <Plus class="size-3.5" /> {{ t('users.newUser') }}
        </Button>
      </div>
    </div>

    <div v-if="loading" class="space-y-2">
      <Skeleton v-for="i in 4" :key="i" class="h-10 w-full" />
    </div>

    <p v-else-if="visibleUsers.length === 0" class="text-muted-foreground py-10 text-center text-sm">
      {{ t('users.noneMatch') }}
    </p>

    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('users.user') }}</TableHead>
          <TableHead>{{ t('users.status') }}</TableHead>
          <TableHead>{{ t('users.workspaces') }}</TableHead>
          <TableHead>{{ t('users.credentials') }}</TableHead>
          <TableHead class="text-right">{{ t('users.actions') }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="user in visibleUsers" :key="user.userId">
          <TableCell>
            <UserChip :user-id="user.userId" :name="user.displayName" class="font-medium" />
            <div class="text-muted-foreground pl-[1.875rem] text-xs">{{ user.email }}</div>
          </TableCell>
          <TableCell>
            <div class="flex flex-wrap gap-1">
              <Badge v-if="user.isAdmin" variant="default">{{ t('users.platformAdminBadge') }}</Badge>
              <Badge v-if="user.disabled" variant="destructive">{{ t('users.disabledBadge') }}</Badge>
              <Badge v-if="!user.emailVerified" variant="secondary">{{ t('users.unverifiedBadge') }}</Badge>
              <Badge v-if="!user.disabled && !user.isAdmin" variant="outline">{{ t('users.activeBadge') }}</Badge>
            </div>
          </TableCell>
          <TableCell class="text-muted-foreground text-sm">
            <span v-if="user.memberships.length === 0">—</span>
            <span v-else>{{ t('users.memberships', { roles: user.memberships.map((m) => t(`role.${m.role}`)).join(', '), n: user.memberships.length }) }}</span>
          </TableCell>
          <TableCell class="text-muted-foreground text-xs">
            {{
              [user.hasPassword ? t('users.credPassword') : null, user.hasApiKey ? t('users.credApiKey') : null]
                .filter(Boolean)
                .join(' + ') || t('users.credNone')
            }}
          </TableCell>
          <TableCell class="text-right">
            <div class="flex justify-end gap-1.5">
              <Button
                size="sm" variant="outline" :disabled="user.userId === auth.me?.userId"
                @click="patchUser(user, { isAdmin: !user.isAdmin }, user.isAdmin ? t('users.adminRemoved') : t('users.promotedToAdmin'))"
              >
                {{ user.isAdmin ? t('users.revokeAdmin') : t('users.makeAdmin') }}
              </Button>
              <Button size="sm" variant="outline" @click="setPassword(user)">{{ t('users.setPassword') }}</Button>
              <Button size="sm" variant="outline" @click="sessionsOf = user">{{ t('users.sessions') }}</Button>
              <Button
                size="sm" :variant="user.disabled ? 'outline' : 'destructive'" :disabled="user.userId === auth.me?.userId"
                @click="patchUser(user, { disabled: !user.disabled }, user.disabled ? t('users.accountEnabled') : t('users.accountDisabled'))"
              >
                {{ user.disabled ? t('users.enable') : t('users.disable') }}
              </Button>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>

    <Dialog :open="sessionsOf !== null" @update:open="(open) => { if (!open) sessionsOf = null }">
      <DialogContent class="sm:max-w-lg">
        <AccountSessions v-if="sessionsOf" :key="sessionsOf.userId" :user="sessionsOf" />
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="createOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('users.newUser') }}</DialogTitle>
          <DialogDescription>
            {{ t('users.newUserDesc') }}
          </DialogDescription>
        </DialogHeader>
        <form id="create-user" class="space-y-3" @submit.prevent="createUser">
          <div class="space-y-1.5">
            <Label for="new-email">{{ t('users.email') }}</Label>
            <Input id="new-email" v-model="newEmail" type="email" required placeholder="teammate@example.com" />
          </div>
          <div class="space-y-1.5">
            <Label for="new-name">{{ t('users.displayName') }}</Label>
            <Input id="new-name" v-model="newName" required :placeholder="t('users.displayNamePlaceholder')" />
          </div>
          <div class="space-y-1.5">
            <Label for="new-pass">
              {{ t('users.initialPassword') }} <span class="text-muted-foreground font-normal">({{ t('common.optional') }})</span>
            </Label>
            <Input id="new-pass" v-model="newPassword" type="text" minlength="8" :placeholder="t('users.viaResetLink')" />
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" @click="createOpen = false">{{ t('common.cancel') }}</Button>
          <Button type="submit" form="create-user" :disabled="creating">
            {{ creating ? t('users.creating') : t('common.create') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
