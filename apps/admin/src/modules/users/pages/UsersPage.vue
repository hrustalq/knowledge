<script setup lang="ts">
/**
 * Every account on the platform (#1239): who exists, whether they can sign in,
 * when they last did, and which workspaces they belong to. This was the
 * Accounts tab of the member app's /settings/access; it is the platform's
 * question, not a workspace's, so it lives here. Acting on an account happens
 * on its own page (UserPage): the roster is for finding one.
 *
 * The whole roster is one response, so every filter matches client-side, and
 * the workspace filter's options come from the memberships it already holds.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { AtSign, CircleDashed, Library, Plus, SearchX, ShieldCheck } from 'lucide-vue-next'
import { WORKSPACE_ROLES, type UserSummary } from '@knowledge/contracts'
import { PageLayout, PageState } from '@knowledge/ui/layout'
import { Badge } from '@knowledge/ui/badge'
import { Button } from '@knowledge/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@knowledge/ui/dialog'
import { FilterBar, filterRows, type ActiveFilter, type FilterAccessors, type FilterField } from '@knowledge/ui/filter-bar'
import { formatDateTime, formatRelative } from '@knowledge/contracts/format'
import { Input } from '@knowledge/ui/input'
import { Label } from '@knowledge/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@knowledge/ui/table'
import { api, apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { accountBadges, credentialKeys } from '../model/account'

const { t, locale } = useI18n()
const router = useRouter()
const queryClient = useQueryClient()
const list = apiQueryOptions('/v1/users')
const users = useQuery(list)
const all = computed<UserSummary[]>(() => users.data.value?.users ?? [])

// --- filters ---------------------------------------------------------------
const filters = ref<ActiveFilter[]>([])

const workspaces = computed(() => {
  const names = new Map<string, { name: string; count: number }>()
  for (const u of all.value) {
    for (const m of u.memberships) {
      const hit = names.get(m.workspaceId) ?? { name: m.workspaceName, count: 0 }
      hit.count++
      names.set(m.workspaceId, hit)
    }
  }
  return [...names].map(([value, w]) => ({ value, label: w.name, meta: w.count })).sort((a, b) => a.label.localeCompare(b.label))
})

const fields = computed<FilterField[]>(() => [
  {
    key: 'status',
    label: t('admin.users.filter.status'),
    icon: CircleDashed,
    options: [
      { value: 'active', label: t('admin.users.filter.active') },
      { value: 'disabled', label: t('admin.users.filter.disabled') },
      { value: 'admin', label: t('admin.users.filter.platformAdmin') },
      { value: 'never', label: t('admin.users.filter.neverSignedIn') },
    ],
  },
  {
    key: 'role',
    label: t('admin.users.filter.role'),
    icon: ShieldCheck,
    options: WORKSPACE_ROLES.map((r) => ({ value: r, label: t(`admin.users.role.${r}`) })),
  },
  { key: 'workspace', label: t('admin.users.filter.workspace'), icon: Library, options: workspaces.value },
  {
    key: 'text',
    label: t('admin.users.filter.nameOrEmail'),
    icon: AtSign,
    group: t('admin.users.filter.groupText'),
    type: 'text',
    placeholder: t('admin.users.filter.textPlaceholder'),
  },
])

const accessors: FilterAccessors<UserSummary> = {
  // Active/disabled is one axis, platform admin and "never signed in" are others: status is multi-valued.
  status: (u) => [u.disabled ? 'disabled' : 'active', ...(u.isAdmin ? ['admin'] : []), ...(u.lastSignInAt ? [] : ['never'])],
  role: (u) => u.memberships.map((m) => m.role),
  workspace: (u) => u.memberships.map((m) => m.workspaceId),
  text: (u) => [u.displayName, u.email],
}

const visible = computed(() => filterRows(all.value, filters.value, accessors))

const memberships = (u: UserSummary) =>
  u.memberships.map((m) => t('admin.users.membership', { workspace: m.workspaceName, role: t(`admin.users.role.${m.role}`) })).join(', ')

// --- create ----------------------------------------------------------------
const createOpen = ref(false)
const email = ref('')
const name = ref('')
const password = ref('')
const creating = ref(false)

async function create() {
  creating.value = true
  try {
    const user = await api.post('/v1/users', {
      body: { email: email.value, displayName: name.value, ...(password.value ? { password: password.value } : {}) },
    })
    toast.success(password.value ? t('admin.users.created', { email: user.email }) : t('admin.users.invited', { email: user.email }))
    createOpen.value = false
    email.value = name.value = password.value = ''
    void queryClient.invalidateQueries({ queryKey: list.queryKey })
    await router.push(`/users/${user.userId}`)
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <PageLayout :title="t('admin.nav.users')" :subtitle="t('admin.sections.users')">
    <template #actions>
      <Button size="sm" @click="createOpen = true">
        <Plus aria-hidden="true" /> {{ t('admin.users.newUser') }}
      </Button>
    </template>

    <PageState v-if="users.isPending.value" state="loading" :rows="8" row-class="h-11" />
    <PageState v-else-if="users.isError.value" state="error" :error="users.error.value" />
    <template v-else>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <FilterBar v-model="filters" :fields="fields" />
        <p class="text-muted-foreground text-caption tabular-nums" aria-live="polite">
          {{ t('admin.users.shown', { shown: visible.length, total: all.length }) }}
        </p>
      </div>

      <PageState
        v-if="!visible.length"
        state="empty"
        :icon="SearchX"
        :title="t('admin.users.noneMatch')"
        :description="t('admin.users.noneMatchHint')"
      />
      <div v-else class="rounded-lg border">
        <Table class="text-ui" sticky-first>
          <TableHeader>
            <TableRow>
              <TableHead class="text-caption text-muted-foreground font-medium">{{ t('admin.users.cols.user') }}</TableHead>
              <TableHead class="text-caption text-muted-foreground font-medium">{{ t('admin.users.cols.status') }}</TableHead>
              <TableHead class="text-caption text-muted-foreground font-medium">{{ t('admin.users.cols.workspaces') }}</TableHead>
              <TableHead class="text-caption text-muted-foreground font-medium">{{ t('admin.users.cols.lastSignIn') }}</TableHead>
              <TableHead class="text-caption text-muted-foreground font-medium">{{ t('admin.users.cols.credentials') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="user in visible" :key="user.userId">
              <TableCell class="max-w-64">
                <RouterLink
                  :to="`/users/${user.userId}`"
                  class="decoration-primary/40 block truncate font-medium underline-offset-4 hover:underline focus-visible:underline"
                >
                  {{ user.displayName }}
                </RouterLink>
                <span class="text-muted-foreground text-caption block truncate">{{ user.email }}</span>
              </TableCell>
              <TableCell>
                <div class="flex gap-1 whitespace-nowrap">
                  <Badge v-for="b in accountBadges(user)" :key="b.key" :variant="b.variant">{{ t(`admin.users.badge.${b.key}`) }}</Badge>
                </div>
              </TableCell>
              <TableCell class="text-muted-foreground min-w-48">
                <span v-if="!user.memberships.length">{{ t('admin.users.noWorkspaces') }}</span>
                <span v-else class="line-clamp-2" :title="memberships(user)">{{ memberships(user) }}</span>
              </TableCell>
              <TableCell class="text-muted-foreground whitespace-nowrap tabular-nums">
                <time v-if="user.lastSignInAt" :datetime="user.lastSignInAt" :title="formatDateTime(user.lastSignInAt, locale)">
                  {{ formatRelative(user.lastSignInAt, locale) }}
                </time>
                <span v-else>{{ t('admin.users.never') }}</span>
              </TableCell>
              <TableCell class="text-muted-foreground whitespace-nowrap">
                {{ credentialKeys(user).map((k) => t(`admin.users.credential.${k}`)).join(' + ') || t('admin.users.credential.none') }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </template>

    <Dialog v-model:open="createOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('admin.users.newUser') }}</DialogTitle>
          <DialogDescription>{{ t('admin.users.newUserHint') }}</DialogDescription>
        </DialogHeader>
        <form id="create-user" class="space-y-3" @submit.prevent="create">
          <div class="space-y-1.5">
            <Label for="new-email">{{ t('admin.users.email') }}</Label>
            <Input id="new-email" v-model="email" type="email" required autocomplete="off" :placeholder="t('admin.users.emailPlaceholder')" />
          </div>
          <div class="space-y-1.5">
            <Label for="new-name">{{ t('admin.users.displayName') }}</Label>
            <Input id="new-name" v-model="name" required maxlength="120" autocomplete="off" />
          </div>
          <div class="space-y-1.5">
            <Label for="new-pass">{{ t('admin.users.initialPassword') }}</Label>
            <Input id="new-pass" v-model="password" type="password" minlength="8" maxlength="200" autocomplete="new-password" aria-describedby="new-pass-hint" />
            <p id="new-pass-hint" class="text-muted-foreground text-caption">{{ t('admin.users.initialPasswordHint') }}</p>
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" @click="createOpen = false">{{ t('admin.users.cancel') }}</Button>
          <Button type="submit" form="create-user" :disabled="creating">
            {{ creating ? t('admin.users.creating') : password ? t('admin.users.create') : t('admin.users.createAndInvite') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </PageLayout>
</template>
