<script setup lang="ts">
/**
 * The workflow roster (docs/features/17).
 *
 * This page used to be the editor: a roster column, a canvas boxed into what
 * was left of a settings column, and an inspector — three panes competing
 * inside a shell that already had a navigation rail of its own. Editing moved
 * to its own full-viewport route, and what stays here is the thing a settings
 * page is actually for: what exists, what each one does, and the two doors into
 * making another.
 *
 * Every row carries the chain drawn at thumbnail size. That is the collapsed
 * rail-widget rule applied to a workflow — show the one fact that decides
 * whether to open it — and for a workflow that fact is its shape: how many
 * steps, where it fans out, how deep it goes. A name and a step count cannot
 * distinguish two chains that behave completely differently.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { MessagesSquare, MoreHorizontal, Play, Plus, Settings2, Trash2, Workflow, Zap } from 'lucide-vue-next'
import type { ListWorkflowsResponse, WorkflowDefinitionInfo } from '@knowledge/contracts'
import { validateGraph } from '@knowledge/workflow'
import { toast } from 'vue-sonner'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getProjectId, getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useWorkflowsStore } from '@/stores/workflows'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import WorkflowMap from '@/components/workflows/WorkflowMap.vue'
import { describeChain } from '@/components/workflows/workflow-ui'

const { t } = useI18n()
const auth = useAuthStore()
const store = useWorkflowsStore()

const workspaceId = getWorkspaceId()
const canManage = computed(() => auth.canAdminWorkspace)

const query = useQuery(
  computed(() =>
    apiQueryOptions('/v1/workflows', {
      query: { workspaceId, ...(getProjectId() ? { projectId: getProjectId()! } : {}) },
    }),
  ),
)
const workflows = computed(() => (query.data.value as ListWorkflowsResponse | undefined)?.workflows ?? [])

onMounted(() => void store.ensureLoaded())

/**
 * Deleting lives on the row, not only inside the builder.
 *
 * Managing the *set* of workflows is what a roster is for, and looking for
 * delete anywhere else means opening the thing you want gone. The old page put
 * it in a footer bar under the editor; moving editing out took it with it.
 *
 * A dialog rather than `confirm()`: this is destructive, irreversible for
 * finished runs, and the sentence explaining that has to be readable — which a
 * native confirm cannot style and cannot translate consistently.
 */
const deleteWorkflow = useApiMutation('delete', '/v1/workflows/{id}', {
  invalidates: () => [['/v1/workflows']],
})
const deleting = ref<WorkflowDefinitionInfo | null>(null)
const confirmOpen = ref(false)

function askDelete(workflow: WorkflowDefinitionInfo) {
  deleting.value = workflow
  confirmOpen.value = true
}

async function remove() {
  const target = deleting.value
  if (!target) return
  try {
    await deleteWorkflow.mutateAsync({ path: { id: target.id } })
    await query.refetch()
    await store.refresh()
    confirmOpen.value = false
    deleting.value = null
    toast.success(t('workflow.deleted'))
  } catch (e) {
    // A 409 here means runs are still in flight, and the server's message says
    // so — surfacing it verbatim beats a generic failure.
    toast.error((e as Error).message)
  }
}

/** Errors are worth a badge on the row: a broken chain looks fine in a list. */
function problems(workflow: WorkflowDefinitionInfo): number {
  return validateGraph(workflow.graph).filter((i) => i.severity === 'error').length
}

/** The first two lines of the reading, so a row says what it does, not just how big it is. */
function summary(workflow: WorkflowDefinitionInfo): string {
  return describeChain(workflow.graph, t)
    .slice(0, 2)
    .map((line) => line.title)
    .join(' → ')
}
</script>

