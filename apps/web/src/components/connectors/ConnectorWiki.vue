<script setup lang="ts">
/**
 * The Wiki tab (docs/features/46): a codebase connector's repo wiki — which
 * pages it has, which are stale or waiting in a merge request, and how the
 * repository's `.knowledge/wiki.yml` steers it.
 *
 * Everything shown is derived server-side by the same `effectiveWikiConfig`
 * the sync runs on, so the effort line can say "asked high, applied medium"
 * rather than letting a server ceiling clamp silently. Regenerating is the
 * one write here, and it only queues a run: the pages change the way every
 * sync changes them, review rules included.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useQuery } from '@tanstack/vue-query'
import { CircleAlert, GitPullRequest, RefreshCw } from 'lucide-vue-next'
import type { RepoWikiInfo, RepoWikiSection, WikiSection } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageState } from '@/components/layout/page'
import { relativeTime } from '@/lib/api'
import { formatDateTime } from '@/lib/format'

const props = defineProps<{ connectorId: string; canEdit: boolean }>()
const { t } = useI18n()

const query = useQuery(
  computed(() => apiQueryOptions('/v1/connectors/{id}/wiki', { path: { id: props.connectorId } })),
)
const info = computed(() => query.data.value as RepoWikiInfo | undefined)

/** Pages grouped by section, in reading order; modules collapse into one group. */
const groups = computed(() => {
  const order: WikiSection[] = ['overview', 'architecture', 'data-flow', 'api', 'changelog', 'modules']
  const sections = info.value?.sections ?? []
  return order
    .map((section) => ({ section, pages: sections.filter((s) => s.section === section) }))
    .filter((g) => g.pages.length > 0)
})

const regenerate = useApiMutation('post', '/v1/connectors/{id}/wiki/regenerate', {
  invalidates: () => [['/v1/connectors/{id}/wiki'], ['/v1/connectors/{id}/runs']],
})

async function run(sections?: WikiSection[], force = false) {
  try {
    await regenerate.mutateAsync({
      path: { id: props.connectorId },
      body: { ...(sections ? { sections } : {}), ...(force ? { force } : {}) },
    })
    toast.success(t('connectors.wiki.regenerated'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

function pageTitle(page: RepoWikiSection): string {
  return page.title === page.key ? t(`connectors.wiki.section.${page.section}`) : page.title
}
</script>

<template>
  <PageState v-if="query.isPending.value" state="loading" />
  <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />
  <div v-else-if="info" class="space-y-6">
    <!-- Steering: where the configuration came from, and what it asked for vs what applies. -->
    <section class="rounded-md border p-4 text-sm">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="space-y-1">
          <p class="font-medium">{{ t('connectors.wiki.steering') }}</p>
          <p class="text-muted-foreground text-xs">
            {{ info.source === 'repo-file' ? t('connectors.wiki.sourceRepoFile') : t('connectors.wiki.sourceDefault') }}
          </p>
        </div>
        <div v-if="canEdit" class="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" :disabled="regenerate.isPending.value" @click="run()">
            <RefreshCw class="size-3.5" /> {{ t('connectors.wiki.regenerateAll') }}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            :disabled="regenerate.isPending.value"
            :title="t('connectors.wiki.forceHint')"
            @click="run(undefined, true)"
          >
            {{ t('connectors.wiki.force') }}
          </Button>
        </div>
      </div>

      <dl class="mt-3 grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        <div class="flex justify-between gap-3">
          <dt class="text-muted-foreground">{{ t('connectors.wiki.effort') }}</dt>
          <dd>
            <template v-if="info.effort.clamped">
              {{ t('connectors.wiki.effortClamped', {
                asked: t(`connectors.wiki.effortLevel.${info.effort.asked}`),
                applied: t(`connectors.wiki.effortLevel.${info.effort.applied}`),
              }) }}
            </template>
            <template v-else>{{ t(`connectors.wiki.effortLevel.${info.effort.applied}`) }}</template>
          </dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-muted-foreground">{{ t('connectors.wiki.delivery') }}</dt>
          <dd>{{ t(`connectors.wiki.deliveryMode.${info.delivery}`) }}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-muted-foreground">{{ t('connectors.wiki.onPush') }}</dt>
          <dd>{{ t(`connectors.wiki.autoRegenerate.${info.autoRegenerate}`) }}</dd>
        </div>
      </dl>

      <div v-if="info.configErrors.length" class="text-destructive mt-3 flex gap-1.5 text-xs">
        <CircleAlert class="mt-0.5 size-3.5 shrink-0" />
        <div>
          <p>{{ t('connectors.wiki.configInvalid') }}</p>
          <ul class="mt-1 list-disc pl-4">
            <li v-for="error in info.configErrors" :key="error"><code>{{ error }}</code></li>
          </ul>
        </div>
      </div>
      <p v-else-if="info.configUnreadable" class="text-muted-foreground mt-3 flex gap-1.5 text-xs">
        <CircleAlert class="mt-0.5 size-3.5 shrink-0" /> {{ t('connectors.wiki.configUnreadable') }}
      </p>
    </section>

    <PageState v-if="!groups.length" state="empty" :title="t('connectors.wiki.empty')" />

    <section v-for="group in groups" :key="group.section" class="space-y-2">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm font-medium">{{ t(`connectors.wiki.section.${group.section}`) }}</h3>
        <Button
          v-if="canEdit"
          size="sm"
          variant="ghost"
          :disabled="regenerate.isPending.value"
          @click="run([group.section])"
        >
          <RefreshCw class="size-3.5" /> {{ t('connectors.wiki.regenerate') }}
        </Button>
      </div>
      <ul class="divide-y rounded-md border">
        <li v-for="page in group.pages" :key="page.key" class="flex items-center justify-between gap-3 p-3 text-sm">
          <div class="min-w-0">
            <RouterLink v-if="page.documentId" :to="`/documents/${page.documentId}`" class="truncate hover:underline">
              {{ pageTitle(page) }}
            </RouterLink>
            <span v-else class="text-muted-foreground">{{ pageTitle(page) }} · {{ t('connectors.wiki.notYet') }}</span>
          </div>
          <div class="flex shrink-0 items-center gap-2 text-xs">
            <Badge v-if="page.stale" variant="outline" :title="t('connectors.wiki.staleHint')">
              {{ t('connectors.wiki.stale') }}
            </Badge>
            <RouterLink
              v-if="page.openMergeRequestId"
              :to="`/merge-requests/${page.openMergeRequestId}`"
              class="inline-flex items-center gap-1 hover:underline"
            >
              <GitPullRequest class="size-3.5" /> {{ t('connectors.wiki.openMr') }}
            </RouterLink>
            <span
              v-if="page.lastRegeneratedAt"
              class="text-muted-foreground"
              :title="formatDateTime(page.lastRegeneratedAt)"
            >
              {{ relativeTime(page.lastRegeneratedAt) }}
            </span>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
