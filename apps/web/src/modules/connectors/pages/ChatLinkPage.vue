<script setup lang="ts">
/**
 * /chat/link?code= (issue #71): where the link a chat bot sent lands.
 *
 * The bot proved which messenger account asked; this page proves which person
 * is answering — it requires sign-in (the router sends you through /login and
 * back). The preview names the account and the workspace first, because the
 * person reading this should be able to tell a link they asked for from one
 * somebody forwarded them.
 *
 * Confirming still links nothing (#1104): it shows a one-time number, and the
 * account is linked when that number reaches the bot from the private chat the
 * link came from. A forwarded link therefore needs the number handed back to
 * whoever forwarded it, which is what the warning under it says not to do.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute } from 'vue-router'
import type { ChatLinkPending, ChatLinkPreview } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@knowledge/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '@knowledge/ui/card'

const { t } = useI18n()
const route = useRoute()

const code = computed(() => (typeof route.query.code === 'string' ? route.query.code : ''))
const preview = ref<ChatLinkPreview | null>(null)
const pending = ref<ChatLinkPending | null>(null)
const error = ref<string | null>(null)
const state = ref<'loading' | 'ready' | 'linking' | 'pending' | 'failed'>('loading')

// After hydration only: the code is a one-time secret, and the SSR pass has no
// session to preview it with anyway.
onMounted(async () => {
  if (!code.value) {
    error.value = t('chatBots.link.missing')
    state.value = 'failed'
    return
  }
  try {
    preview.value = await api.post('/v1/chat/link/preview', { body: { code: code.value } })
    state.value = 'ready'
  } catch (e) {
    error.value = errorMessage(e, t)
    state.value = 'failed'
  }
})

async function confirm() {
  state.value = 'linking'
  try {
    pending.value = await api.post('/v1/chat/link', { body: { code: code.value } })
    state.value = 'pending'
  } catch (e) {
    error.value = errorMessage(e, t)
    state.value = 'failed'
  }
}

const platform = computed(() => (preview.value ? t(`chatBots.kind.${preview.value.kind}`) : ''))
const bot = computed(() => (pending.value?.botUsername ? `@${pending.value.botUsername}` : (pending.value?.integrationName ?? '')))
</script>

<template>
  <div class="mx-auto flex w-full max-w-md flex-col gap-4 py-10">
    <Card>
      <CardHeader>
        <h1 class="font-display text-xl font-bold tracking-tight">{{ t('chatBots.link.title') }}</h1>
        <CardDescription v-if="state === 'loading'">{{ t('chatBots.link.checking') }}</CardDescription>
        <CardDescription v-else-if="state === 'failed'" class="text-destructive">{{ error }}</CardDescription>
        <CardDescription v-else-if="state === 'pending'">
          {{ t('chatBots.link.done', { platform, bot }) }}
        </CardDescription>
        <CardDescription v-else-if="preview">
          {{
            t('chatBots.link.question', {
              account: preview.externalUserName ?? t('chatBots.link.unnamed'),
              platform,
              workspace: preview.workspaceName,
            })
          }}
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        <template v-if="(state === 'ready' || state === 'linking') && preview">
          <p class="text-xs text-muted-foreground">{{ t('chatBots.link.explain', { bot: preview.integrationName }) }}</p>
          <div class="flex flex-wrap gap-2">
            <Button :disabled="state === 'linking'" @click="confirm">
              {{ state === 'linking' ? t('chatBots.link.linking') : t('chatBots.link.confirm') }}
            </Button>
            <Button as-child variant="ghost"><RouterLink to="/documents">{{ t('common.cancel') }}</RouterLink></Button>
          </div>
        </template>
        <template v-else-if="state === 'pending' && pending">
          <p class="font-mono text-3xl font-semibold tracking-[0.3em] tabular-nums" data-testid="chat-link-proof">{{ pending.proof }}</p>
          <p class="text-xs text-destructive">{{ t('chatBots.link.warning') }}</p>
          <Button as-child variant="outline" class="self-start">
            <RouterLink to="/settings/profile">{{ t('chatBots.link.manage') }}</RouterLink>
          </Button>
        </template>
      </CardContent>
    </Card>
  </div>
</template>
