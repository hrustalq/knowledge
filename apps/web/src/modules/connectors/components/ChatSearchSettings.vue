<script setup lang="ts">
/**
 * How long searchable groups' messages are kept (#339). CHAT_SEARCH_RETENTION_DAYS
 * is a **ceiling**: a workspace may shorten it, never lengthen it, so the row
 * shows what is asked for, the ceiling and what applies, as AnalyticsSettings
 * does — a silent clamp lies about the configuration.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type { ChatSearchSettings } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { PageState } from '@/shared/layout'

const props = defineProps<{ workspaceId: string }>()

const { t } = useI18n()
const queryClient = useQueryClient()

const options = apiQueryOptions('/v1/chat/search-settings', { query: { workspaceId: props.workspaceId } })
const query = useQuery(options)
const settings = computed(() => query.data.value as ChatSearchSettings | undefined)

const retention = ref('')
watch(
  settings,
  (s) => {
    if (s) retention.value = s.retentionDays.requested === null ? '' : String(s.retentionDays.requested)
  },
  { immediate: true },
)

const draft = computed<number | null>(() => (retention.value.trim() === '' ? null : Number(retention.value)))
const invalid = computed(() => draft.value !== null && (!Number.isInteger(draft.value) || draft.value < 1))
const dirty = computed(() => !!settings.value && draft.value !== settings.value.retentionDays.requested)
/** A value past the ceiling is saved as asked and applies clamped; say so before it is saved. */
const clamped = computed(() => !!settings.value && draft.value !== null && !invalid.value && draft.value > settings.value.retentionDays.ceiling)

const days = (n: number) => t('chatBots.bindings.listenDays', { days: n }, n)

const saving = ref(false)
async function save() {
  if (saving.value || invalid.value || !dirty.value) return
  saving.value = true
  try {
    const next = await api.patch('/v1/chat/search-settings', {
      body: { workspaceId: props.workspaceId, retentionDays: draft.value },
    })
    queryClient.setQueryData(options.queryKey, next)
    // Every binding table shows the applied period in its hint.
    void queryClient.invalidateQueries({ queryKey: ['/v1/chat/integrations/{id}/bindings'] })
    toast.success(t('chatBots.search.saved'))
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

  <form v-else-if="settings" class="space-y-5" @submit.prevent="save">
    <div>
      <h2 class="text-base font-semibold">{{ t('chatBots.search.title') }}</h2>
      <p class="kn-measure mt-0.5 text-sm text-muted-foreground">{{ t('chatBots.search.intro') }}</p>
    </div>
    <p
      v-if="!settings.available"
      class="rounded-md border kn-callout-warning px-3 py-2 text-sm"
    >
      {{ t('chatBots.search.unavailable') }}
    </p>

    <div class="grid gap-x-4 gap-y-1.5 rounded-md border px-4 py-3 sm:grid-cols-[1fr_12rem]">
      <div class="min-w-0">
        <label for="chat-search-retention" class="text-sm font-medium">{{ t('chatBots.search.retention') }}</label>
        <p class="kn-measure text-xs text-muted-foreground">{{ t('chatBots.search.retentionHint') }}</p>
        <p class="mt-1 text-xs">
          <span class="text-muted-foreground">{{ t('chatBots.search.applies') }}</span>
          {{ days(settings.retentionDays.applied) }}
        </p>
      </div>
      <div class="space-y-1">
        <Input
          id="chat-search-retention"
          v-model="retention"
          type="number"
          inputmode="numeric"
          min="1"
          step="1"
          class="h-9"
          :placeholder="String(settings.retentionDays.ceiling)"
          :aria-invalid="invalid || undefined"
          aria-describedby="chat-search-retention-ceiling"
        />
        <p id="chat-search-retention-ceiling" class="text-xs" :class="clamped ? 'text-destructive' : 'text-muted-foreground'">
          {{
            clamped
              ? t('chatBots.search.clamped', { n: settings.retentionDays.ceiling })
              : t('chatBots.search.ceiling', { value: days(settings.retentionDays.ceiling) })
          }}
        </p>
      </div>
    </div>

    <div class="flex justify-end">
      <Button type="submit" size="sm" :disabled="!dirty || invalid || saving">
        {{ saving ? t('common.loading') : t('common.save') }}
      </Button>
    </div>
  </form>
</template>
