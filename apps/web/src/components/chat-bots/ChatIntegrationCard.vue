<script setup lang="ts">
/**
 * One bot (issue #71): whether Telegram can reach it, where it answers, and
 * who is linked through it. The webhook refusal is shown verbatim — "An HTTPS
 * URL must be provided" is the whole diagnosis for a development server — and
 * Test sets the webhook again after API_PUBLIC_URL is fixed.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { AlertTriangle, CheckCircle2, Trash2 } from 'lucide-vue-next'
import type {
  ChatIdentitiesResponse,
  ChatIntegrationSummary,
  ChatIntegrationTestResponse,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { formatDate } from '@/lib/format'
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
import AgentSelect from './AgentSelect.vue'
import ChatBindingTable from './ChatBindingTable.vue'

const props = defineProps<{ bot: ChatIntegrationSummary }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const queryClient = useQueryClient()

const tab = ref<'groups' | 'people'>('groups')
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
    const res = (await api.post('/v1/chat/integrations/{id}/test', { path: { id: props.bot.id } })) as ChatIntegrationTestResponse
    if (res.ok) toast.success(t('chatBots.card.testOk', { bot: `@${res.botUsername}` }))
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
          <h2 class="font-display text-[15px] font-semibold tracking-tight">{{ bot.name }}</h2>
          <Badge variant="outline">{{ t(`chatBots.kind.${bot.kind}`) }}</Badge>
          <Badge v-if="!bot.enabled" variant="secondary">{{ t('chatBots.card.off') }}</Badge>
        </div>
        <p class="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
          <span v-if="bot.botUsername" class="whitespace-nowrap">@{{ bot.botUsername }} ·</span>
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
        class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div class="min-w-0 space-y-1">
          <p class="font-medium">{{ t('chatBots.card.webhookRefused') }}</p>
          <p class="text-xs">{{ bot.webhookError }}</p>
          <p class="text-xs">{{ t('chatBots.card.webhookFix') }}</p>
          <p class="break-all font-mono text-xs opacity-80">{{ bot.webhookUrl }}</p>
        </div>
      </div>
      <p v-else class="flex items-center gap-2 text-xs text-muted-foreground">
        <CheckCircle2 class="size-3.5 shrink-0" aria-hidden="true" />
        <span class="min-w-0 break-all">{{ t('chatBots.card.webhookOk', { url: bot.webhookUrl }) }}</span>
      </p>

      <div class="grid max-w-md gap-1.5">
        <span class="text-xs font-medium">{{ t('chatBots.fields.agent') }}</span>
        <AgentSelect
          :model-value="bot.defaultAgentKey"
          :default-label="t('chatBots.fields.agentResearcher')"
          @update:model-value="(v) => update({ defaultAgentKey: v })"
        />
      </div>

      <div class="flex gap-1 overflow-x-auto border-b" role="tablist">
        <button
          v-for="k in (['groups', 'people'] as const)"
          :key="k"
          type="button"
          role="tab"
          :aria-selected="tab === k"
          class="-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors"
          :class="tab === k ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
          @click="tab = k"
        >
          {{ k === 'groups' ? t('chatBots.card.groups', { n: bot.bindingCount }) : t('chatBots.card.people', { n: bot.identityCount }) }}
        </button>
      </div>

      <ChatBindingTable v-if="tab === 'groups'" :integration-id="bot.id" @changed="emit('changed')" />

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
