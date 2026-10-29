<script setup lang="ts">
/**
 * Your messenger accounts (issue #71): every one a workspace bot answers as
 * you. Listed with unlink, because an account you no longer hold — a lost
 * phone, a shared bot test — should not keep asking with your access. Linking
 * starts in the messenger, so there is no "add" here; the hint says where.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { MessageCircle } from 'lucide-vue-next'
import type { ChatIdentitiesResponse } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { formatDate } from '@/shared/utils/format'
import { Button } from '@/shared/ui/button'

const { t } = useI18n()
const queryClient = useQueryClient()
const options = apiQueryOptions('/v1/me/chat-identities')
const query = useQuery(options)
const identities = computed(() => (query.data.value as ChatIdentitiesResponse | undefined)?.identities ?? [])

async function unlink(id: string) {
  try {
    await api.delete('/v1/me/chat-identities/{id}', { path: { id } })
    toast.success(t('chatBots.profile.unlinked'))
    void queryClient.invalidateQueries({ queryKey: options.queryKey })
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <div class="min-w-0">
    <h3 class="text-sm font-medium">{{ t('chatBots.profile.title') }}</h3>
    <p class="mt-0.5 text-xs text-muted-foreground">{{ t('chatBots.profile.hint') }}</p>
  </div>
  <ul v-if="identities.length" class="mt-3 space-y-2">
    <li v-for="i in identities" :key="i.id" class="flex flex-wrap items-center gap-2 text-sm">
      <MessageCircle class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate">
        {{ t('chatBots.profile.entry', { account: i.externalUserName ?? i.externalUserId, bot: i.integrationName }) }}
        <span class="text-xs text-muted-foreground">· {{ formatDate(i.linkedAt) }}</span>
      </span>
      <Button variant="outline" size="sm" class="shrink-0" @click="unlink(i.id)">{{ t('chatBots.profile.unlink') }}</Button>
    </li>
  </ul>
  <p v-else-if="query.isSuccess.value" class="mt-3 text-xs text-muted-foreground">{{ t('chatBots.profile.none') }}</p>
</template>
