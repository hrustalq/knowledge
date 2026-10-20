<script setup lang="ts">
/**
 * One account's live sessions, as a platform admin sees them (#292) — the body
 * of the Sessions dialog on Access → Accounts. It is mounted only while the
 * dialog is open, so the list is fetched when asked for, never for the whole
 * roster. Rows are the profile page's own (SessionList); only what revoking
 * calls differs. API keys are out of reach here on purpose: signing someone out
 * of a lost laptop should not break their scripts.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type { ListSessionsResponse, RevokeSessionsResponse, UserSummary } from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import SessionList from '@/components/profile/SessionList.vue'

const props = defineProps<{ user: UserSummary }>()

const { t } = useI18n()
const queryClient = useQueryClient()
const options = apiQueryOptions('/v1/users/{id}/sessions', { path: { id: props.user.userId } })
const query = useQuery(options)
const sessions = computed(() => (query.data.value as ListSessionsResponse | undefined)?.sessions ?? [])

const refresh = () => queryClient.invalidateQueries({ queryKey: options.queryKey })

async function revoke(sessionId: string) {
  try {
    await api.delete('/v1/users/{id}/sessions/{sessionId}', { path: { id: props.user.userId, sessionId } })
    toast.success(t('profileSettings.sessions.revoked'))
  } catch (e) {
    toast.error(errorMessage(e, t) || t('profileSettings.sessions.failed'))
  }
  // Either way the list is re-read: a 404 means the row is already gone.
  void refresh()
}

async function revokeAll() {
  try {
    const res = (await api.post('/v1/users/{id}/revoke-sessions', { path: { id: props.user.userId } })) as RevokeSessionsResponse
    toast.success(t('users.sessionsRevokedAll', { n: res.revoked }, res.revoked))
  } catch (e) {
    toast.error(errorMessage(e, t) || t('profileSettings.sessions.failed'))
  }
  void refresh()
}
</script>

<template>
  <DialogHeader>
    <DialogTitle class="pr-8 break-words">{{ t('users.sessionsTitle', { name: user.displayName }) }}</DialogTitle>
    <DialogDescription class="break-words">{{ t('users.sessionsDesc', { email: user.email }) }}</DialogDescription>
  </DialogHeader>

  <div class="max-h-[50vh] min-w-0 overflow-y-auto">
    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton v-for="i in 2" :key="i" class="h-10 w-full" />
    </div>
    <div v-else-if="query.isError.value" class="space-y-2 text-sm">
      <p class="text-destructive">{{ errorMessage(query.error.value, t) || t('users.sessionsLoadFailed') }}</p>
      <Button size="sm" variant="outline" @click="query.refetch()">{{ t('common.retry') }}</Button>
    </div>
    <p v-else-if="sessions.length === 0" class="text-muted-foreground text-sm">{{ t('users.sessionsNone') }}</p>
    <SessionList v-else :sessions="sessions" :revoke="revoke" />
  </div>

  <DialogFooter>
    <Button
      variant="destructive"
      :disabled="query.isPending.value || sessions.length === 0"
      @click="revokeAll"
    >
      {{ t('users.sessionsRevokeAll') }}
    </Button>
  </DialogFooter>
</template>
