<script setup lang="ts">
/**
 * Crawl limits for web sources that sync a tree (#674, phase 3). Each
 * WEB_SOURCE_CRAWL_* value is a **ceiling**: a workspace may lower it, never
 * raise it, so every row shows what is asked for, the ceiling and what
 * applies, as ChatSearchSettings does — a silent clamp lies about the configuration.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type { SourceCrawlLimits, SourceSettingsResponse } from '@knowledge/contracts'
import { api, apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { PageState } from '@/shared/layout'

const props = defineProps<{ workspaceId: string }>()

const { t } = useI18n()
const queryClient = useQueryClient()

const options = apiQueryOptions('/v1/sources/settings', { query: { workspaceId: props.workspaceId } })
const query = useQuery(options)
const settings = computed(() => query.data.value as SourceSettingsResponse | undefined)

const KEYS = ['maxPages', 'confirmFirst', 'confirmChange'] as const
type Key = (typeof KEYS)[number]
/** The page cap must read at least one page; a confirmation threshold of 0 means "always ask". */
const MIN: SourceCrawlLimits = { maxPages: 1, confirmFirst: 0, confirmChange: 0 }

const text = reactive<Record<Key, string>>({ maxPages: '', confirmFirst: '', confirmChange: '' })
watch(
  settings,
  (s) => {
    if (s) for (const k of KEYS) text[k] = s.requested[k] === null ? '' : String(s.requested[k])
  },
  { immediate: true },
)

const draft = computed(() => Object.fromEntries(KEYS.map((k) => [k, text[k].trim() === '' ? null : Number(text[k])])) as Record<Key, number | null>)
const invalid = (k: Key) => draft.value[k] !== null && (!Number.isInteger(draft.value[k]) || draft.value[k]! < MIN[k])
const anyInvalid = computed(() => KEYS.some(invalid))
const dirty = computed(() => !!settings.value && KEYS.some((k) => draft.value[k] !== settings.value!.requested[k]))
/** A value past the ceiling is saved as asked and applies clamped; say so before it is saved. */
const clamped = (k: Key) => !!settings.value && !invalid(k) && draft.value[k] !== null && draft.value[k]! > settings.value.ceiling[k]

const saving = ref(false)
async function save() {
  if (saving.value || anyInvalid.value || !dirty.value) return
  saving.value = true
  try {
    const next = await api.put('/v1/sources/settings', { body: { workspaceId: props.workspaceId, ...draft.value } })
    queryClient.setQueryData(options.queryKey, next)
    toast.success(t('sources.crawlSettings.saved'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <PageState v-if="query.isPending.value" state="loading" :rows="1" row-class="h-16" />
  <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />

  <form v-else-if="settings" class="space-y-4" @submit.prevent="save">
    <div>
      <h2 class="text-base font-semibold">{{ t('sources.crawlSettings.title') }}</h2>
      <p class="kn-measure mt-0.5 text-sm text-muted-foreground">{{ t('sources.crawlSettings.intro') }}</p>
    </div>

    <div class="divide-y rounded-md border">
      <div v-for="k in KEYS" :key="k" class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[1fr_10rem]">
        <div class="min-w-0">
          <label :for="`crawl-${k}`" class="text-sm font-medium">{{ t(`sources.crawlSettings.${k}.label`) }}</label>
          <p class="kn-measure text-xs text-muted-foreground">{{ t(`sources.crawlSettings.${k}.hint`) }}</p>
          <p class="mt-1 text-xs">
            <span class="text-muted-foreground">{{ t('sources.crawlSettings.applies') }}</span>
            {{ settings.effective[k] }}
          </p>
        </div>
        <div class="space-y-1">
          <Input
            :id="`crawl-${k}`"
            v-model="text[k]"
            type="number"
            inputmode="numeric"
            :min="MIN[k]"
            step="1"
            class="h-9"
            :placeholder="String(settings.ceiling[k])"
            :aria-invalid="invalid(k) || undefined"
            :aria-describedby="`crawl-${k}-ceiling`"
          />
          <p :id="`crawl-${k}-ceiling`" class="text-xs" :class="clamped(k) || invalid(k) ? 'text-destructive' : 'text-muted-foreground'">
            {{
              invalid(k)
                ? t('sources.crawlSettings.invalid', { min: MIN[k] })
                : clamped(k)
                  ? t('sources.crawlSettings.clamped', { n: settings.ceiling[k] })
                  : t('sources.crawlSettings.ceiling', { n: settings.ceiling[k] })
            }}
          </p>
        </div>
      </div>
    </div>

    <div class="flex justify-end">
      <Button type="submit" size="sm" :disabled="!dirty || anyInvalid || saving">
        {{ saving ? t('common.loading') : t('common.save') }}
      </Button>
    </div>
  </form>
</template>
