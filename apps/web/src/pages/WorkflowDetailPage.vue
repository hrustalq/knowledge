<script setup lang="ts">
/**
 * One workflow, read (docs/features/17).
 *
 * The counterpart of `/projects/:id` against `/settings/projects/:id`: this is
 * where you find out what a chain does, and editing it is a thing you choose.
 * The canvas is a working surface — palette, drag targets, a dirty draft, an
 * unsaved-changes guard on the way out — and putting that behind a row click
 * meant every glance at a workflow opened an editor and armed a confirm dialog.
 *
 * So the shape is drawn, the chain is read out in sentences beneath it, and the
 * facts that decide whether to open the editor at all — is it available to run,
 * does it start on its own, what does it publish, does it still compile — are
 * on the page. `Edit` is one button away, and it is the only thing that loads
 * Vue Flow.
 *
 * The reading is not decoration: `WorkflowMap` is a canvas, so it says nothing
 * to a screen reader. `describeChain` is the same fact in text, and the wizard's
 * review step reads from it too — the promise made while designing is the
 * promise shown afterwards.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { CircleAlert, MoreHorizontal, Pencil, Play, Plus, Trash2, Workflow, Zap } from 'lucide-vue-next'
import type { WorkflowDefinitionInfo, WorkflowValidationIssue } from '@knowledge/contracts'
import { validateGraph } from '@knowledge/workflow'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { relativeTime } from '@/lib/api'
import { labelFor } from '@/lib/labels'
import { useAuthStore } from '@/stores/auth'
import { useWorkflowsStore } from '@/stores/workflows'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const store = useWorkflowsStore()

// `:id?` — absent on `/settings/workflows` itself, where the rail is showing
// but nothing has been picked yet.
const id = computed(() => (route.params.id ? String(route.params.id) : ''))
const selected = computed(() => id.value !== '')
const canManage = computed(() => auth.canAdminWorkspace)

const query = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/workflows/{id}', { path: { id: id.value } }),
    enabled: selected.value,
  })),
)
const workflow = computed(() => query.data.value as WorkflowDefinitionInfo | undefined)

onMounted(() => void store.ensureLoaded())

const issues = computed<WorkflowValidationIssue[]>(() =>
  workflow.value ? validateGraph(workflow.value.graph) : [],
)
const errors = computed(() => issues.value.filter((i) => i.severity === 'error'))
const reading = computed(() => (workflow.value ? describeChain(workflow.value.graph, t) : []))

/** Selecting a step in the map scrolls its sentence into view — the map has no
 *  words, and the reading is where they are. */
const focused = ref<string | null>(null)

const deleteWorkflow = useApiMutation('delete', '/v1/workflows/{id}', {
  invalidates: () => [['/v1/workflows']],
})
const confirmingDelete = ref(false)

async function remove() {
  try {
    await deleteWorkflow.mutateAsync({ path: { id: id.value } })
    await store.refresh()
    confirmingDelete.value = false
    toast.success(t('workflow.deleted'))
    void router.push('/settings/workflows')
  } catch (e) {
    // A 409 here means runs are still in flight, and the server's message says
    // so — surfacing it verbatim beats a generic failure.
    toast.error((e as Error).message)
  }
}
</script>

