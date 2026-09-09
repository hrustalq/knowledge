<script setup lang="ts">
// Document import (docs/features/16), replacing the legacy /upload page.
//
// The old page was a textarea you pasted markdown into — which meant the one
// route whose entire job is "get an existing document into the knowledge base"
// was also the only one that could not accept a document. This is the same job
// done properly: choose where it goes and what it is, let the worker parse it
// with the parser its format deserves, then read and correct the result in the
// same editor the page will be edited in afterwards.
//
// LAYOUT. The three steps share one frame — a fixed header carrying the title
// and the stepper, a body that flexes to fill whatever is left, and one action
// bar pinned to the bottom. Steps differ enormously in height (a drop zone, a
// progress ring, a full editor); without a fixed frame the page would resize
// under the reader at every transition and the primary action would wander
// down the page. One bar in one place, always.
//
// MOTION. The frame is fixed, so a step change is content advancing inside it
// rather than a page swap: content leaves quickly, arrives with deceleration.
// The one authored moment is the progress ring's handoff from the browser's
// upload to the worker's parse — see ParseProgress.
//
// The wizard holds an import id, not the work. The row on the server is the
// truth, so closing the tab mid-parse loses nothing and coming back rejoins it.
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { ArrowLeft, RotateCcw } from 'lucide-vue-next'
import type { DocumentCategory } from '@knowledge/contracts'
import { getWorkspaceId } from '@/lib/api'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/components/ui/button'
import DestinationFields from '@/components/import/DestinationFields.vue'
import FileDropZone from '@/components/import/FileDropZone.vue'
import ImportReview from '@/components/import/ImportReview.vue'
import ImportStepper from '@/components/import/ImportStepper.vue'
import ParseProgress from '@/components/import/ParseProgress.vue'
import { useImport } from '@/components/import/use-import'

const { t } = useI18n()

/** Mirrors IMPORT_MAX_BYTES; the server enforces the real one on both ends. */
const MAX_BYTES = 52_428_800

const router = useRouter()
const projects = useProjectsStore()
const documents = useDocumentsStore()

const file = ref<File | null>(null)
const projectId = ref(projects.activeId ?? '')
const category = ref<DocumentCategory>('other')
const parentId = ref('')

const title = ref('')
const markdown = ref('')

/** Set when the review step sends you back to correct only the filing. */
const editingDestination = ref(false)

/**
 * True until the resume check has answered. Rendering a step before then would
 * commit to "choose" and immediately swap to "review", which is both a visible
 * flash and — because it re-targets `mode="out-in"` mid-leave — a way to wedge
 * the transition with the outgoing step still on screen.
 */
const booting = ref(true)

const reviewRef = ref<InstanceType<typeof ImportReview> | null>(null)

const {
  job,
  content,
  error,
  phase,
  progress,
  stage,
  busy,
  begin,
  resume,
  submit,
  discard,
  reset,
  stop,
} = useImport()

/** What the body renders. `destination` is step 1 revisited from the review. */
const view = computed<'choose' | 'destination' | 'working' | 'review' | 'failed'>(() => {
  if (editingDestination.value) return 'destination'
  if (phase.value === 'failed') return 'failed'
  if (phase.value === 'working') return 'working'
  if (phase.value === 'review') return 'review'
  return 'choose'
})

const step = computed<0 | 1 | 2>(() =>
  view.value === 'review' || view.value === 'destination' ? 2 : view.value === 'choose' ? 0 : 1,
)

/**
 * Which way the wizard is going, so the step travels sideways rather than up.
 *
 * The stepper above the body already draws these three as a row, and the review
 * step can send you back to correct the filing — a step that always rose from
 * below said "something new" on the way back just as loudly as on the way
 * forward. Horizontal travel is the only kind that can tell those apart, and it
 * is the same push the shell uses for a route.
 */
const stepDir = ref<'push' | 'pop'>('push')
watch(step, (next, prev) => {
  stepDir.value = next >= prev ? 'push' : 'pop'
})

const canStart = computed(() => Boolean(file.value && projectId.value) && !busy.value)

onMounted(async () => {
  if (!projects.loaded) {
    await projects.fetchList()
    if (!projectId.value) projectId.value = projects.activeId ?? projects.items[0]?.projectId ?? ''
  }
  if (!documents.loaded) void documents.fetchList()

  // A parse left running by an earlier visit is picked up rather than orphaned.
  try {
    if (await resume()) {
      const resumed = job.value
      if (resumed) {
        projectId.value = resumed.projectId
        category.value = resumed.category
        parentId.value = resumed.parentId ?? ''
      }
    }
  } finally {
    booting.value = false
  }
})

onBeforeUnmount(() => stop())

