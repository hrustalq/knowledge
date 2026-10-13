<script setup lang="ts">
/**
 * /settings/exports (docs/features/45): your exports, newest first — what is
 * still being made, what can be downloaded and until when, and why one failed.
 * An admin sees everyone's, with who asked.
 *
 * Polled while anything is in flight, the way the site settings page polls a
 * building version: an export takes seconds to minutes, and the row is the
 * truth. The notification that an export is ready links here.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { isActiveExportStatus, type ExportDownloadResponse, type ExportJobSummary, type ExportListResponse } from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageState } from '@/components/layout/page'
import UserChip from '@/components/people/UserChip.vue'

const { t } = useI18n()
const auth = useAuthStore()

const listQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/exports', { query: { workspaceId: getWorkspaceId() } }),
    refetchInterval: (q: { state: { data: unknown } }) =>
      (q.state.data as ExportListResponse | undefined)?.exports.some((e) => isActiveExportStatus(e.status)) ? 2000 : false,
  })),
)
const exports = computed(() => (listQuery.data.value as ExportListResponse | undefined)?.exports ?? [])

const statusVariant = (s: ExportJobSummary['status']) =>
  s === 'completed' ? 'default' : s === 'failed' ? 'destructive' : s === 'expired' ? 'secondary' : 'outline'

function subjectLink(e: ExportJobSummary): string | null {
  if (e.documentId) return `/documents/${e.documentId}`
  if (e.projectId) return `/projects/${e.projectId}`
  return null
}

async function download(e: ExportJobSummary) {
  try {
    const res = (await api.get('/v1/exports/{id}/download', { path: { id: e.id } })) as ExportDownloadResponse
    // A presigned URL that answers with Content-Disposition: attachment, so
    // the browser saves it and this page stays where it is.
    window.location.assign(res.url)
  } catch (err) {
    toast.error(errorMessage(err, t))
  }
}
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-6">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('export.page.title') }}</h1>
      <p class="text-muted-foreground mt-0.5 text-sm">
        {{ auth.canAdminWorkspace ? t('export.page.subtitleAdmin') : t('export.page.subtitle') }}
      </p>
    </div>

    <PageState v-if="listQuery.isPending.value" state="loading" :rows="3" row-class="h-12" />
    <PageState v-else-if="listQuery.isError.value" state="error" :error="listQuery.error.value" />
    <p v-else-if="!exports.length" class="text-muted-foreground text-sm">{{ t('export.page.empty') }}</p>

    <div v-else class="overflow-x-auto rounded-md border">
      <table class="w-full text-sm">
        <thead class="bg-muted/40 text-muted-foreground text-left text-xs">
          <tr>
            <th class="px-3 py-2 font-medium">{{ t('export.page.colWhat') }}</th>
            <th class="px-3 py-2 font-medium">{{ t('export.page.colFormat') }}</th>
            <th class="px-3 py-2 font-medium">{{ t('export.page.colStatus') }}</th>
            <th v-if="auth.canAdminWorkspace" class="px-3 py-2 font-medium">{{ t('export.page.colBy') }}</th>
            <th class="px-3 py-2 font-medium">{{ t('export.page.colCreated') }}</th>
            <th class="px-3 py-2" />
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="e in exports" :key="e.id" class="align-top">
            <td class="px-3 py-2">
              <RouterLink v-if="subjectLink(e)" :to="subjectLink(e)!" class="hover:underline">{{ e.title }}</RouterLink>
              <span v-else>{{ e.title }}</span>
              <span class="text-muted-foreground ml-2 text-xs">
                {{ t(`export.scope.${e.scope}`) }}<template v-if="e.branch"> · {{ e.branch }}</template>
              </span>
              <p v-if="e.error" class="text-destructive mt-0.5 text-xs">
                {{ t(`export.error.${e.error.code}`) }}<template v-if="e.error.message"> — {{ e.error.message }}</template>
              </p>
            </td>
            <td class="px-3 py-2">{{ t(`export.format.${e.format}`) }}</td>
            <td class="px-3 py-2">
              <Badge :variant="statusVariant(e.status)">{{ t(`export.status.${e.status}`) }}</Badge>
              <p v-if="e.stage" class="text-muted-foreground mt-0.5 text-xs">{{ t(`export.stage.${e.stage}`) }}</p>
              <p v-else-if="e.status === 'completed'" class="text-muted-foreground mt-0.5 text-xs">
                {{ t('export.page.summary', { pages: e.pageCount ?? 0, size: formatBytes(e.sizeBytes ?? 0) }) }}
              </p>
            </td>
            <td v-if="auth.canAdminWorkspace" class="px-3 py-2"><UserChip :user-id="e.requestedBy" size="sm" /></td>
            <td class="text-muted-foreground px-3 py-2" :title="formatDateTime(e.createdAt)">{{ formatRelative(e.createdAt) }}</td>
            <td class="px-3 py-2 text-right">
              <Button v-if="e.status === 'completed'" size="sm" variant="outline" class="h-7" @click="download(e)">
                {{ t('export.download') }}
              </Button>
              <p v-if="e.status === 'completed' && e.expiresAt" class="text-muted-foreground mt-0.5 text-xs">
                {{ t('export.page.expires', { when: formatRelative(e.expiresAt) }) }}
              </p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
