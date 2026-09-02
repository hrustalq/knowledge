<script setup lang="ts">
// Users management (platform admin; the /admin/users route is RBAC-guarded).
import { onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import type { ListUsersResponse, UserSummary } from '@knowledge/contracts'
import { apiFetch } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

const auth = useAuthStore()
const users = ref<UserSummary[]>([])
const loading = ref(true)

const newEmail = ref('')
const newName = ref('')
const newPassword = ref('')
const creating = ref(false)

async function load() {
  loading.value = true
  try {
    users.value = (await apiFetch<ListUsersResponse>('/v1/users')).users
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
  <div class="space-y-6">
    <h1 class="text-2xl font-semibold">Users</h1>

    <Card>
      <CardHeader><CardTitle class="text-base">Create user</CardTitle></CardHeader>
      <CardContent>
        <form class="flex flex-wrap items-end gap-3" @submit.prevent="createUser">
          <div class="space-y-1">
            <label class="text-sm font-medium" for="new-email">Email</label>
            <Input id="new-email" v-model="newEmail" type="email" required placeholder="teammate@example.com" class="w-64" />
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="new-name">Display name</label>
            <Input id="new-name" v-model="newName" required placeholder="Teammate" class="w-48" />
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="new-pass">Initial password <span class="text-muted-foreground">(optional)</span></label>
            <Input id="new-pass" v-model="newPassword" type="text" minlength="8" placeholder="via reset link if empty" class="w-52" />
          </div>
          <Button type="submit" :disabled="creating">Create</Button>
        </form>
      </CardContent>
    </Card>

    <div v-if="loading" class="space-y-2">
      <Skeleton v-for="i in 4" :key="i" class="h-10 w-full" />
    </div>

    <div v-else class="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Workspaces</TableHead>
            <TableHead>Credentials</TableHead>
            <TableHead class="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="user in users" :key="user.userId">
            <TableCell>
              <div class="font-medium">{{ user.displayName }}</div>
              <div class="text-xs text-muted-foreground">{{ user.email }}</div>
            </TableCell>
            <TableCell>
              <div class="flex flex-wrap gap-1">
                <Badge v-if="user.isAdmin" variant="default">platform admin</Badge>
                <Badge v-if="user.disabled" variant="destructive">disabled</Badge>
                <Badge v-if="!user.disabled && !user.isAdmin" variant="outline">active</Badge>
              </div>
            </TableCell>
            <TableCell class="text-sm text-muted-foreground">
              <span v-if="user.memberships.length === 0">—</span>
              <span v-else>{{ user.memberships.map((m) => m.role).join(', ') }} ({{ user.memberships.length }})</span>
            </TableCell>
            <TableCell class="text-xs text-muted-foreground">
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
    </div>
  </div>
</template>