// The parsed result seeds the review fields exactly once — after that they are
// the reviewer's, and a late poll must not overwrite what they have typed.
watch(content, (c) => {
  if (!c) return
  title.value = c.title ?? job.value?.sourceFilename.replace(/\.[^.]+$/, '') ?? ''
  markdown.value = c.markdown
})

async function start(): Promise<void> {
  if (!file.value || !projectId.value) return
  await begin(file.value, {
    workspaceId: getWorkspaceId(),
    projectId: projectId.value,
    category: category.value,
    ...(parentId.value ? { parentId: parentId.value } : {}),
  })
}

async function create(): Promise<void> {
  // The editor debounces its markdown, so flush it before reading — otherwise
  // the last thing typed is the one thing the page never gets.
  const body = reviewRef.value?.flush() ?? markdown.value
  const res = await submit({
    title: title.value,
    markdown: body,
    projectId: projectId.value,
    category: category.value,
    parentId: parentId.value || null,
  })
  if (!res) {
    toast.error(error.value ?? 'The page could not be created')
    return
  }
  toast.success(res.attachmentId ? 'Page created — the original file is attached' : 'Page created')
  void documents.fetchList()
  await router.push(`/documents/${res.documentId}`)
}

async function throwAway(): Promise<void> {
  await discard()
  file.value = null
  title.value = ''
  markdown.value = ''
  editingDestination.value = false
}

