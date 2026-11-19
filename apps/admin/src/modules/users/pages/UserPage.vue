<script setup lang="ts">
/**
 * One account (#1239): every action `v1/users` supports, the workspaces the
 * person belongs to, and where they are signed in. Each write is audited
 * API-side (`user.*`, `auth.session_revoked`); this page only asks.
 *
 * The account is read from the roster query rather than a route of its own:
 * the roster is one small response the list page already holds, and a write
 * re-reads it. Memberships are read-only here: a role is changed from the
 * workspace's own Access page, by whoever manages that workspace.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { ArrowLeft, UserX } from 'lucide-vue-next'
import type { UserSummary } from '@knowledge/contracts'
import { PageLayout, PageState } from '@knowledge/ui/layout'
import { Badge } from '@knowledge/ui/badge'
import { Button } from '@knowledge/ui/button'
import { confirm } from '@knowledge/ui/confirm'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@knowledge/ui/dialog'
import { formatDate, formatDateTime, formatRelative } from '@knowledge/contracts/format'
import { Input } from '@knowledge/ui/input'
import { Label } from '@knowledge/ui/label'
import { SessionList } from '@knowledge/ui/session-list'
import { api, apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { useAuthStore } from '@/stores/auth'
import { accountBadges, credentialKeys } from '../model/account'

const props = defineProps<{ id: string }>()

const { t, locale } = useI18n()
const auth = useAuthStore()
const queryClient = useQueryClient()

const list = apiQueryOptions('/v1/users')
const users = useQuery(list)
const user = computed(() => users.data.value?.users.find((u) => u.userId === props.id))
/** The API refuses disabling yourself or dropping your own admin; the buttons say so first. */
const isSelf = computed(() => props.id === auth.me?.userId)

const sessionsQuery = computed(() => apiQueryOptions('/v1/users/{id}/sessions', { path: { id: props.id } }))
// Only for an account that exists: an unknown id is the not-found state, not a failed sessions call.
const sessions = useQuery(computed(() => ({ ...sessionsQuery.value, enabled: !!user.value })))
const refreshSessions = () => queryClient.invalidateQueries({ queryKey: sessionsQuery.value.queryKey })

// --- writes ----------------------------------------------------------------
const busy = ref(false)

async function patch(body: { displayName?: string; isAdmin?: boolean; disabled?: boolean; password?: string }, done: string): Promise<boolean> {
  busy.value = true
  try {
    await api.patch('/v1/users/{id}', { path: { id: props.id }, body })
    toast.success(done)
    void queryClient.invalidateQueries({ queryKey: list.queryKey })
    // A disable or a new password signs the person out everywhere.
    if (body.disabled || body.password) void refreshSessions()
    return true
  } catch (e) {
    toast.error(errorMessage(e, t))
    return false
  } finally {
    busy.value = false
  }
}

async function toggleAdmin(u: UserSummary) {
  if (u.isAdmin) return void patch({ isAdmin: false }, t('admin.users.adminRevoked', { name: u.displayName }))
  const ok = await confirm({
    title: t('admin.users.makeAdminTitle', { name: u.displayName }),
    description: t('admin.users.makeAdminBody'),
    action: t('admin.users.makeAdmin'),
  })
  if (ok) void patch({ isAdmin: true }, t('admin.users.adminGranted', { name: u.displayName }))
}

async function toggleDisabled(u: UserSummary) {
  if (u.disabled) return void patch({ disabled: false }, t('admin.users.enabled', { name: u.displayName }))
  const ok = await confirm({
    title: t('admin.users.disableTitle', { name: u.displayName }),
    description: t('admin.users.disableBody'),
    action: t('admin.users.disable'),
    destructive: true,
  })
  if (ok) void patch({ disabled: true }, t('admin.users.disabledDone', { name: u.displayName }))
}

// Rename and set-password share one dialog: one field, one submit.
const editing = ref<'name' | 'password' | null>(null)
const draft = ref('')

