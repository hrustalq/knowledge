<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Play } from 'lucide-vue-next'
import type { DocumentWorkflowRunsResponse } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId, relativeTime } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useWorkflowsStore } from '@/stores/workflows'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { isBusyStatus, RUN_STATUS_CLASS, RUN_STATUS_ICON, RUN_STATUS_LABEL } from './workflow-ui'

const { t } = useI18n()

/**
 * The document page's workflow widget (docs/features/17).
 *
 * A dumb panel taking `:document-id`, like every other rail body, so the page
 * only has to add a row to `RAIL_WIDGETS`. It is where a chain actually starts
 * in practice: you are reading the entity, and the next level of detail is one
 * button away.
 */
const props = defineProps<{ documentId: string }>()

const auth = useAuthStore()
const store = useWorkflowsStore()
onMounted(() => void store.ensureLoaded())

const query = useQuery(
  computed(() => apiQueryOptions('/v1/documents/{id}/workflow-runs', { path: { id: props.documentId } })),
)
const data = computed(() => query.data.value as DocumentWorkflowRunsResponse | undefined)
const runs = computed(() => data.value?.runs ?? [])
const available = computed(() => data.value?.available ?? [])

const starting = ref<string | null>(null)
const startRun = useApiMutation('post', '/v1/workflows/runs', {
  invalidates: () => [['/v1/workflows/runs'], ['/v1/documents/{id}/workflow-runs']],
})

async function start(definitionId: string) {
  starting.value = definitionId
  try {
    await startRun.mutateAsync({
      body: { workspaceId: getWorkspaceId(), definitionId, rootDocumentId: props.documentId },
    })
    await query.refetch()
    toast.success('Run started')
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    starting.value = null
  }
}
</script>

<template>
  <div class="space-y-3">
    <div v-if="query.isLoading.value" class="space-y-2">
      <Skeleton v-for="i in 2" :key="i" class="h-10 w-full" />
    </div>

    <template v-else>
      <ul v-if="runs.length" class="space-y-1.5">
        <li v-for="run in runs" :key="run.id">
          <RouterLink
            :to="`/workflows/${run.id}`"
            class="hover:bg-muted/60 flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors"
          >
            <component
              :is="RUN_STATUS_ICON[run.status]"
              class="mt-0.5 size-3.5 shrink-0"
              :class="[RUN_STATUS_CLASS[run.status], isBusyStatus(run.status) ? 'animate-spin' : '']"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{{ run.definitionName }}</span>
              <span class="text-muted-foreground block text-[11px]">
                {{ t(RUN_STATUS_LABEL[run.status]) }} · {{ relativeTime(run.startedAt ?? run.createdAt) }}
                <template v-if="run.nodeStats.awaitingReview">
                  · {{ run.nodeStats.awaitingReview }} to review
                </template>
              </span>
            </span>
          </RouterLink>
        </li>
      </ul>

      <p v-else class="text-muted-foreground text-sm">
        No workflow has been run against this page.
      </p>

      <div v-if="auth.canEdit && available.length" class="space-y-1 border-t pt-2">
        <p class="text-muted-foreground text-xs font-medium">Start</p>
        <Button
          v-for="workflow in available"
          :key="workflow.id"
          variant="ghost"
          size="sm"
          class="h-8 w-full justify-start px-2 text-xs"
          :disabled="starting !== null"
          @click="start(workflow.id)"
        >
          <Play class="mr-1.5 size-3.5" />
          {{ starting === workflow.id ? 'Starting…' : workflow.name }}
        </Button>
      </div>

      <RouterLink
        v-else-if="auth.canEdit"
        to="/settings/workflows"
        class="text-primary block text-xs hover:underline"
      >
        Configure a workflow
      </RouterLink>
    </template>
  </div>
</template>
