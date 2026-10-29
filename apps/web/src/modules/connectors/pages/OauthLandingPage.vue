<script setup lang="ts">
/**
 * /oauth/:provider (#564): where every GitHub and Figma round trip ends — a
 * finished authorisation, an App install, or a forged or expired state.
 *
 * The flow opened this tab from the page that started it, and that page is
 * already watching for the new connection (a long poll, focus as fallback).
 * So a success only has to say so and get out of the way: the tab closes
 * itself where the browser allows a script-opened tab to. A failure stays
 * open, because the person has to read it. Both offer the way back.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute } from 'vue-router'
import { CircleAlert, CircleCheck } from 'lucide-vue-next'
import { readOauthLanding } from '@/modules/connectors/model/oauth-landing'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader } from '@/shared/ui/card'

const { t } = useI18n()
const route = useRoute()

const landing = computed(() => readOauthLanding(route.params.provider, route.query.outcome, route.query.returnTo))
const title = computed(() =>
  landing.value.outcome === 'installed'
    ? t('connectors.landing.title.installed', { provider: landing.value.name })
    : landing.value.ok
      ? t('connectors.landing.title.connected', { provider: landing.value.name })
      : t('connectors.landing.title.failed'),
)
const body = computed(() => {
  const { provider, outcome, name } = landing.value
  if (outcome === 'connected' || outcome === 'installed') return t(`connectors.landing.body.${provider}.${outcome}`)
  return t(`connectors.landing.body.${outcome}`, { provider: name })
})

/** Set once the close was tried and the tab is still here: say it may be closed by hand. */
const stayed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

onMounted(() => {
  if (!landing.value.ok) return
  // A beat to read the outcome; a tab the browser will not close just stays.
  timer = setTimeout(() => {
    window.close()
    stayed.value = true
  }, 1200)
})
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="w-full max-w-[25rem]">
    <Card class="border-0 bg-transparent shadow-none sm:border sm:bg-card sm:shadow-sm">
      <CardHeader class="justify-items-center gap-3 text-center">
        <CircleCheck v-if="landing.ok" class="size-8 text-primary" aria-hidden="true" />
        <CircleAlert v-else class="size-8 text-destructive" aria-hidden="true" />
        <h1 data-slot="card-title" class="leading-snug font-semibold text-balance">{{ title }}</h1>
      </CardHeader>
      <CardContent class="space-y-4 text-center text-sm">
        <p class="text-pretty text-muted-foreground" role="status">{{ body }}</p>
        <p v-if="landing.ok" class="text-xs text-muted-foreground" aria-live="polite">
          {{ stayed ? t('connectors.landing.closeHint') : t('connectors.landing.closing') }}
        </p>
        <Button class="w-full" :variant="landing.ok ? 'outline' : 'default'" as-child>
          <RouterLink :to="landing.back">{{ t('connectors.landing.back') }}</RouterLink>
        </Button>
      </CardContent>
    </Card>
  </div>
</template>