function openEdit(kind: 'name' | 'password') {
  draft.value = kind === 'name' ? (user.value?.displayName ?? '') : ''
  editing.value = kind
}

async function submitEdit() {
  const u = user.value
  if (!u) return
  const ok =
    editing.value === 'name'
      ? await patch({ displayName: draft.value }, t('admin.users.renamed'))
      : await patch({ password: draft.value }, t('admin.users.passwordSet', { name: u.displayName }))
  if (ok) editing.value = null
}

async function revokeSession(sessionId: string) {
  try {
    await api.delete('/v1/users/{id}/sessions/{sessionId}', { path: { id: props.id, sessionId } })
    toast.success(t('admin.users.sessionRevoked'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
  // Either way: a 404 means the row is already gone.
  void refreshSessions()
}

async function revokeAll(u: UserSummary) {
  const ok = await confirm({
    title: t('admin.users.revokeAllTitle', { name: u.displayName }),
    description: t('admin.users.revokeAllBody'),
    action: t('admin.users.revokeAll'),
    destructive: true,
  })
  if (!ok) return
  try {
    const res = await api.post('/v1/users/{id}/revoke-sessions', { path: { id: props.id } })
    toast.success(t('admin.users.revokedAll', { n: res.revoked }))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
  void refreshSessions()
}
</script>

<template>
  <PageState v-if="users.isPending.value" state="loading" :rows="6" row-class="h-10" />
  <PageState v-else-if="users.isError.value" state="error" :error="users.error.value" />
  <PageLayout v-else-if="!user" :title="t('admin.users.notFound')">
    <PageState state="empty" :icon="UserX" :title="t('admin.users.notFound')" :description="t('admin.users.notFoundHint')">
      <template #actions>
        <Button as-child variant="outline" size="sm">
          <RouterLink to="/users">{{ t('admin.users.allUsers') }}</RouterLink>
        </Button>
      </template>
    </PageState>
  </PageLayout>

  <PageLayout v-else :title="user.displayName" :subtitle="user.email">
    <template #actions>
      <Button variant="outline" size="sm" :disabled="busy" @click="openEdit('name')">{{ t('admin.users.rename') }}</Button>
      <Button variant="outline" size="sm" :disabled="busy" @click="openEdit('password')">{{ t('admin.users.setPassword') }}</Button>
      <Button variant="outline" size="sm" :disabled="busy || isSelf" @click="toggleAdmin(user)">
        {{ user.isAdmin ? t('admin.users.revokeAdmin') : t('admin.users.makeAdmin') }}
      </Button>
      <Button :variant="user.disabled ? 'outline' : 'destructive'" size="sm" :disabled="busy || isSelf" @click="toggleDisabled(user)">
        {{ user.disabled ? t('admin.users.enable') : t('admin.users.disable') }}
      </Button>
    </template>
    <template #meta>
      <div class="space-y-2">
        <RouterLink to="/users" class="text-muted-foreground hover:text-foreground text-caption inline-flex items-center gap-1 transition-colors">
          <ArrowLeft class="size-3.5" aria-hidden="true" /> {{ t('admin.users.allUsers') }}
        </RouterLink>
        <div class="text-caption flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge v-for="b in accountBadges(user)" :key="b.key" :variant="b.variant">{{ t(`admin.users.badge.${b.key}`) }}</Badge>
          <span class="text-muted-foreground">{{ t('admin.users.createdOn', { date: formatDate(user.createdAt, locale) }) }}</span>
          <span class="text-muted-foreground">
            <template v-if="user.lastSignInAt">
              {{ t('admin.users.lastSignIn') }}
              <time :datetime="user.lastSignInAt" :title="formatDateTime(user.lastSignInAt, locale)">{{ formatRelative(user.lastSignInAt, locale) }}</time>
            </template>
            <template v-else>{{ t('admin.users.neverSignedIn') }}</template>
          </span>
          <span class="text-muted-foreground">
            {{ credentialKeys(user).map((k) => t(`admin.users.credential.${k}`)).join(' + ') || t('admin.users.credential.none') }}
          </span>
        </div>
        <p v-if="isSelf" class="text-muted-foreground text-caption">{{ t('admin.users.selfNote') }}</p>
      </div>
    </template>

    <section class="space-y-2" aria-labelledby="user-workspaces">
      <h2 id="user-workspaces" class="font-display flex items-baseline gap-2 text-base font-semibold tracking-tight">
        {{ t('admin.users.workspaces') }}
        <span v-if="user.memberships.length" class="text-muted-foreground text-caption font-sans font-normal">{{ user.memberships.length }}</span>
      </h2>
      <p v-if="!user.memberships.length" class="text-ui text-muted-foreground rounded-lg border px-3 py-2">{{ t('admin.users.noWorkspacesLong') }}</p>
      <ul v-else class="divide-y rounded-lg border">
        <li
          v-for="m in user.memberships"
          :key="m.workspaceId"
          class="text-ui grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_8rem_minmax(0,14rem)]"
        >
          <span class="truncate font-medium">{{ m.workspaceName }}</span>
          <span class="justify-self-end sm:justify-self-start">{{ t(`admin.users.role.${m.role}`) }}</span>
          <span class="text-muted-foreground text-caption col-span-2 sm:col-span-1">
            {{
              [
                m.source === 'manual' ? null : t(`admin.users.source.${m.source}`),
                m.trustedOperator ? t('admin.users.trustedOperator') : null,
              ].filter(Boolean).join(' · ')
            }}
          </span>
        </li>
      </ul>
    </section>

    <section class="space-y-2" aria-labelledby="user-sessions">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="user-sessions" class="font-display text-base font-semibold tracking-tight">{{ t('admin.users.sessions') }}</h2>
        <Button
          v-if="sessions.data.value?.sessions.length"
          variant="outline"
          size="sm"
          @click="revokeAll(user)"
        >
          {{ t('admin.users.revokeAll') }}
        </Button>
      </div>
      <p class="text-muted-foreground text-caption max-w-prose">{{ t('admin.users.sessionsHint') }}</p>
      <PageState v-if="sessions.isPending.value" state="loading" :rows="2" row-class="h-10" />
      <PageState v-else-if="sessions.isError.value" state="error" :error="sessions.error.value" />
      <p v-else-if="!sessions.data.value?.sessions.length" class="text-ui text-muted-foreground rounded-lg border px-3 py-2">
        {{ t('admin.users.noSessions') }}
      </p>
      <div v-else class="rounded-lg border px-3 py-3">
        <SessionList :sessions="sessions.data.value.sessions" :revoke="revokeSession" :when="(iso) => formatRelative(iso, locale)" />
      </div>
    </section>

    <Dialog :open="editing !== null" @update:open="(open) => { if (!open) editing = null }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ editing === 'name' ? t('admin.users.renameTitle') : t('admin.users.setPasswordTitle', { name: user.displayName }) }}</DialogTitle>
          <DialogDescription>
            {{ editing === 'name' ? t('admin.users.renameHint') : t('admin.users.setPasswordHint') }}
          </DialogDescription>
        </DialogHeader>
        <form id="edit-account" class="space-y-1.5" @submit.prevent="submitEdit">
          <Label for="edit-field">{{ editing === 'name' ? t('admin.users.displayName') : t('admin.users.newPassword') }}</Label>
          <Input
            v-if="editing === 'name'"
            id="edit-field"
            v-model="draft"
            required
            maxlength="120"
            autocomplete="off"
          />
          <Input
            v-else
            id="edit-field"
            v-model="draft"
            type="password"
            required
            minlength="8"
            maxlength="200"
            autocomplete="new-password"
          />
        </form>
        <DialogFooter>
          <Button variant="ghost" @click="editing = null">{{ t('admin.users.cancel') }}</Button>
          <Button type="submit" form="edit-account" :disabled="busy">
            {{ editing === 'name' ? t('admin.users.save') : t('admin.users.setPassword') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </PageLayout>
</template>
