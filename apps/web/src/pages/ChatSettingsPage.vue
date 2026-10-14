<script setup lang="ts">
/**
 * /settings/chat (issue #71): the workspace's chat bots. Admin-only, like the
 * routes behind it — connecting a bot and binding a group are an admin
 * asserting who may read the workspace's answers. While the deployment's
 * CHAT_ENABLED is off the page still works, so a bot can be prepared, and says
 * plainly that nothing will be answered: a bot that reads "on" while the
 * server ignores it is a silent clamp (CLAUDE.md).
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Plus } from 'lucide-vue-next'
import type { ChatIntegrationsResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { PageState } from '@/components/layout/page'
import ChatIntegrationCard from '@/components/chat-bots/ChatIntegrationCard.vue'
import ConnectBotDialog from '@/components/chat-bots/ConnectBotDialog.vue'

const { t } = useI18n()
const auth = useAuthStore()
const queryClient = useQueryClient()
const canManage = computed(() => auth.canAdminWorkspace)

const options = apiQueryOptions('/v1/chat/integrations', { query: { workspaceId: getWorkspaceId() } })
const query = useQuery({ ...options, enabled: canManage })
const data = computed(() => query.data.value as ChatIntegrationsResponse | undefined)

const connecting = ref(false)
function refresh() {
  void queryClient.invalidateQueries({ queryKey: options.queryKey })
}
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-6">
    <div class="flex flex-wrap items-start gap-3">
      <div class="min-w-0 flex-1">
        <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('chatBots.title') }}</h1>
        <p class="text-muted-foreground mt-0.5 text-sm">{{ t('chatBots.subtitle') }}</p>
      </div>
      <Button v-if="canManage" size="sm" @click="connecting = true">
        <Plus class="size-4" />{{ t('chatBots.connect.open') }}
      </Button>
    </div>

    <p v-if="!canManage" class="text-sm text-muted-foreground">{{ t('chatBots.adminOnly') }}</p>

    <template v-else>
      <PageState v-if="query.isPending.value" state="loading" :rows="2" row-class="h-32" />
      <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />
      <template v-else-if="data">
        <p
          v-if="!data.enabled"
          class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
        >
          {{ t('chatBots.ceilingOff') }}
        </p>
        <div v-if="data.integrations.length" class="flex flex-col gap-5">
          <ChatIntegrationCard v-for="bot in data.integrations" :key="bot.id" :bot="bot" @changed="refresh" />
        </div>
        <div v-else class="max-w-xl rounded-xl border border-dashed px-5 py-6">
          <p class="text-sm font-medium">{{ t('chatBots.empty.title') }}</p>
          <p class="mt-1 text-sm text-muted-foreground">{{ t('chatBots.empty.body') }}</p>
        </div>
      </template>
    </template>

    <ConnectBotDialog v-model:open="connecting" @created="refresh" />
  </div>
</template>