<template>
  <!-- Nothing picked: the pane teaches the model rather than showing an empty
       frame. The same job the project rail's hint does, with more to say — a
       workflow is the one thing here nobody arrives already knowing. -->
  <div v-if="!selected" class="flex min-h-0 flex-1 flex-col justify-center px-4 py-6 lg:px-8">
    <div class="mx-auto max-w-md space-y-5 text-center">
      <Workflow class="text-muted-foreground/40 mx-auto size-8" />
      <div>
        <h1 class="text-base font-semibold">{{ t('nav.workflows') }}</h1>
        <p class="text-muted-foreground mt-1.5 text-sm leading-relaxed">{{ t('workflow.settings.emptyBody') }}</p>
      </div>
      <p class="text-muted-foreground text-xs">{{ t('workflow.rosterHint') }}</p>
      <RouterLink v-if="canManage" to="/settings/workflows/new" class="inline-block">
        <Button size="sm">
          <Plus class="mr-1.5 size-4" />
          {{ t('workflow.settings.newWorkflow') }}
        </Button>
      </RouterLink>
    </div>
  </div>

  <div v-else class="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-8">
    <div v-if="query.isLoading.value" class="space-y-4">
      <Skeleton class="h-8 w-64" />
      <Skeleton class="h-64 w-full" />
    </div>

    <p v-else-if="!workflow" class="text-muted-foreground text-sm">{{ t('workflow.notFound') }}</p>

    <div v-else class="space-y-6">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h1 class="font-display flex min-w-0 items-center gap-2 text-2xl font-bold tracking-tight">
            <span
              class="size-2 shrink-0 rounded-full"
              :class="workflow.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'"
              :title="workflow.enabled ? t('workflow.settings.availableToRun') : t('workflow.settings.retired')"
            />
            <span class="min-w-0 truncate">{{ workflow.name }}</span>
          </h1>
          <p v-if="workflow.description" class="text-muted-foreground mt-1.5 max-w-2xl text-sm leading-relaxed">
            {{ workflow.description }}
          </p>
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
          <RouterLink v-if="workflow.enabled" to="/workflows">
            <Button variant="ghost" size="sm" class="text-muted-foreground">
              <Play class="mr-1.5 size-3.5" />
              {{ t('workflow.settings.runs') }}
            </Button>
          </RouterLink>
          <RouterLink v-if="canManage" :to="`/settings/workflows/${workflow.id}/edit`">
            <Button size="sm">
              <Pencil class="mr-1.5 size-3.5" />
              {{ t('workflow.settings.edit') }}
            </Button>
          </RouterLink>
          <Badge v-else variant="outline">{{ t('workflow.readOnlyAdmin') }}</Badge>
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
              <DropdownMenuItem as-child>
                <RouterLink :to="`/settings/workflows/${workflow.id}/edit`">
                  <Pencil class="size-3.5" />
                  {{ t('workflow.settings.edit') }}
                </RouterLink>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" @select="confirmingDelete = true">
                <Trash2 class="size-3.5" />
                {{ t('workflow.settings.deleteWorkflow') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <!-- A broken chain looks perfectly fine drawn, so the compiler's verdict
           goes above the picture rather than under it. -->
      <p
        v-if="errors.length"
        class="text-destructive bg-destructive/5 flex items-start gap-1.5 rounded-lg border px-3 py-2 text-xs"
      >
        <CircleAlert class="mt-px size-3.5 shrink-0" />
        <span class="min-w-0 flex-1">
          {{ t('count.problems', { n: errors.length }, errors.length) }} — {{ errors[0].message }}
        </span>
      </p>

      <!-- The shape, at a size worth reading. Interactive, but only as a query:
           hovering a step lights what it feeds, and nothing here can be moved. -->
      <div class="bg-muted/20 h-72 overflow-hidden rounded-xl border">
        <WorkflowMap
          :graph="workflow.graph"
          :selected-id="focused"
          :invalid="errors.map((i) => i.stepId).filter((s): s is string => !!s)"
          @select="(stepId) => (focused = stepId)"
        />
      </div>

      <!-- What the shape does, in the order it happens — and the only form of
           this a screen reader can hear. -->
      <section class="space-y-2">
        <h2 class="text-muted-foreground text-xs font-medium uppercase">{{ t('workflow.whatItDoes') }}</h2>
        <ol class="space-y-1.5">
          <li
            v-for="(line, i) in reading"
            :key="line.id"
            class="flex gap-2.5 rounded-md px-2 py-1.5 transition-colors"
            :class="focused === line.id ? 'bg-primary/5' : ''"
            @mouseenter="focused = line.id"
            @mouseleave="focused = null"
          >
            <span class="text-muted-foreground w-4 shrink-0 text-right text-xs tabular-nums">{{ i + 1 }}</span>
            <span class="min-w-0 flex-1 text-sm leading-snug">
              <span class="font-medium">{{ line.title }}</span>
              <span class="text-muted-foreground"> — {{ line.sentence }}</span>
            </span>
          </li>
        </ol>
      </section>

      <!-- When it runs. Both facts, always, rather than only the one that is
           on: "it does not start on its own" is the thing an operator is
           actually checking for. -->
      <section class="space-y-2">
        <h2 class="text-muted-foreground text-xs font-medium uppercase">{{ t('workflow.starts') }}</h2>
        <ul class="space-y-1.5 text-sm">
          <li v-if="workflow.trigger.manual" class="text-muted-foreground flex items-start gap-2">
            <Play class="mt-0.5 size-3.5 shrink-0" />
            <span>{{ t('workflow.settings.manualHint') }}</span>
          </li>
          <li v-if="workflow.trigger.autoStart" class="text-primary flex items-start gap-2">
            <Zap class="mt-0.5 size-3.5 shrink-0" />
            <span>{{ t('workflow.settings.autoHint') }}</span>
          </li>
          <li v-else class="text-muted-foreground flex items-start gap-2">
            <Zap class="mt-0.5 size-3.5 shrink-0 opacity-40" />
            <span>{{ t('workflow.doesNotAutoStart') }}</span>
          </li>
        </ul>
        <div v-if="workflow.trigger.categories.length" class="flex flex-wrap items-center gap-1.5 pt-1">
          <span class="text-muted-foreground text-xs">{{ t('workflow.settings.onlyFor') }}</span>
          <Badge v-for="c in workflow.trigger.categories" :key="c" variant="outline">
            {{ labelFor(t, 'category', c) }}
          </Badge>
        </div>
      </section>

      <p class="text-muted-foreground border-t pt-3 text-xs">
        {{ t('count.steps', { n: workflow.graph.steps.length }, workflow.graph.steps.length) }}
        · {{ t('workflow.version', { n: workflow.version }) }}
        · {{ t('workflow.updated', { when: relativeTime(workflow.updatedAt) }) }}
      </p>
    </div>

    <AlertDialog v-model:open="confirmingDelete">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('workflow.builder.deleteTitle', { name: workflow?.name ?? '' }) }}</AlertDialogTitle>
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
