<script setup lang="ts">
/**
 * The Releases tab (docs/features/46): the release notes pages a codebase
 * connector wrote — Unreleased, then one per tag, newest first — with how many
 * breaking changes each confirmed and how many the model only suspects.
 *
 * The two counts are kept apart on purpose, the way the pages keep them: a
 * suspicion is not a breaking change until a commit, a label or the code says
 * so. Tags past the backfill cap are listed as not generated rather than
 * hidden, so a short list never reads as a short history.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { CircleAlert } from 'lucide-vue-next'
import type { ListReleasesResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { Badge } from '@/shared/ui/badge'
import { PageState } from '@/shared/layout'
import { formatDate } from '@/shared/utils/format'

const props = defineProps<{ connectorId: string }>()
const { t } = useI18n()

const query = useQuery(
  computed(() => apiQueryOptions('/v1/connectors/{id}/releases', { path: { id: props.connectorId } })),
)
const data = computed(() => query.data.value as ListReleasesResponse | undefined)
</script>

<template>
  <PageState v-if="query.isPending.value" state="loading" />
  <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />
  <div v-else-if="data" class="space-y-3">
    <p v-if="data.error" class="text-muted-foreground flex gap-1.5 text-xs">
      <CircleAlert class="mt-0.5 size-3.5 shrink-0" /> {{ t('connectors.releases.error') }}
    </p>
    <PageState v-if="!data.releases.length" state="empty" :title="t('connectors.releases.empty')" />
    <ul v-else class="divide-y rounded-md border">
      <li
        v-for="release in data.releases"
        :key="release.tag ?? 'unreleased'"
        class="flex items-center justify-between gap-3 p-3 text-sm"
      >
        <div class="min-w-0">
          <RouterLink v-if="release.documentId" :to="`/documents/${release.documentId}`" class="font-medium hover:underline">
            {{ release.tag ?? t('connectors.releases.unreleased') }}
          </RouterLink>
          <span v-else class="text-muted-foreground">{{ release.tag }}</span>
          <span v-if="release.date" class="text-muted-foreground ml-2 text-xs">{{ formatDate(release.date) }}</span>
        </div>
        <div class="flex shrink-0 items-center gap-2 text-xs">
          <span v-if="!release.generated" class="text-muted-foreground">{{ t('connectors.releases.notGenerated') }}</span>
          <template v-else>
            <Badge v-if="release.breakingCount" variant="destructive">
              {{ t('connectors.releases.breaking', { count: release.breakingCount }) }}
            </Badge>
            <Badge v-if="release.suspectedCount" variant="outline" :title="t('connectors.releases.possiblyBreakingHint')">
              {{ t('connectors.releases.possiblyBreaking', { count: release.suspectedCount }) }}
            </Badge>
          </template>
        </div>
      </li>
    </ul>
  </div>
</template>
