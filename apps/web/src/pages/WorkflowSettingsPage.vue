<script setup lang="ts">
/**
 * The workflow roster (docs/features/17), as the third rail of the settings
 * shell — the same shape `/settings/projects` has.
 *
 * This page has been three things. It was the editor: a roster column, a canvas
 * boxed into what was left of a settings column, and an inspector, all fighting
 * inside a shell that already had a navigation rail. Editing then moved to its
 * own full-viewport route, and what stayed here was a centred list of cards —
 * which fixed the canvas and broke everything around it: the list sat in the
 * middle of a page with a navigation rail to its left doing nothing, and
 * opening a workflow left the app entirely, trail and all.
 *
 * So the roster moved into a rail and the builder came back beside it. What
 * makes that work now — and did not before — is that the builder no longer
 * needs a column of its own for the palette or the inspector: the palette is a
 * strip above the canvas and the inspector a drawer, so the pane the canvas
 * gets here is the pane it had at full width, minus a rail it can now be
 * reached from.
 *
 * The rows are deliberately one line, like the project rail's. The card list
 * showed each chain drawn at thumbnail size, on the argument that a workflow's
 * shape is the fact that decides whether to open it; that argument survives its
 * thumbnail, because the shape is now one click away at full size instead of
 * 56px tall in a list you have to scroll.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { CircleAlert, Plus } from 'lucide-vue-next'
import type { ListWorkflowsResponse, WorkflowDefinitionInfo } from '@knowledge/contracts'
import { validateGraph } from '@knowledge/workflow'
import { apiQueryOptions } from '@/api/queries'
import { getProjectId, getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useWorkflowsStore } from '@/stores/workflows'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

const { t } = useI18n()
const auth = useAuthStore()
const store = useWorkflowsStore()
const route = useRoute()

/** Row height must match the markup below — the rail is sized in these. */
const ROW_HEIGHT = 36

const workspaceId = getWorkspaceId()
const canManage = computed(() => auth.canAdminWorkspace)

const query = useQuery(
  computed(() =>
    apiQueryOptions('/v1/workflows', {
      query: { workspaceId, ...(getProjectId() ? { projectId: getProjectId()! } : {}) },
    }),
  ),
)
const workflows = computed<WorkflowDefinitionInfo[]>(
  () => (query.data.value as ListWorkflowsResponse | undefined)?.workflows ?? [],
)

onMounted(() => void store.ensureLoaded())

/**
 * A filter, not a search box, and only once the list outgrows the rail.
 *
 * The endpoint returns every definition in one response — there is no cursor to
 * page and nothing to ask the server — so this is a `filter()` over what is
 * already here. Below the threshold a search box over four rows is furniture:
 * the answer is already on screen.
 */
const FILTER_THRESHOLD = 8
const filter = ref('')

const visible = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return workflows.value
  return workflows.value.filter((w) => w.name.toLowerCase().includes(q))
})

/**
 * Errors are worth carrying into the rail: a broken chain looks perfectly fine
 * in a list, and the row is the only place you see one you are not editing.
 */
function problems(workflow: WorkflowDefinitionInfo): number {
  return validateGraph(workflow.graph).filter((i) => i.severity === 'error').length
}
</script>

<template>
  <!-- Bleed out of the settings column's padding so this rail sits flush too -->
  <div class="-mx-4 -my-6 flex min-h-0 flex-1 flex-col lg:-mx-8 lg:flex-row">
    <div
      class="flex h-72 shrink-0 flex-col border-b bg-background lg:sticky lg:top-0 lg:h-[calc(100vh-5.75rem)] lg:w-64 lg:self-start lg:border-b-0 lg:border-r"
    >
      <div class="flex items-center gap-2 border-b px-3 py-2">
        <p class="text-muted-foreground min-w-0 flex-1 truncate text-xs font-medium uppercase">
          {{ t('nav.workflows') }}
        </p>
        <span class="text-muted-foreground shrink-0 text-xs">{{ workflows.length }}</span>
      </div>

      <div v-if="workflows.length > FILTER_THRESHOLD" class="border-b p-2">
        <Input
          v-model="filter"
          class="h-8"
          :aria-label="t('workflow.searchWorkflows')"
          :placeholder="t('workflow.searchWorkflows')"
        />
      </div>

      <div v-if="query.isPending.value" class="space-y-1.5 p-2">
        <Skeleton v-for="i in 4" :key="i" class="h-8 w-full" />
      </div>
      <p v-else-if="workflows.length === 0" class="text-muted-foreground p-3 text-xs">
        {{ t('workflow.noWorkflows') }}
      </p>
      <p v-else-if="visible.length === 0" class="text-muted-foreground p-3 text-xs">
        {{ t('workflow.noneMatch') }}
      </p>
      <div v-else class="min-h-0 flex-1 overflow-y-auto">
        <ul>
          <li v-for="w in visible" :key="w.id">
            <RouterLink
              :to="`/settings/workflows/${w.id}`"
              class="flex items-center gap-2 px-3 text-sm transition-colors"
              :style="{ height: `${ROW_HEIGHT}px` }"
              :class="route.params.id === w.id
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-foreground/80 hover:bg-accent hover:text-foreground'"
            >
              <span
                class="size-1.5 shrink-0 rounded-full"
                :class="w.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/30'"
                :title="w.enabled ? t('workflow.settings.availableToRun') : t('workflow.settings.retired')"
              />
              <span class="min-w-0 flex-1 truncate">{{ w.name }}</span>
              <CircleAlert
                v-if="problems(w)"
                class="text-destructive size-3.5 shrink-0"
                :aria-label="t('count.problems', { n: problems(w) }, problems(w))"
              />
              <span v-else class="text-muted-foreground shrink-0 text-xs">{{ w.graph.steps.length }}</span>
            </RouterLink>
          </li>
        </ul>
      </div>

      <!-- Create sits at the foot of the rail, below its own divider. -->
      <div v-if="canManage" class="mt-auto shrink-0 border-t p-2">
        <RouterLink to="/settings/workflows/new">
          <Button variant="outline" size="sm" class="w-full justify-start gap-2">
            <Plus class="size-4" />
            {{ t('workflow.settings.newWorkflow') }}
          </Button>
        </RouterLink>
      </div>
    </div>

    <!-- Pane 3: picking another workflow replaces only this column; the roster
         it was picked from stays put. No padding, unlike the project rail's
         pane — its one child is a canvas, and the states that are not a canvas
         carry their own. -->
    <div data-kn-pane="3" class="flex min-h-0 min-w-0 flex-1 flex-col">
      <RouterView />
    </div>
  </div>
</template>
