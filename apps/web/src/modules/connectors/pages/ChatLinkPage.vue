<script setup lang="ts">
/**
 * /chat/link?code= (issue #71): where the link a chat bot sent lands.
 *
 * The bot proved which messenger account asked; this page proves which person
 * is answering — it requires sign-in (the router sends you through /login and
 * back), and nothing is linked until you press the button. The preview names
 * the account and the workspace first, because the person reading this should
 * be able to tell a link they asked for from one somebody forwarded them.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute } from 'vue-router'
import type { ChatLinkPreview } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '@/shared/ui/card'

const { t } = useI18n()
const route = useRoute()

const code = computed(() => (typeof route.query.code === 'string' ? route.query.code : ''))
const preview = ref<ChatLinkPreview | null>(null)
const error = ref<string | null>(null)
const state = ref<'loading' | 'ready' | 'linking' | 'linked' | 'failed'>('loading')

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
    await api.post('/v1/chat/link', { body: { code: code.value } })
    state.value = 'linked'
  } catch (e) {
    error.value = errorMessage(e, t)
    state.value = 'failed'
  }
}

const platform = computed(() => (preview.value ? t(`chatBots.kind.${preview.value.kind}`) : ''))
</script>

<template>
  <div class="mx-auto flex w-full max-w-md flex-col gap-4 py-10">
    <Card>
      <CardHeader>
        <h1 class="font-display text-xl font-bold tracking-tight">{{ t('chatBots.link.title') }}</h1>
        <CardDescription v-if="state === 'loading'">{{ t('chatBots.link.checking') }}</CardDescription>
        <CardDescription v-else-if="state === 'failed'" class="text-destructive">{{ error }}</CardDescription>
        <CardDescription v-else-if="state === 'linked'">
          {{ t('chatBots.link.done', { platform }) }}
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
        <template v-else-if="state === 'linked'">
          <Button as-child variant="outline" class="self-start">
            <RouterLink to="/settings/profile">{{ t('chatBots.link.manage') }}</RouterLink>
          </Button>
        </template>
      </CardContent>
    </Card>
  </div>
</template>
