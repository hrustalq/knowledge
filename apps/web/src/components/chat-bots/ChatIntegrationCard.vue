<script setup lang="ts">
/**
 * One bot (issue #71): whether the platform can reach it, where it answers,
 * and who is linked through it. The webhook refusal is shown verbatim — "An
 * HTTPS URL must be provided" is the whole diagnosis for a development server
 * — and Test sets the webhook again after API_PUBLIC_URL is fixed. A Time or
 * Mattermost bot has no webhook to refuse: what it shows is its websocket's
 * last failure, which reconnects on its own. A Slack bot's webhook is set in
 * the Slack app by the admin, and nothing tells us whether it was: the card
 * gives the address to paste rather than claiming a delivery it cannot see.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { AlertTriangle, Check, CheckCircle2, Copy, Link2, Trash2 } from 'lucide-vue-next'
import {
  CHAT_PLATFORM_NAMES,
  chatBotHandle,
  chatPlatformNeedsServer,
  chatPlatformPastesEndpoint,
  type ChatIdentitiesResponse,
  type ChatIntegrationSummary,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { formatDate } from '@/lib/format'
import { useCopy } from '@/lib/use-copy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PageTabs, panelId, tabId, type PageTab } from '@/components/layout/page'
import AgentSelect from './AgentSelect.vue'
import ChatBindingTable from './ChatBindingTable.vue'

const props = defineProps<{ bot: ChatIntegrationSummary }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const queryClient = useQueryClient()

/** A bot that hears over its own websocket (Time, Mattermost) rather than through our webhook. */
const socket = computed(() => chatPlatformNeedsServer(props.bot.kind))
/** A bot whose endpoint the admin pastes into the platform's own settings (Slack, Teams). */
const pasted = computed(() => chatPlatformPastesEndpoint(props.bot.kind))
const handle = computed(() => (props.bot.botUsername ? chatBotHandle(props.bot.kind, props.bot.botUsername) : null))
const { state: copyState, copy } = useCopy()
/** Product names are never translated. */
const platform = computed(() => CHAT_PLATFORM_NAMES[props.bot.kind])
const tab = ref<'groups' | 'people'>('groups')
const tabs = computed<PageTab<'groups' | 'people'>[]>(() => [
  { key: 'groups', label: t('chatBots.card.groups', { n: props.bot.bindingCount }) },
  { key: 'people', label: t('chatBots.card.people', { n: props.bot.identityCount }) },
])
const identitiesOptions = computed(() =>
  apiQueryOptions('/v1/chat/integrations/{id}/identities', { path: { id: props.bot.id } }),
)
const identitiesQuery = useQuery(computed(() => ({ ...identitiesOptions.value, enabled: tab.value === 'people' })))
const identities = computed(() => (identitiesQuery.data.value as ChatIdentitiesResponse | undefined)?.identities ?? [])

const busy = ref(false)
async function update(body: Record<string, unknown>) {
  busy.value = true
  try {
    await api.patch('/v1/chat/integrations/{id}', { path: { id: props.bot.id }, body })
    emit('changed')
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = false
  }
}

async function test() {
  busy.value = true
  try {
    const res = await api.post('/v1/chat/integrations/{id}/test', { path: { id: props.bot.id } })
    if (res.ok) toast.success(t(socket.value ? 'chatBots.card.testOkSocket' : pasted.value ? (props.bot.kind === 'teams' ? 'chatBots.card.testOkTeams' : 'chatBots.card.testOkSlack') : 'chatBots.card.testOk', { bot: res.botUsername ? chatBotHandle(props.bot.kind, res.botUsername) : props.bot.name, platform: platform.value }))
    else toast.error(t('chatBots.card.testFailed', { reason: res.error ?? '' }))
    emit('changed')
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = false
  }
}

