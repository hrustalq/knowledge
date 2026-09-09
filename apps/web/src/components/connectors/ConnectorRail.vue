<script setup lang="ts">
// The page-side view of a connector link (docs/features/19).
//
// A reader looking at a page that came from Confluence should be able to see
// that, follow it back, and publish an edit without going to settings — the
// connection is a fact about this page, not only about the connector.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useQuery } from '@tanstack/vue-query'
import { ExternalLink, Plug, Upload } from 'lucide-vue-next'
import { connectorKindInfo } from '@knowledge/contracts'
import type { DocumentConnectorResponse } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/api'

const props = defineProps<{ documentId: string }>()

const { t } = useI18n()

const query = useQuery(
  computed(() => apiQueryOptions('/v1/documents/{id}/connectors', { path: { id: props.documentId } })),
)
const links = computed(() => (query.data.value as DocumentConnectorResponse | undefined)?.links ?? [])

const push = useApiMutation('post', '/v1/documents/{id}/push', {
  invalidates: () => [['/v1/documents/{id}/connectors'], ['/v1/connectors']],
})

async function publish() {
  try {
    await push.mutateAsync({ path: { id: props.documentId } })
    toast.success(t('connectors.syncStarted'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}
</script>

<template>
  <div v-if="links.length" class="space-y-3">
    <div v-for="entry in links" :key="entry.link.id" class="space-y-1.5">
      <div class="flex items-center gap-2 text-sm">
        <Plug class="text-muted-foreground size-3.5 shrink-0" />
        <span class="truncate">
          {{ t('connectors.linkedTo', { name: entry.connectorName }) }}
        </span>
        <span class="text-muted-foreground text-xs">
          {{ connectorKindInfo(entry.kind)?.label ?? entry.kind }}
        </span>
      </div>

      <p class="text-muted-foreground text-xs">
        <template v-if="entry.link.lastPulledAt">
          {{ t('connectors.lastPulled') }} {{ relativeTime(entry.link.lastPulledAt) }}
        </template>
        <template v-if="entry.link.lastPushedAt">
          · {{ t('connectors.lastPushed') }} {{ relativeTime(entry.link.lastPushedAt) }}
        </template>
      </p>

      <div class="flex flex-wrap items-center gap-1.5">
        <Button v-if="entry.link.externalUrl" size="sm" variant="outline" as-child>
          <a :href="entry.link.externalUrl" target="_blank" rel="noopener noreferrer">
            {{ t('common.open') }} <ExternalLink class="size-3" />
          </a>
        </Button>
        <Button v-if="entry.canPush" size="sm" variant="outline" :disabled="push.isPending.value" @click="publish">
          <Upload class="size-3.5" /> {{ t('connectors.pushNow') }}
        </Button>
      </div>
    </div>
  </div>

  <p v-else class="text-muted-foreground text-xs">{{ t('connectors.notLinked') }}</p>
</template>
