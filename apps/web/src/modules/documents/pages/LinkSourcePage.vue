<script setup lang="ts">
/**
 * "Add page → Link a source" (#674): a page whose body belongs to a URL.
 *
 * The first version is read in the request, so this form either opens the new
 * page or says, under the URL, why the source could not be read. The token
 * field appears only once the host has refused without one — most sources are
 * public, and a credential box nobody needs reads as a requirement.
 *
 * "Also sync every page under it" (phase 3) makes this page the root of a
 * crawled tree: the page opens at once and the crawl fills in beneath it.
 */
import { computed, nextTick, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Globe, KeyRound } from 'lucide-vue-next'
import { SOURCE_DEFAULT_INTERVAL_MIN } from '@knowledge/contracts'
import { getProjectId, getWorkspaceId } from '@/shared/api/api'
import { api, isApiRequestError } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { PageLayout } from '@/shared/layout'
import { SOURCE_INTERVAL_OPTIONS, intervalValue, toInterval } from '../model/source-intervals'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const url = ref('')
const title = ref('')
const interval = ref(intervalValue(SOURCE_DEFAULT_INTERVAL_MIN))
const credential = ref('')
const crawl = ref(false)
const needsCredential = ref(false)
const error = ref<string | null>(null)
const reading = ref(false)
const credentialInput = ref<InstanceType<typeof Input> | null>(null)

const canSubmit = computed(() => url.value.trim() !== '' && !reading.value && (!needsCredential.value || credential.value.trim() !== ''))

async function submit() {
  if (!canSubmit.value) return
  reading.value = true
  error.value = null
  try {
    const res = await api.post('/v1/sources', {
      body: {
        workspaceId: getWorkspaceId(),
        projectId: getProjectId() ?? '',
        ...(typeof route.query.parent === 'string' ? { parentId: route.query.parent } : {}),
        url: url.value.trim(),
        ...(title.value.trim() ? { title: title.value.trim() } : {}),
        intervalMinutes: toInterval(interval.value),
        ...(credential.value.trim() ? { credential: credential.value.trim() } : {}),
        ...(crawl.value ? { crawl: true } : {}),
      },
    })
    await router.push(`/documents/${res.documentId}`)
  } catch (e) {
    error.value = errorMessage(e, t)
    if (isApiRequestError(e) && e.details?.needsCredential === true && !needsCredential.value) {
      needsCredential.value = true
      await nextTick()
      ;(credentialInput.value?.$el as HTMLInputElement | undefined)?.focus()
    }
  } finally {
    reading.value = false
  }
}
</script>

<template>
  <PageLayout variant="prose" :title="t('sources.link.heading')">
    <p class="kn-measure -mt-2 mb-6 text-sm text-muted-foreground">{{ t('sources.link.lede') }}</p>

    <form class="max-w-xl space-y-5" novalidate @submit.prevent="submit">
      <div class="space-y-1.5">
        <Label for="source-url">{{ t('sources.link.url') }}</Label>
        <div class="relative">
          <Globe class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            id="source-url"
            v-model="url"
            type="url"
            inputmode="url"
            autocomplete="url"
            spellcheck="false"
            autofocus
            required
            class="pl-9 font-mono text-sm"
            :placeholder="t('sources.link.urlPlaceholder')"
            :aria-invalid="error ? true : undefined"
            :aria-describedby="error ? 'source-error' : 'source-url-hint'"
          />
        </div>
        <p v-if="error" id="source-error" role="alert" class="text-xs [overflow-wrap:anywhere] text-destructive">{{ error }}</p>
        <p v-else id="source-url-hint" class="text-xs text-muted-foreground">{{ t('sources.link.urlHint') }}</p>
      </div>

      <label class="flex items-start gap-2.5">
        <Checkbox :model-value="crawl" class="mt-0.5" aria-describedby="source-crawl-hint" @update:model-value="crawl = $event === true" />
        <span class="min-w-0 text-sm">
          {{ t('sources.link.crawl') }}
          <span id="source-crawl-hint" class="kn-measure block text-xs text-muted-foreground">{{ t('sources.link.crawlHint') }}</span>
        </span>
      </label>

      <div v-if="needsCredential" class="space-y-1.5">
        <Label for="source-credential" class="flex items-center gap-1.5">
          <KeyRound class="size-3.5 text-muted-foreground" aria-hidden="true" /> {{ t('sources.link.credential') }}
        </Label>
        <Input
          id="source-credential"
          ref="credentialInput"
          v-model="credential"
          type="password"
          autocomplete="off"
          spellcheck="false"
          class="font-mono text-sm"
          :placeholder="t('sources.link.credentialPlaceholder')"
          aria-describedby="source-credential-hint"
        />
        <p id="source-credential-hint" class="text-xs text-muted-foreground">{{ t('sources.link.credentialHint') }}</p>
      </div>

      <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
        <div class="space-y-1.5">
          <Label for="source-title">{{ t('sources.link.title') }}</Label>
          <Input id="source-title" v-model="title" maxlength="200" :placeholder="t('sources.link.titlePlaceholder')" />
        </div>
        <div class="space-y-1.5">
          <Label for="source-interval">{{ t('sources.interval.label') }}</Label>
          <Select v-model="interval">
            <SelectTrigger id="source-interval" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="o in SOURCE_INTERVAL_OPTIONS" :key="o.value" :value="o.value">{{ t(o.label) }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <p class="kn-measure text-xs text-muted-foreground">{{ t('sources.link.readOnly') }}</p>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="ghost" @click="router.back()">{{ t('common.cancel') }}</Button>
        <Button type="submit" :disabled="!canSubmit" :aria-busy="reading">
          {{ reading ? t('sources.link.reading') : t('sources.link.submit') }}
        </Button>
      </div>
    </form>
  </PageLayout>
</template>