/** Failure recovery: keep the destination, drop the attempt, choose again. */
function tryAgain(): void {
  reset()
  file.value = null
  editingDestination.value = false
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Fixed frame, part one: what this is and how far along you are. -->
    <header class="flex shrink-0 flex-wrap items-center justify-between gap-x-8 gap-y-3 border-b px-4 py-4 lg:px-8">
      <h1 class="text-xl font-semibold tracking-tight">{{ t('import.title') }}</h1>
      <ImportStepper :current="step" />
    </header>

    <!-- The body owns whatever height is left. Padding and scrolling belong to
         each step: the review step is an editor shell that scrolls its own
         column, exactly as /documents/:id/edit does. -->
    <div class="min-h-0 flex-1 overflow-hidden" :data-step-dir="stepDir">
      <Transition name="kn-step" mode="out-in" :duration="{ enter: 260, leave: 120 }">
        <!-- Step 1. The file is the decision, so it takes the room; the
             destination is confirmation and sits beside it, narrow. -->
        <!-- Resume has not answered yet: hold the frame rather than guess. -->
        <section v-if="booting" key="booting" class="h-full" aria-hidden="true" />

        <section
          v-else-if="view === 'choose'"
          key="choose"
          class="flex h-full items-center overflow-y-auto px-4 py-6 lg:px-8"
          :aria-label="t('import.chooseFileAndDestination')"
        >
          <!-- One row, one height, so the target and the filing share a top
               edge. The row takes the height the viewport can spare, bounded at
               both ends: below 18rem the target stops being something you can
               throw a file at, and past 34rem a dashed rectangle stops reading
               as generous and starts reading as an empty room. A clamp says
               both without depending on how flex resolves a percentage height
               three ancestors up. -->
          <div class="flex w-full flex-col gap-6 lg:h-[clamp(18rem,calc(100vh-21rem),34rem)] lg:flex-row lg:gap-8">
            <div class="flex min-h-72 min-w-0 flex-1 flex-col gap-3">
              <FileDropZone v-model="file" :max-bytes="MAX_BYTES" :disabled="busy" class="flex-1" />
              <p class="text-sm text-muted-foreground">
                The file is parsed into a page you can edit, search and link — and the original stays
                attached to it.
              </p>
            </div>

            <!-- Rail at the width every other rail in the product uses. -->
            <div class="shrink-0 lg:w-96 xl:w-md">
              <h2 class="mb-4 text-sm font-medium text-muted-foreground">{{ t('import.whereItGoes') }}</h2>
              <DestinationFields
                v-model:project-id="projectId"
                v-model:category="category"
                v-model:parent-id="parentId"
                stacked
              />
            </div>
          </div>
        </section>

        <!-- Step 1 revisited from the review: only the filing is in question. -->
        <section v-else-if="view === 'destination'" key="destination" class="h-full overflow-y-auto px-4 py-6 lg:px-8" :aria-label="t('import.changeDestination')">
          <div class="mx-auto w-full max-w-lg">
            <h2 class="mb-4 font-medium">{{ t('import.whereThisPageGoes') }}</h2>
            <DestinationFields
              v-model:project-id="projectId"
              v-model:category="category"
              v-model:parent-id="parentId"
              stacked
            />
          </div>
        </section>

        <!-- Step 2: the wait, with the worker narrating it. -->
        <section v-else-if="view === 'working'" key="working" class="grid h-full place-items-center px-4 py-6 lg:px-8" :aria-label="t('import.parsing')">
          <ParseProgress :progress="progress" :stage="stage" :filename="job?.sourceFilename ?? ''" />
        </section>

        <!-- Step 3: read it, fix it, commit it. -->
        <section v-else-if="view === 'review' && job && content" key="review" class="flex h-full" :aria-label="t('import.reviewResult')">
          <ImportReview
            v-model:title="title"
            ref="reviewRef"
            v-model:markdown="markdown"
            :job="job"
            :meta="content.meta"
            :warnings="content.warnings"
            :project-id="projectId"
            :category="category"
            :parent-id="parentId"
            @back="editingDestination = true"
          />
        </section>

        <!-- Failure names what went wrong and offers the move that follows. -->
        <section v-else key="failed" class="grid h-full place-items-center px-4 py-6 lg:px-8" :aria-label="t('import.importFailed')">
          <div class="space-y-2 text-center">
            <h2 class="font-medium">{{ t('import.couldNotImport') }}</h2>
            <p class="text-sm text-muted-foreground">{{ error }}</p>
          </div>
        </section>
      </Transition>
    </div>

    <!-- Fixed frame, part two: one action bar, in one place, on every step. -->
    <footer class="shrink-0 border-t px-4 py-4 lg:px-8">
      <div class="flex items-center gap-3">
        <template v-if="view === 'choose'">
          <Button :disabled="!canStart" @click="start">{{ busy ? 'Starting…' : 'Import' }}</Button>
          <p v-if="file && !projectId" class="text-sm text-muted-foreground">
            Pick a project first — every page belongs to exactly one.
          </p>
          <p v-else-if="!file" class="text-sm text-muted-foreground">{{ t('import.chooseFileToContinue') }}</p>
        </template>

        <template v-else-if="view === 'destination'">
          <Button @click="editingDestination = false">{{ t('import.backToDocument') }}</Button>
        </template>

        <template v-else-if="view === 'working'">
          <Button variant="ghost" @click="throwAway">{{ t('import.cancelImport') }}</Button>
          <p class="text-sm text-muted-foreground">
            You can leave this page — the import keeps running.
          </p>
        </template>

        <template v-else-if="view === 'review'">
          <Button :disabled="busy || !title.trim()" @click="create">
            {{ busy ? 'Creating the page…' : 'Create page' }}
          </Button>
          <Button variant="ghost" :disabled="busy" @click="throwAway">{{ t('common.discard') }}</Button>
        </template>

        <template v-else>
          <Button variant="outline" @click="tryAgain">
            <RotateCcw class="size-4" aria-hidden="true" />
            Try another file
          </Button>
          <Button variant="ghost" @click="router.push('/create')">
            <ArrowLeft class="size-4" aria-hidden="true" />
            Write the page instead
          </Button>
        </template>
      </div>
    </footer>
  </div>
</template>

<style scoped>
/*
 * Step changes are content advancing inside a fixed frame, not a page swap:
 * the outgoing step leaves quickly and without ceremony, the incoming one
 * arrives with deceleration.
 *
 * The entrance is a keyframe animation rather than a `-enter-from` class that
 * parks the element at `opacity: 0`. Removing that class depends on Vue getting
 * an animation frame, and a tab that is backgrounded mid-transition does not
 * get one — which strands the step invisible with the frame around it still
 * showing. An animation plays from its own timeline and the element's resting
 * state is simply *visible*, so the worst case is a step that appears without
 * ceremony instead of one that never appears at all. `:duration` on the
 * Transition times the pair for the same reason: no waiting on a transitionend
 * that a re-target can swallow.
 */
.kn-step-enter-active {
  animation: kn-step-in-push 260ms cubic-bezier(0.16, 1, 0.3, 1);
}

.kn-step-leave-active {
  transition:
    opacity 120ms ease-in,
    transform 120ms ease-in;
}

[data-step-dir='push'] .kn-step-leave-to {
  opacity: 0;
  transform: translateX(-6px);
}

[data-step-dir='pop'] .kn-step-leave-to {
  opacity: 0;
  transform: translateX(6px);
}

[data-step-dir='push'] .kn-step-enter-active {
  animation-name: kn-step-in-push;
}

[data-step-dir='pop'] .kn-step-enter-active {
  animation-name: kn-step-in-pop;
}

@keyframes kn-step-in-push {
  from {
    opacity: 0;
    transform: translateX(28px);
  }
}

@keyframes kn-step-in-pop {
  from {
    opacity: 0;
    transform: translateX(-28px);
  }
}

/* Reduced motion keeps the fade — it is what tells you the step changed — and
   drops only the travel. */
@media (prefers-reduced-motion: reduce) {
  .kn-step-enter-active,
  [data-step-dir] .kn-step-enter-active {
    animation: kn-step-fade 160ms ease;
  }
  [data-step-dir] .kn-step-leave-to {
    transform: none;
  }
  @keyframes kn-step-fade {
    from {
      opacity: 0;
    }
  }
}
</style>