const confirmDelete = ref(false)
async function remove() {
  try {
    await api.delete('/v1/chat/integrations/{id}', { path: { id: props.bot.id } })
    toast.success(t('chatBots.card.deleted', { name: props.bot.name }))
    emit('changed')
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

async function unlink(identityId: string) {
  try {
    await api.delete('/v1/chat/integrations/{id}/identities/{identityId}', { path: { id: props.bot.id, identityId } })
    void queryClient.invalidateQueries({ queryKey: identitiesOptions.value.queryKey })
    emit('changed')
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
</script>

<template>
  <section class="min-w-0 rounded-xl border bg-card">
    <header class="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-start">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="font-display text-base font-semibold tracking-tight">{{ bot.name }}</h2>
          <Badge variant="outline">{{ t(`chatBots.kind.${bot.kind}`) }}</Badge>
          <Badge v-if="!bot.enabled" variant="secondary">{{ t('chatBots.card.off') }}</Badge>
        </div>
        <p class="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
          <span v-if="handle" class="whitespace-nowrap">{{ handle }} ·</span>
          <span class="whitespace-nowrap">{{ t('chatBots.card.token', { hint: bot.credentialHint ?? '—' }) }}</span>
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" :disabled="busy" @click="test">{{ t('chatBots.card.test') }}</Button>
        <Button size="sm" variant="outline" :disabled="busy" @click="update({ enabled: !bot.enabled })">
          {{ bot.enabled ? t('chatBots.card.disable') : t('chatBots.card.enable') }}
        </Button>
        <Button size="icon" variant="ghost" class="size-8" :aria-label="t('common.deleteNamed', { name: bot.name })" @click="confirmDelete = true">
          <Trash2 class="size-4" />
        </Button>
      </div>
    </header>

    <div class="space-y-4 px-5 py-4">
      <div
        v-if="bot.webhookError"
        role="status"
        class="flex items-start gap-2 rounded-md border kn-callout-warning px-3 py-2.5 text-sm"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div class="min-w-0 space-y-1">
          <p class="font-medium">{{ t(socket ? 'chatBots.card.socketDown' : 'chatBots.card.webhookRefused', { platform }) }}</p>
          <p class="text-xs">{{ bot.webhookError }}</p>
          <p class="text-xs">{{ t(socket ? 'chatBots.card.socketFix' : 'chatBots.card.webhookFix', { platform }) }}</p>
          <p v-if="!socket" class="break-all font-mono text-xs opacity-80">{{ bot.webhookUrl }}</p>
        </div>
      </div>
      <div v-else-if="pasted" class="space-y-1.5 text-xs text-muted-foreground">
        <p class="flex items-start gap-2">
          <Link2 class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{{ t(bot.kind === 'teams' ? 'chatBots.card.messagingEndpoint' : 'chatBots.card.requestUrl', { platform }) }}</span>
        </p>
        <div class="flex items-center gap-2 pl-5.5">
          <code class="min-w-0 flex-1 break-all rounded-md border bg-muted/40 px-2 py-1 font-mono text-foreground">{{ bot.webhookUrl }}</code>
          <Button
            size="icon"
            variant="ghost"
            class="size-8 shrink-0"
            :aria-label="t(bot.kind === 'teams' ? 'chatBots.card.copyMessagingEndpoint' : 'chatBots.card.copyRequestUrl')"
            @click="copy(bot.webhookUrl)"
          >
            <Check v-if="copyState === 'copied'" class="size-4" aria-hidden="true" />
            <Copy v-else class="size-4" aria-hidden="true" />
          </Button>
        </div>
        <p v-if="copyState !== 'idle'" class="pl-5.5" aria-live="polite">
          {{ t(copyState === 'copied' ? 'common.copied' : 'chatBots.card.copyFailed') }}
        </p>
      </div>
      <p v-else class="flex items-center gap-2 text-xs text-muted-foreground">
        <CheckCircle2 class="size-3.5 shrink-0" aria-hidden="true" />
        <span class="min-w-0 break-all">
          {{ socket ? t('chatBots.card.socketOk', { server: bot.serverUrl }) : t('chatBots.card.webhookOk', { url: bot.webhookUrl }) }}
        </span>
      </p>

      <div class="grid max-w-md gap-1.5">
        <span class="text-xs font-medium">{{ t('chatBots.fields.agent') }}</span>
        <AgentSelect
          :model-value="bot.defaultAgentKey"
          :default-label="t('chatBots.fields.agentResearcher')"
          @update:model-value="(v) => update({ defaultAgentKey: v })"
        />
      </div>

      <!-- Scoped by bot: the settings page lists every bot, so a bare key
           would give each card's Groups tab the same id. -->
      <PageTabs v-model="tab" :tabs="tabs" :scope="bot.id" :label="bot.name" />

      <div :id="panelId(tab, bot.id)" role="tabpanel" :aria-labelledby="tabId(tab, bot.id)" class="space-y-4">
        <ChatBindingTable v-if="tab === 'groups'" :integration-id="bot.id" :kind="bot.kind" @changed="emit('changed')" />

        <template v-else>
          <p class="text-xs text-muted-foreground">{{ t('chatBots.people.hint') }}</p>
          <ul v-if="identities.length" class="divide-y rounded-md border">
            <li v-for="i in identities" :key="i.id" class="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span class="min-w-0 flex-1 truncate">
                {{ i.externalUserName ?? i.externalUserId }}
                <span class="text-muted-foreground"> → {{ i.userDisplayName ?? i.userId }}</span>
                <span class="text-xs text-muted-foreground"> · {{ formatDate(i.linkedAt) }}</span>
              </span>
              <Button size="sm" variant="outline" @click="unlink(i.id)">{{ t('chatBots.people.unlink') }}</Button>
            </li>
          </ul>
          <p v-else-if="identitiesQuery.isSuccess.value" class="text-sm text-muted-foreground">{{ t('chatBots.people.none') }}</p>
        </template>
      </div>
    </div>

    <AlertDialog v-model:open="confirmDelete">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('chatBots.card.deleteTitle', { name: bot.name }) }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t('chatBots.card.deleteBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="remove">{{ t('common.delete') }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>
</template>