<template>
  <div class="flex min-h-0 w-full flex-1 flex-col gap-4">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold">{{ t('nav.workflows') }}</h1>
        <p class="text-muted-foreground mt-1 max-w-2xl text-sm">{{ t('workflow.settings.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <Badge v-if="!canManage" variant="outline">{{ t('workflow.readOnlyAdmin') }}</Badge>
        <RouterLink v-if="canManage" to="/settings/workflows/new">
          <Button size="sm">
            <Plus class="mr-1.5 size-4" />
            {{ t('workflow.settings.newWorkflow') }}
          </Button>
        </RouterLink>
      </div>
    </header>

    <div v-if="query.isLoading.value" class="space-y-3">
      <Skeleton v-for="i in 3" :key="i" class="h-28 w-full" />
    </div>

    <!-- Empty state teaches the model and offers both doors by name, rather
         than announcing an absence and leaving one generic button. -->
    <div
      v-else-if="workflows.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-5 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <Workflow class="text-muted-foreground/40 size-8" />
      <div class="max-w-md">
        <p class="text-sm font-medium">{{ t('workflow.noWorkflows') }}</p>
        <p class="text-muted-foreground mt-1.5 text-sm leading-relaxed">{{ t('workflow.settings.emptyBody') }}</p>
      </div>
      <div v-if="canManage" class="flex flex-wrap justify-center gap-2">
        <RouterLink to="/settings/workflows/new">
          <Button size="sm">
            <MessagesSquare class="mr-1.5 size-4" />
            {{ t('workflow.settings.createFirst') }}
          </Button>
        </RouterLink>
      </div>
    </div>

    <ul v-else class="space-y-3">
      <li v-for="workflow in workflows" :key="workflow.id">
        <article class="bg-card hover:border-primary/30 overflow-hidden rounded-xl border transition-colors">
          <div class="flex flex-col gap-4 p-4 sm:flex-row sm:items-start">
            <!-- The shape, drawn. Frozen and unlabelled at this size — a
                 thumbnail with eight truncated titles in it is a smudge. -->
            <RouterLink
              :to="`/settings/workflows/${workflow.id}/edit`"
              class="bg-muted/20 focus-visible:ring-ring block h-24 shrink-0 overflow-hidden rounded-lg border focus-visible:ring-2 focus-visible:outline-none sm:w-56"
              :aria-label="t('workflow.settings.openInBuilder', { name: workflow.name })"
            >
              <WorkflowMap :graph="workflow.graph" density="mini" :interactive="false" />
            </RouterLink>

            <div class="flex min-w-0 flex-1 flex-col">
              <!-- Availability as a dot beside the name, the way the tree and
                   the lists carry a lifecycle — not floating over by the
                   buttons, where it belongs to nothing. -->
              <p class="flex min-w-0 items-center gap-2">
                <span
                  class="size-1.5 shrink-0 rounded-full"
                  :class="workflow.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'"
                  :title="workflow.enabled ? t('workflow.settings.availableToRun') : t('workflow.settings.retired')"
                />
                <RouterLink
                  :to="`/settings/workflows/${workflow.id}/edit`"
                  class="min-w-0 truncate text-sm font-medium hover:underline"
                >
                  {{ workflow.name }}
                </RouterLink>
              </p>

              <p class="text-muted-foreground mt-1 line-clamp-2 text-[13px] leading-snug">
                {{ workflow.description || summary(workflow) }}
              </p>

              <div class="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                <span>{{ t('count.steps', { n: workflow.graph.steps.length }, workflow.graph.steps.length) }}</span>
                <template v-if="workflow.trigger.autoStart">
                  <span aria-hidden="true">·</span>
                  <span class="text-primary flex items-center gap-1">
                    <Zap class="size-3" /> {{ t('workflow.startsOnItsOwn') }}
                  </span>
                </template>
                <template v-if="problems(workflow)">
                  <span aria-hidden="true">·</span>
                  <span class="text-destructive">
                    {{ t('count.problems', { n: problems(workflow) }, problems(workflow)) }}
                  </span>
                </template>
              </div>
            </div>

            <div class="flex shrink-0 items-start gap-1.5">
              <RouterLink v-if="workflow.enabled" to="/workflows">
                <Button variant="ghost" size="sm" class="text-muted-foreground">
                  <Play class="mr-1.5 size-3.5" />
                  {{ t('workflow.settings.runs') }}
                </Button>
              </RouterLink>
              <RouterLink :to="`/settings/workflows/${workflow.id}/edit`">
                <Button variant="outline" size="sm">
                  <Settings2 class="mr-1.5 size-3.5" />
                  {{ t('workflow.settings.edit') }}
                </Button>
              </RouterLink>
              <DropdownMenu v-if="canManage">
                <DropdownMenuTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="text-muted-foreground shrink-0"
                    :aria-label="t('workflow.settings.actionsFor', { name: workflow.name })"
                  >
                    <MoreHorizontal class="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="w-44">
                  <DropdownMenuItem variant="destructive" @select="askDelete(workflow)">
                    <Trash2 class="size-3.5" />
                    {{ t('workflow.settings.deleteWorkflow') }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </article>
      </li>
    </ul>

    <AlertDialog v-model:open="confirmOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('workflow.builder.deleteTitle', { name: deleting?.name ?? '' }) }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t('workflow.builder.deleteBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
          <AlertDialogAction
            :class="buttonVariants({ variant: 'destructive' })"
            :disabled="deleteWorkflow.isPending.value"
            @click="remove"
          >
            {{ t('workflow.settings.deleteWorkflow') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
