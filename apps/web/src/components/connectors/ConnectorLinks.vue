<script setup lang="ts">
// The Links tab (docs/features/19): the external item <-> page identity map.
// This is the table that makes a re-sync land on the same page instead of
// duplicating it, so it is worth being able to look at — and to break.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useQuery } from '@tanstack/vue-query'
import { ExternalLink, Link2Off, Unlink } from 'lucide-vue-next'
import type { ListConnectorLinksResponse, ListConnectorsResponse } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import AiEmptyState from '@/components/ai/AiEmptyState.vue'
import { getWorkspaceId, relativeTime } from '@/lib/api'

defineProps<{ canManage: boolean }>()

const { t } = useI18n()
const workspaceId = getWorkspaceId()

const connectorsQuery = useQuery(apiQueryOptions('/v1/connectors', { query: { workspaceId } }))
const connectors = computed(() => (connectorsQuery.data.value as ListConnectorsResponse | undefined)?.connectors ?? [])

const selected = ref('')
watch(connectors, (list) => {
  if (!selected.value && list.length) selected.value = list[0].id
}, { immediate: true })

const linksQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/connectors/{id}/links', { path: { id: selected.value } }),
    enabled: selected.value !== '',
  })),
)
const links = computed(() => (linksQuery.data.value as ListConnectorLinksResponse | undefined)?.links ?? [])

const unlink = useApiMutation('delete', '/v1/connectors/{id}/links/{linkId}', {
  invalidates: () => [['/v1/connectors']],
})

async function removeLink(linkId: string) {
  try {
    await unlink.mutateAsync({ path: { id: selected.value, linkId } })
    await linksQuery.refetch()
    toast.success(t('connectors.unlinked'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <Select v-model="selected">
        <SelectTrigger class="w-64"><SelectValue :placeholder="t('connectors.pickConnector')" /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="c in connectors" :key="c.id" :value="c.id">{{ c.name }}</SelectItem>
        </SelectContent>
      </Select>
      <p class="text-muted-foreground text-sm">
        {{ t('connectors.linkCount', { count: links.length }, links.length) }}
      </p>
    </div>

    <div v-if="linksQuery.isPending.value && selected" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-10 w-full" />
    </div>

    <AiEmptyState
      v-else-if="!links.length"
      :icon="Link2Off"
      :title="t('connectors.noLinksTitle')"
      :body="t('connectors.noLinksBody')"
    />

    <div v-else class="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('connectors.page') }}</TableHead>
            <TableHead>{{ t('connectors.externalItem') }}</TableHead>
            <TableHead>{{ t('connectors.lastPulled') }}</TableHead>
            <TableHead>{{ t('connectors.lastPushed') }}</TableHead>
            <TableHead class="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="link in links" :key="link.id">
            <TableCell>
              <RouterLink :to="`/documents/${link.documentId}`" class="hover:underline">
                {{ link.documentTitle ?? link.externalTitle ?? link.externalId }}
              </RouterLink>
            </TableCell>
            <TableCell>
              <a
                v-if="link.externalUrl"
                :href="link.externalUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 hover:underline"
              >
                {{ link.externalTitle ?? link.externalId }}
                <ExternalLink class="size-3" />
              </a>
              <span v-else class="font-mono text-xs">{{ link.externalId }}</span>
            </TableCell>
            <TableCell class="text-muted-foreground text-xs">
              {{ link.lastPulledAt ? relativeTime(link.lastPulledAt) : '—' }}
            </TableCell>
            <TableCell class="text-muted-foreground text-xs">
              {{ link.lastPushedAt ? relativeTime(link.lastPushedAt) : '—' }}
            </TableCell>
            <TableCell>
              <Button
                v-if="canManage"
                size="sm"
                variant="ghost"
                :title="t('connectors.unlink')"
                @click="removeLink(link.id)"
              >
                <Unlink class="size-3.5" />
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  </div>
</template>
