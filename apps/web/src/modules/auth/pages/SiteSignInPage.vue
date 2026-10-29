<script setup lang="ts">
/**
 * /site-sign-in?site=<id>&return=<url> (issue #77 phase 3, docs/features/44):
 * the app's half of a member signing in to a published site.
 *
 * A site lives on its own origin and never sees this app's session, so the
 * reader's "Sign in" link lands here. The router's auth guard has already
 * sent anyone signed out through /login and back; this page asks the API for
 * a one-time code and moves the browser to the site's own session route,
 * which spends it and sets the site's cookie there. Nothing here runs during
 * SSR: a code is minted only by a browser that is about to use it.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { api } from '@/shared/api/client'
import { ApiRequestError } from '@/shared/api/http'
import { Button } from '@/shared/ui/button'

const { t } = useI18n()
const route = useRoute()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const siteId = computed(() => (typeof route.query.site === 'string' ? route.query.site : ''))
const returnUrl = computed(() => (typeof route.query.return === 'string' ? route.query.return : ''))
/** Only an http(s) address is offered as a way back; the API checks it is the site's. */
const backHref = computed(() => (/^https?:\/\//i.test(returnUrl.value) ? returnUrl.value : null))

const failure = ref<'notMember' | 'badLink' | 'failed' | null>(null)

onMounted(async () => {
  if (!UUID.test(siteId.value) || !backHref.value) {
    failure.value = 'badLink'
    return
  }
  try {
    const res = await api.post('/v1/sites/{id}/sign-in', {
      path: { id: siteId.value },
      body: { returnUrl: returnUrl.value },
    })
    // replace: the back button should not land on a page that mints a code.
    window.location.replace(res.url)
  } catch (e) {
    const status = e instanceof ApiRequestError ? e.status : 0
    failure.value = status === 403 ? 'notMember' : status === 400 || status === 404 ? 'badLink' : 'failed'
  }
})
</script>

<template>
  <div class="mx-auto mt-24 max-w-md space-y-3 px-6 text-center">
    <template v-if="failure">
      <h1 class="text-xl font-semibold">{{ t('site.signIn.failedTitle') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t(`site.signIn.${failure}`) }}</p>
      <!-- Not after badLink: the address may be the very thing the API refused. -->
      <Button v-if="backHref && failure !== 'badLink'" class="mt-3" variant="outline" as-child>
        <a :href="backHref">{{ t('site.signIn.back') }}</a>
      </Button>
    </template>
    <p v-else class="text-sm text-muted-foreground" role="status">{{ t('site.signIn.title') }}</p>
  </div>
</template>
