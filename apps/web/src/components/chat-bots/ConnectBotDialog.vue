<script setup lang="ts">
/**
 * Connect a bot (issue #71). One step for Telegram: name it, paste the token
 * BotFather gave you. The API checks the token with Telegram before saving
 * and points the bot at this server, so a bad token fails here, in words,
 * rather than as a bot that silently never answers.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { CHAT_PLATFORM_KINDS, SUPPORTED_LOCALES, type ChatIntegrationSummary, type Locale } from '@knowledge/contracts'
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

const form = reactive({ name: '', token: '', agentKey: null as string | null, locale: 'en' as Locale })
const saving = ref(false)
const valid = computed(() => form.name.trim().length > 0 && form.token.trim().length > 0)

watch(open, (isOpen) => {
  if (isOpen) Object.assign(form, { name: '', token: '', agentKey: null, locale: 'en' })
})

async function submit() {
  if (!valid.value || saving.value) return
  saving.value = true
  try {
    const created = (await api.post('/v1/chat/integrations', {
      body: {
        workspaceId: getWorkspaceId(),
        kind: CHAT_PLATFORM_KINDS[0],
        name: form.name.trim(),
        token: form.token.trim(),
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
        <DialogDescription>{{ t('chatBots.connect.description') }}</DialogDescription>
      </DialogHeader>
      <form class="space-y-4" @submit.prevent="submit">
        <ol class="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li>{{ t('chatBots.connect.step1') }}</li>
          <li>{{ t('chatBots.connect.step2') }}</li>
          <li>{{ t('chatBots.connect.step3') }}</li>
        </ol>
        <div class="space-y-1.5">
          <Label for="chat-bot-name">{{ t('chatBots.fields.name') }}</Label>
          <Input id="chat-bot-name" v-model="form.name" maxlength="80" :placeholder="t('chatBots.fields.namePlaceholder')" />
        </div>
        <div class="space-y-1.5">
          <Label for="chat-bot-token">{{ t('chatBots.fields.token') }}</Label>
          <Input id="chat-bot-token" v-model="form.token" type="password" autocomplete="off" spellcheck="false" />
          <p class="text-xs text-muted-foreground">{{ t('chatBots.fields.tokenHint') }}</p>
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
            {{ saving ? t('chatBots.connect.checking') : t('chatBots.connect.submit') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
