<script setup lang="ts">
/**
 * Where you are signed in (#75): every live session, with how it was opened,
 * from where, and when it was last used. Any but the current one can be signed
 * out from here — a browser you left logged in elsewhere. The current one is
 * not, because that is what Log out is for, and a row that signs you out of the
 * page you are reading would look like a crash.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type { ListSessionsResponse } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import SessionList from './SessionList.vue'

const { t } = useI18n()
const queryClient = useQueryClient()
const options = apiQueryOptions('/v1/me/sessions')
const query = useQuery(options)
const sessions = computed(() => (query.data.value as ListSessionsResponse | undefined)?.sessions ?? [])

async function revoke(id: string) {
  try {
    await api.delete('/v1/me/sessions/{sessionId}', { path: { sessionId: id } })
    toast.success(t('profileSettings.sessions.revoked'))
    void queryClient.invalidateQueries({ queryKey: options.queryKey })
  } catch (e) {
    toast.error(errorMessage(e, t) || t('profileSettings.sessions.failed'))
  }
}
</script>

<template>
  <div class="min-w-0">
    <h3 class="text-sm font-medium">{{ t('profileSettings.sessions.title') }}</h3>
    <p class="mt-0.5 text-xs text-muted-foreground">{{ t('profileSettings.sessions.hint') }}</p>
  </div>
  <SessionList v-if="sessions.length" class="mt-3" :sessions="sessions" :revoke="revoke" />
  <p v-else-if="query.isSuccess.value" class="mt-3 text-xs text-muted-foreground">{{ t('profileSettings.sessions.none') }}</p>
</template>
