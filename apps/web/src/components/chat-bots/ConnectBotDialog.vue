<script setup lang="ts">
/**
 * Connect a bot (issue #71). One step: pick the messenger, name the bot, paste
 * its token — BotFather's for Telegram; for Time, the token from Integrations
 * → Bot accounts plus the address of the customer's own Time server; for
 * Mattermost, a bot account's access token plus its server's address. The API
 * checks the token with the platform before saving, so a bad token or an
 * unreachable server fails here, in words, rather than as a bot that silently
 * never answers.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import {
  CHAT_PLATFORM_KINDS,
  CHAT_PLATFORM_NAMES,
  SUPPORTED_LOCALES,
  chatPlatformNeedsServer,
  type ChatIntegrationSummary,
  type ChatPlatformKind,
  type Locale,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import AgentSelect from './AgentSelect.vue'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [ChatIntegrationSummary] }>()
const { t } = useI18n()

const blank = () => ({
  kind: CHAT_PLATFORM_KINDS[0] as ChatPlatformKind,
  name: '',
  token: '',
  serverUrl: '',
  agentKey: null as string | null,
  locale: 'en' as Locale,
})
const form = reactive(blank())
const saving = ref(false)
const needsServer = computed(() => chatPlatformNeedsServer(form.kind))
const platform = computed(() => CHAT_PLATFORM_NAMES[form.kind])
/** Where each platform's bot token comes from. */
const TOKEN_HINT: Record<ChatPlatformKind, string> = {
  telegram: 'chatBots.fields.tokenHint',
  time: 'chatBots.fields.tokenHintTime',
  mattermost: 'chatBots.fields.tokenHintMattermost',
}
/** Telegram's strings sit at the top of `connect`; every other platform has its own block. */
const copy = (key: string) => t(form.kind === 'telegram' ? `chatBots.connect.${key}` : `chatBots.connect.${form.kind}.${key}`)
const valid = computed(
  () => form.name.trim().length > 0 && form.token.trim().length > 0 && (!needsServer.value || form.serverUrl.trim().length > 0),
)

watch(open, (isOpen) => {
  if (isOpen) Object.assign(form, blank())
})

async function submit() {
  if (!valid.value || saving.value) return
  saving.value = true
  try {
    const created = (await api.post('/v1/chat/integrations', {
      body: {
        workspaceId: getWorkspaceId(),
        kind: form.kind,
        name: form.name.trim(),
        token: form.token.trim(),
        ...(needsServer.value ? { serverUrl: form.serverUrl.trim() } : {}),
        defaultAgentKey: form.agentKey,
        locale: form.locale,
      },
    })) as ChatIntegrationSummary
    toast.success(t('chatBots.connect.done', { bot: created.botUsername ? `@${created.botUsername}` : created.name }))
    emit('created', created)
    open.value = false
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t('chatBots.connect.title') }}</DialogTitle>
        <DialogDescription>{{ copy('description') }}</DialogDescription>
      </DialogHeader>
      <form class="space-y-4" @submit.prevent="submit">
        <div class="space-y-1.5">
          <Label>{{ t('chatBots.fields.platform') }}</Label>
          <Select v-model="form.kind">
            <SelectTrigger class="h-9 w-full sm:w-48" :aria-label="t('chatBots.fields.platform')"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="k in CHAT_PLATFORM_KINDS" :key="k" :value="k">{{ t(`chatBots.kind.${k}`) }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <ol class="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li>{{ copy('step1') }}</li>
          <li>{{ copy('step2') }}</li>
          <li>{{ copy('step3') }}</li>
        </ol>
        <div v-if="needsServer" class="space-y-1.5">
          <Label for="chat-bot-server">{{ t('chatBots.fields.serverUrl', { platform }) }}</Label>
          <Input
            id="chat-bot-server"
            v-model="form.serverUrl"
            type="url"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            maxlength="500"
            :placeholder="`https://${form.kind}.example.com`"
          />
          <p class="text-xs text-muted-foreground">{{ t('chatBots.fields.serverUrlHint', { platform }) }}</p>
        </div>
        <div class="space-y-1.5">
          <Label for="chat-bot-name">{{ t('chatBots.fields.name') }}</Label>
          <Input id="chat-bot-name" v-model="form.name" maxlength="80" :placeholder="t('chatBots.fields.namePlaceholder')" />
        </div>
        <div class="space-y-1.5">
          <Label for="chat-bot-token">{{ t('chatBots.fields.token') }}</Label>
          <Input id="chat-bot-token" v-model="form.token" type="password" autocomplete="off" spellcheck="false" />
          <p class="text-xs text-muted-foreground">
            {{ t(TOKEN_HINT[form.kind]) }}
          </p>
        </div>
        <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <div class="space-y-1.5">
            <Label>{{ t('chatBots.fields.agent') }}</Label>
            <AgentSelect v-model="form.agentKey" :default-label="t('chatBots.fields.agentResearcher')" />
          </div>
          <div class="space-y-1.5">
            <Label>{{ t('chatBots.fields.locale') }}</Label>
            <Select v-model="form.locale">
              <SelectTrigger class="h-9 w-full" :aria-label="t('chatBots.fields.locale')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="l in SUPPORTED_LOCALES" :key="l" :value="l">{{ t(`chatBots.locale.${l}`) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" @click="open = false">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="!valid || saving">
            {{ saving ? copy('checking') : t('chatBots.connect.submit') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
