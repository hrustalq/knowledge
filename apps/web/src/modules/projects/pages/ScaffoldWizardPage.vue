<script setup lang="ts">
/**
 * Creating a project (#716): pick a shape, adjust it, create it.
 *
 * The workflow wizard's frame — a fixed header with the stepper, a body that
 * flexes, one action bar — over `scaffoldMachine`. Nothing is written until
 * Create, which sends the edited blueprint inline to `POST /v1/projects/scaffold`:
 * the project, its conventions and every page in one transaction. The pages
 * are published skeletons that stay out of search until someone writes them.
 *
 * Every step is a history entry (`?step=`), so the browser's Back and Forward
 * walk the wizard. From a wide screen up, Start, Shape and Create share one
 * spine: a 24rem rail on the left, the thing it describes filling the rest.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Component } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { createActor, type Actor } from 'xstate'
import { AnimatePresence, MotionConfig, motion } from 'motion-v'
import { toast } from 'vue-sonner'
import { ArrowLeft, ArrowRight, BookmarkPlus, Check, ChevronRight, FilePlus, FolderTree, ListTree, Loader2, Lock, MessagesSquare, Sparkles } from 'lucide-vue-next'
import {
  BLUEPRINT_MAX_DEPTH,
  BLUEPRINT_MAX_PAGES,
  blueprintText,
  SUPPORTED_LOCALES,
  type Blueprint,
  type BlueprintEntry,
  type BlueprintNode,
  type Locale,
} from '@knowledge/contracts'
import { api, isApiRequestError } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useFeaturesStore } from '@/stores/features'
import { useTemplatesStore } from '@/entities/template'
import { Button } from '@knowledge/ui/button'
import { Input } from '@knowledge/ui/input'
import { Checkbox } from '@knowledge/ui/checkbox'
import { Skeleton } from '@knowledge/ui/skeleton'
import BlueprintOutline from '@/modules/projects/components/BlueprintOutline.vue'
import BlueprintNodeEditor from '@/modules/projects/components/BlueprintNodeEditor.vue'
import BlueprintConventions from '@/modules/projects/components/BlueprintConventions.vue'
import ProjectBlueprintPicker from '@/modules/projects/components/ProjectBlueprintPicker.vue'
import BlueprintDescribePanel from '@/modules/projects/components/BlueprintDescribePanel.vue'
import BlueprintSectionMap from '@/modules/projects/components/BlueprintSectionMap.vue'
import BlueprintTreePreview from '@/modules/projects/components/BlueprintTreePreview.vue'
import SaveBlueprintDialog from '@/modules/projects/components/SaveBlueprintDialog.vue'
import ProjectAvatar from '@/modules/projects/components/ProjectAvatar.vue'
import { EMOJI_CHOICES } from '@/modules/projects/model/avatar'
import { cloneJson, countPages, hasUntitled, insertNode, nodeAt, treeDepth, typedText, updateNode, type NodePath } from '@/modules/projects/model/blueprint-tree'
import {
  clearSnapshot,
  emptyContext,
  loadSnapshot,
  saveSnapshot,
  scaffoldMachine,
  SCAFFOLD_STEPS,
  type ScaffoldContext,
  type ScaffoldEvent,
  type ScaffoldOrigin,
  type ScaffoldStep,
} from '@/modules/projects/model/scaffold-machine'

const { t, locale: uiLocale } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()
const templatesStore = useTemplatesStore()
const features = useFeaturesStore()

/* ------------------------------------------------------------------ machine */

const actor = shallowRef<Actor<typeof scaffoldMachine> | null>(null)
const step = ref<ScaffoldStep>('start')
const context = ref<ScaffoldContext>(emptyContext())
const resumed = ref(false)
/** Start shows the cards, or the From a project / Describe it panel in their place. */
const startView = ref<'cards' | 'derive' | 'describe'>('cards')

function start(snapshot?: ReturnType<typeof loadSnapshot>) {
  const running = createActor(scaffoldMachine, snapshot ? { snapshot } : undefined)
  running.subscribe((snap) => {
    step.value = snap.value as ScaffoldStep
    context.value = snap.context
    saveSnapshot(running.getPersistedSnapshot())
  })
  running.start()
  return running
}

onMounted(() => {
  const snapshot = loadSnapshot()
  try {
    actor.value = start(snapshot)
  } catch {
    // A snapshot from an older shape of the machine: start over rather than strand the page.
    clearSnapshot()
    actor.value = start()
  }
  const entry = historyState()
  base = entry.knWizardBase ?? entry.position ?? 0
  exit = entry.knWizardExit ?? !!entry.back
  // A reload, or Forward into the wizard, names its step; a bare visit resumes where the draft was.
  if (route.query.step && urlPlace.value !== place.value) land(urlPlace.value)
  // Stamp this entry as the wizard's and put its URL right; later moves push from here.
  void toUrl(place.value, 'replace')
  resumed.value = step.value !== 'start'
  const seed = typeof route.query.name === 'string' ? route.query.name : ''
  if (!resumed.value && seed) send({ type: 'SET', patch: { name: seed } })
  void loadBlueprints()
  void templatesStore.ensureLoaded()
})
onBeforeUnmount(() => actor.value?.stop())
// The snapshot is for a reload; walking away inside the app is leaving.
onBeforeRouteLeave(() => clearSnapshot())

const send = (event: ScaffoldEvent) => actor.value?.send(event)
const stepIndex = computed(() => SCAFFOLD_STEPS.indexOf(step.value))

/* ------------------------------------------------------------------ history */

/**
 * Where the wizard is, as the URL spells it: a machine step, or one of Start's
 * two panels. A move the wizard makes (Continue, a pick, a panel) pushes an
 * entry; an entry the browser lands on (Back, Forward) is sent to the machine
 * as `GOTO`, and a step it refuses (Shape after Start over) rewrites the URL to
 * where the wizard really is. The footer's Back is the browser's Back whenever
 * a wizard entry sits behind this one, so the two never disagree.
 */
const PLACES = ['start', 'from-project', 'describe', 'shape', 'conventions', 'create'] as const
type Place = (typeof PLACES)[number]

const place = computed<Place>(() => {
  if (step.value !== 'start') return step.value
  return startView.value === 'derive' ? 'from-project' : startView.value === 'describe' ? 'describe' : 'start'
})
const urlPlace = computed<Place>(() => {
  const at = route.query.step
  return typeof at === 'string' && (PLACES as readonly string[]).includes(at) ? (at as Place) : 'start'
})

interface WizardEntry {
  position?: number
  back?: string | null
  /** The position of the wizard's first entry, carried by every entry after it (and across a reload). */
  knWizardBase?: number
  /** Whether a page sits behind that first entry for Cancel to return to. */
  knWizardExit?: boolean
}
const historyState = (): WizardEntry => (window.history.state ?? {}) as WizardEntry
let base = 0
let exit = false
/** The next place change replaces this entry instead of pushing one: a step back taken in place. */
let replaceNext = false

function toUrl(at: Place, how: 'push' | 'replace') {
  return router[how]({
    query: { ...route.query, blueprint: undefined, step: at === 'start' ? undefined : at },
    state: { knWizardBase: base, knWizardExit: exit },
  })
}

function land(at: Place) {
  const panel = at === 'from-project' ? 'derive' : at === 'describe' && features.isOn('assistant') ? 'describe' : 'cards'
  startView.value = panel
  send({ type: 'GOTO', step: at === 'from-project' || at === 'describe' ? 'start' : at })
}

watch(place, (at) => {
  if (at === urlPlace.value) return
  void toUrl(at, replaceNext ? 'replace' : 'push')
  replaceNext = false
})
watch(urlPlace, (at) => {
  if (!actor.value || at === place.value) return
  land(at)
  if (place.value !== at) void toUrl(place.value, 'replace')
})

/** One step back: the browser's, while the entry behind is the wizard's; else in place (a resumed draft). */
function stepBack() {
  if ((historyState().position ?? base) > base) return router.back()
  replaceNext = true
  if (step.value === 'start') startView.value = 'cards'
  else send({ type: 'BACK' })
}

const lang = computed<Locale>(() => context.value.locale ?? (SUPPORTED_LOCALES.includes(uiLocale.value as Locale) ? (uiLocale.value as Locale) : 'en'))

/* ------------------------------------------------------------------- motion */

/** The house curve (the workflow wizard's step-in), and one step's entrance and exit. */
const EASE = [0.32, 0.72, 0, 1] as const
const STEP_MOTION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
  transition: { duration: 0.22, ease: EASE },
}

/* -------------------------------------------------------------------- start */

const blueprints = ref<BlueprintEntry[] | null>(null)
const loadError = ref<string | null>(null)
async function loadBlueprints() {
  loadError.value = null
  try {
    blueprints.value = (await api.get('/v1/blueprints', { query: { workspaceId: getWorkspaceId() } })).blueprints
  } catch (e) {
    loadError.value = (e as Error).message
    return
  }
  // `?blueprint=<key>` (Use / Edit in wizard, from settings) opens on it — once, and not over a resumed draft.
  const wanted = route.query.blueprint
  const entry = !resumed.value && typeof wanted === 'string' && blueprints.value.find((e) => e.key === wanted)
  // Settled before the pick pushes Shape, so Back from Shape lands on a clean Start.
  if (typeof wanted === 'string') await toUrl(place.value, 'replace')
  if (entry && auth.canEdit) pick(entry)
}

interface StartCard {
  key: string
  icon: string | Component
  name: string
  meta: string
  description: string
  entry?: BlueprintEntry
}

const cards = computed<StartCard[]>(() => [
  ...(blueprints.value ?? []).map((entry) => {
    const { tree } = entry.blueprint
    const pages = countPages(tree)
    return {
      key: entry.key,
      icon: entry.blueprint.icon ?? FilePlus,
      name: blueprintText(entry.blueprint.name, lang.value),
      meta: tree.length ? t('scaffold.start.pages', { count: pages }, pages) : t('scaffold.start.noPages'),
      description: blueprintText(entry.blueprint.description, lang.value),
      entry,
    }
  }),
  {
    key: 'derive',
    icon: FolderTree,
    name: t('scaffold.start.derive'),
    meta: t('scaffold.start.deriveMeta'),
    description: t('scaffold.start.deriveBody'),
  },
  // The scaffolder drafts it: no assistant, no card (the route 404s too).
  ...(features.isOn('assistant')
    ? [
        {
          key: 'describe',
          icon: MessagesSquare,
          name: t('scaffold.start.describe'),
          meta: t('scaffold.start.describeMeta'),
          description: t('scaffold.start.describeBody'),
        },
      ]
    : []),
])

/** Blueprints with pages lead; Blank and the two panels are the other ways in. */
const startGroups = computed(() => {
  const laidOut = (card: StartCard) => !!card.entry?.blueprint.tree.length
  return [
    { key: 'blueprints', label: t('scaffold.start.blueprints'), cards: cards.value.filter(laidOut) },
    { key: 'other', label: t('scaffold.start.otherWays'), cards: cards.value.filter((c) => !laidOut(c)) },
  ].filter((group) => group.cards.length)
})

/**
 * From 64rem up, Start is master-detail: a click previews the blueprint beside
 * the list, and Use (or a double-click) takes it. Narrower there is no preview
 * pane, so a tap takes it at once, as it always did.
 */
const wide = useMediaQuery('(min-width: 64rem)')
const previewKey = ref<string | null>(null)
const previewCard = computed(() => {
  const entries = cards.value.filter((c) => c.entry)
  return entries.find((c) => c.key === previewKey.value) ?? entries.find((c) => c.entry!.blueprint.tree.length) ?? entries[0] ?? null
})
const previewFacts = computed(() => {
  const bp = previewCard.value?.entry?.blueprint
  return bp ? conventionFacts(countPages(bp.tree), bp.conventions) : []
})

function choose(card: StartCard) {
  if (card.entry && wide.value) previewKey.value = card.key
  else if (card.entry) pick(card.entry)
  else if (card.key === 'derive' || card.key === 'describe') startView.value = card.key
}

function pick(entry: BlueprintEntry) {
  send({
    type: 'PICK',
    blueprint: cloneJson(entry.blueprint),
    origin: { kind: 'blueprint', key: entry.key, builtIn: entry.builtIn, id: entry.id },
  })
}

function picked(next: Blueprint, from: ScaffoldOrigin) {
  send({ type: 'PICK', blueprint: cloneJson(next), origin: from })
}

const origin = computed(() => context.value.origin ?? null)
const derivedFrom = computed(() => (origin.value?.kind === 'project' ? origin.value : null))
const describedAs = computed(() => (origin.value?.kind === 'described' ? origin.value : null))

/* ---------------------------------------------------------- save as blueprint */

const saveOpen = ref(false)
function onSaved(entry: BlueprintEntry) {
  // Saving again now updates that row — unless the outline came from a project
  // or a description, whose provenance (and offered terms) the later steps still need.
  if (origin.value?.kind === 'blueprint' || !origin.value) {
    send({ type: 'SET', patch: { origin: { kind: 'blueprint', key: entry.key, builtIn: entry.builtIn, id: entry.id } } })
  }
  void loadBlueprints()
}

/* -------------------------------------------------------------------- shape */

const blueprint = computed<Blueprint | null>(() => context.value.blueprint)
const tree = computed<BlueprintNode[]>(() => blueprint.value?.tree ?? [])
const pages = computed(() => countPages(tree.value))
const depth = computed(() => treeDepth(tree.value))
const overLimit = computed(() => pages.value > BLUEPRINT_MAX_PAGES || depth.value > BLUEPRINT_MAX_DEPTH)
const untitled = computed(() => hasUntitled(tree.value))

const selected = computed(() => {
  const path = context.value.selected
  return path && nodeAt(tree.value, path) ? path : null
})
const selectedNode = computed(() => (selected.value ? nodeAt(tree.value, selected.value)! : null))
const selectedParent = computed(() => {
  const parent = selected.value?.slice(0, -1)
  const node = parent?.length ? nodeAt(tree.value, parent) : null
  return node?.collection ? node : null
})

const workspaceTemplates = computed(() => templatesStore.offered.filter((tpl) => !tpl.projectId))

function setTree(next: BlueprintNode[]) {
  if (blueprint.value) send({ type: 'SET', patch: { blueprint: { ...blueprint.value, tree: next } } })
}
const select = (path: NodePath | null) => send({ type: 'SET', patch: { selected: path } })

function add(parent: NodePath | null, index?: number, title = t('scaffold.shape.newPage')) {
  const { tree: next, path } = insertNode(tree.value, parent, { title: typedText(lang.value, title) }, index)
  setTree(next)
  select(path)
  // The title is the first thing to change on a page that was just added.
  requestAnimationFrame(() => {
    const input = document.getElementById('kn-scaffold-node-title') as HTMLInputElement | null
    input?.focus()
    input?.select()
  })
}

function patchSelected(fn: (node: BlueprintNode) => void) {
  if (selected.value) setTree(updateNode(tree.value, selected.value, fn))
}

/* ------------------------------------------------------------------- create */

const creating = ref(false)
const createError = ref<string | null>(null)

const conventions = computed(() => blueprint.value?.conventions ?? {})
/** What Create sends: an editor's blueprint drops a styleguide they may not write. */
const outgoing = computed<Blueprint | null>(() => {
  if (!blueprint.value) return null
  const { styleguide, ...rest } = conventions.value
  const kept = auth.canAdminWorkspace && styleguide ? { ...rest, styleguide } : rest
  return { ...blueprint.value, conventions: Object.keys(kept).length ? kept : undefined }
})
/** What a blueprint makes, one line each: the Start preview's facts and Create's summary. */
function conventionFacts(n: number, c: Blueprint['conventions']): string[] {
  return [
    t('scaffold.create.summaryPages', { count: n }, n),
    c?.styleguide && t('scaffold.create.summaryRules', { count: c.styleguide.rules.length }, c.styleguide.rules.length),
    c?.glossary && t('scaffold.create.summaryTerms', { count: c.glossary.length }, c.glossary.length),
    c?.templates && t('scaffold.create.summaryTemplates', { count: c.templates.length }, c.templates.length),
  ].filter(Boolean) as string[]
}
const summary = computed(() => conventionFacts(pages.value, outgoing.value?.conventions))

const canContinue = computed(() => {
  if (step.value === 'shape') return !overLimit.value && !untitled.value
  if (step.value === 'create') return auth.canEdit && !!context.value.name.trim() && !creating.value
  return step.value === 'conventions'
})

async function create() {
  const body = outgoing.value
  if (!body || !canContinue.value) return
  creating.value = true
  createError.value = null
  try {
    const { project } = await api.post('/v1/projects/scaffold', {
      body: {
        workspaceId: getWorkspaceId(),
        name: context.value.name.trim(),
        description: context.value.description.trim() || null,
        locale: lang.value,
        // The DTO cannot name the contracts type; the server parses it with the one schema.
        blueprint: cloneJson(body) as unknown as Record<string, unknown>,
        ...(context.value.restricted ? { restricted: true } : {}),
        ...(context.value.avatarEmoji ? { avatarEmoji: context.value.avatarEmoji } : {}),
      },
    })
    clearSnapshot()
    // Best-effort, as the create dialog did: the project exists whatever the roster says.
    await projects.fetchList({ fresh: true }).catch(() => undefined)
    await projects.switchProject(project.projectId).catch(() => undefined)
    toast.success(t('scaffold.create.created', { name: project.name }))
    void router.replace(`/projects/${project.projectId}`)
  } catch (e) {
    createError.value =
      isApiRequestError(e) && e.status === 403 ? t('nav.noProjectPermission') : (e as Error).message
    creating.value = false
  }
}

/** Cancel unwinds every wizard entry at once, back to the page the wizard was opened from. */
function leave() {
  clearSnapshot()
  const entries = (historyState().position ?? base) - base + 1
  if (exit) router.go(-entries)
  else void router.replace('/documents')
}
</script>

<template>
  <!-- `user`: a reader who asked for less motion gets the end states, no travel. -->
  <MotionConfig reduced-motion="user">
  <div class="flex h-full min-h-0 flex-col">
    <header class="shrink-0 border-b px-4 py-3 lg:px-6">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-base font-semibold">{{ t('scaffold.title') }}</h1>
          <p class="text-muted-foreground truncate text-xs">{{ t('scaffold.subtitle') }}</p>
        </div>
        <Button variant="ghost" size="sm" class="text-muted-foreground shrink-0" @click="leave">
          {{ t('common.cancel') }}
        </Button>
      </div>
      <!-- Not clickable: Back is the way back, as in the workflow wizard. -->
      <ol class="mt-3 flex items-center gap-2 text-xs">
        <li v-for="(name, i) in SCAFFOLD_STEPS" :key="name" class="flex min-w-0 items-center gap-2" :aria-current="i === stepIndex ? 'step' : undefined">
          <span
            class="grid size-5 shrink-0 place-items-center rounded-full border text-micro font-medium transition-colors"
            :class="
              i < stepIndex
                ? 'border-primary bg-primary text-primary-foreground'
                : i === stepIndex
                  ? 'border-primary text-primary'
                  : 'text-muted-foreground'
            "
          >
            <Check v-if="i < stepIndex" class="size-3" />
            <template v-else>{{ i + 1 }}</template>
          </span>
          <span class="truncate" :class="i === stepIndex ? 'text-foreground font-medium' : 'text-muted-foreground hidden sm:inline'">
            {{ t(`scaffold.step.${name}`) }}
          </span>
          <span v-if="i < SCAFFOLD_STEPS.length - 1" class="bg-border hidden h-px w-6 shrink-0 sm:block" aria-hidden="true" />
        </li>
      </ol>
    </header>

    <div class="min-h-0 flex-1 overflow-hidden">
      <AnimatePresence mode="wait" :initial="false">
      <!-- 1 · Start ------------------------------------------------------- -->
      <!-- The two panels are split panes like Shape: full bleed, each pane scrolls itself. -->
      <motion.div v-if="step === 'start' && startView === 'derive'" key="start-derive" class="h-full min-h-0" v-bind="STEP_MOTION">
        <ProjectBlueprintPicker
          :built-ins="blueprints ?? []"
          :locale="lang"
          :can-edit="auth.canEdit"
          @back="stepBack"
          @pick="picked"
          @pick-entry="pick"
        />
      </motion.div>
      <motion.div v-else-if="step === 'start' && startView === 'describe'" key="start-describe" class="h-full min-h-0" v-bind="STEP_MOTION">
        <BlueprintDescribePanel
          :entries="blueprints ?? []"
          :locale="lang"
          :can-edit="auth.canEdit"
          :initial="context.interview"
          :initial-brief="describedAs?.brief"
          @back="stepBack"
          @pick="picked"
          @update="(interview) => send({ type: 'SET', patch: { interview } })"
        />
      </motion.div>
      <motion.div v-else-if="step === 'start'" key="start" class="h-full min-h-0" v-bind="STEP_MOTION">
        <!-- Shape's spine: the ways in down a 24rem rail, the picked blueprint
             filling the rest. Stacked, there is no preview and the step scrolls. -->
        <div class="grid h-full min-h-0 content-start overflow-y-auto lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:content-stretch lg:overflow-hidden">
          <section class="flex flex-col lg:min-h-0 lg:border-r">
            <div class="space-y-2 px-4 pt-5 pb-2 lg:px-6">
              <h2 class="text-lg font-semibold text-balance">{{ t('scaffold.start.title') }}</h2>
              <p class="kn-measure text-muted-foreground text-sm leading-relaxed">{{ t('scaffold.start.body') }}</p>
              <p v-if="!auth.canEdit" class="kn-callout-warning rounded-lg px-3 py-2 text-xs">{{ t('scaffold.start.readOnly') }}</p>
            </div>

            <div class="pb-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              <div v-if="loadError" class="mx-4 mt-3 rounded-xl border p-4 text-sm lg:mx-6" role="alert">
                <p>{{ t('scaffold.start.loadFailed') }}</p>
                <p class="text-muted-foreground mt-1 text-xs">{{ loadError }}</p>
                <Button size="sm" variant="outline" class="mt-3" @click="loadBlueprints">{{ t('common.retry') }}</Button>
              </div>
              <div v-else-if="!blueprints" class="space-y-1.5 px-4 pt-3 lg:px-6" aria-busy="true">
                <Skeleton v-for="i in 6" :key="i" class="h-16 w-full rounded-lg" />
              </div>
              <section v-for="group in startGroups" v-else :key="group.key" :aria-labelledby="`kn-sc-${group.key}`">
                <h3 :id="`kn-sc-${group.key}`" class="kn-sc-group">{{ group.label }}</h3>
                <ul>
                  <li v-for="card in group.cards" :key="card.key">
                    <button
                      type="button"
                      class="kn-sc-row"
                      :disabled="!auth.canEdit && (!card.entry || !wide)"
                      :aria-pressed="wide && card.entry ? previewCard?.key === card.key : undefined"
                      @click="choose(card)"
                      @dblclick="card.entry && auth.canEdit && pick(card.entry)"
                    >
                      <span class="bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center rounded-lg text-base" aria-hidden="true">
                        <template v-if="typeof card.icon === 'string'">{{ card.icon }}</template>
                        <component :is="card.icon" v-else class="size-4" />
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="flex min-w-0 items-baseline gap-2">
                          <span class="min-w-0 truncate text-sm font-medium">{{ card.name }}</span>
                          <span class="text-muted-foreground ml-auto shrink-0 text-caption tabular-nums">{{ card.meta }}</span>
                        </span>
                        <span class="text-muted-foreground mt-0.5 line-clamp-3 text-ui leading-snug lg:line-clamp-2">{{ card.description }}</span>
                      </span>
                      <!-- A panel opens in place; a blueprint (narrow) goes straight to Shape. -->
                      <ChevronRight v-if="!card.entry" class="text-muted-foreground mt-2 size-4 shrink-0" aria-hidden="true" />
                    </button>
                  </li>
                </ul>
              </section>
            </div>
          </section>

          <!-- Preview: the whole blueprint before it is taken. Wide screens only. -->
          <section class="hidden min-h-0 overflow-y-auto px-4 py-5 lg:block lg:px-6" aria-live="polite">
            <div v-if="!blueprints && !loadError" class="space-y-4" aria-busy="true">
              <Skeleton class="h-14 w-full max-w-xl rounded-lg" />
              <div class="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-x-6 gap-y-5">
                <Skeleton v-for="i in 6" :key="i" class="h-28 rounded-lg" />
              </div>
            </div>
            <AnimatePresence mode="wait" :initial="false">
              <motion.article
                v-if="previewCard?.entry"
                :key="previewCard.key"
                :initial="{ opacity: 0 }"
                :animate="{ opacity: 1 }"
                :exit="{ opacity: 0 }"
                :transition="{ duration: 0.12 }"
              >
                <header class="flex flex-wrap items-start gap-3 pb-5">
                  <span class="bg-muted text-muted-foreground grid size-10 shrink-0 place-items-center rounded-lg text-xl" aria-hidden="true">
                    <template v-if="typeof previewCard.icon === 'string'">{{ previewCard.icon }}</template>
                    <component :is="previewCard.icon" v-else class="size-5" />
                  </span>
                  <div class="min-w-0 flex-1 basis-40">
                    <h3 class="text-base font-semibold text-balance">{{ previewCard.name }}</h3>
                    <p class="text-muted-foreground mt-0.5 text-caption tabular-nums">{{ previewFacts.join(' · ') }}</p>
                  </div>
                  <Button size="sm" class="gap-1.5" :disabled="!auth.canEdit" @click="pick(previewCard.entry)">
                    {{ t('scaffold.start.use') }} <ArrowRight class="size-4" />
                  </Button>
                  <!-- Its own line, so a narrow pane never squeezes it beside the button. -->
                  <p v-if="previewCard.description" class="kn-measure text-muted-foreground basis-full text-sm leading-relaxed">
                    {{ previewCard.description }}
                  </p>
                </header>
                <!-- Each section's own rule separates it from the header: no second line. -->
                <BlueprintSectionMap v-if="previewCard.entry.blueprint.tree.length" :tree="previewCard.entry.blueprint.tree" :locale="lang" />
                <p v-else class="kn-measure text-muted-foreground pt-4 text-sm leading-relaxed">{{ t('scaffold.start.blankPreview') }}</p>
              </motion.article>
            </AnimatePresence>
          </section>
        </div>
      </motion.div>

      <!-- 2 · Shape ------------------------------------------------------- -->
      <motion.div v-else-if="step === 'shape'" key="shape" v-bind="STEP_MOTION" class="flex h-full min-h-0 flex-col">
        <!-- Where the outline came from, said plainly: a rules-only read is never
             dressed up as an AI draft. -->
        <p
          v-if="derivedFrom || describedAs"
          class="text-muted-foreground flex shrink-0 items-start gap-2 border-b px-4 py-2 text-xs leading-snug lg:px-6"
          role="status"
        >
          <component :is="describedAs || derivedFrom?.drafted ? Sparkles : ListTree" class="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span v-if="derivedFrom">
            <span class="text-foreground font-medium">{{ t('scaffold.provenance.from', { name: derivedFrom.projectName }) }}</span>
            {{ derivedFrom.drafted ? t('scaffold.provenance.drafted') : t('scaffold.provenance.rulesOnly') }}
          </span>
          <span v-else>
            <span class="text-foreground font-medium">{{ t('scaffold.provenance.described') }}</span>
            {{ t('scaffold.provenance.describedNote') }}
          </span>
        </p>
      <div class="grid min-h-0 flex-1 grid-rows-[minmax(14rem,40%)_minmax(0,1fr)] lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:grid-rows-1">
        <BlueprintOutline
          class="min-h-0 border-b lg:border-r lg:border-b-0"
          :tree="tree"
          :selected="selected"
          :locale="lang"
          @update:tree="setTree"
          @select="select"
          @add="(parent, index) => add(parent, index)"
        />
        <div class="min-h-0 overflow-y-auto">
          <!-- A new selection fades in rather than snapping, so a click in the
               outline reads as "now editing this one". -->
          <AnimatePresence mode="wait" :initial="false">
            <motion.div
              v-if="selectedNode"
              :key="selected!.join('.')"
              :initial="{ opacity: 0 }"
              :animate="{ opacity: 1 }"
              :exit="{ opacity: 0 }"
              :transition="{ duration: 0.12 }"
            >
              <BlueprintNodeEditor
                :node="selectedNode"
                :collection="selectedParent"
                :index="selected![selected!.length - 1]!"
                :locale="lang"
                :templates="workspaceTemplates"
                @patch="patchSelected"
                @add-item="add(selected, undefined, t('scaffold.shape.newItem'))"
              />
            </motion.div>
          </AnimatePresence>
          <p v-if="!selectedNode" class="text-muted-foreground grid h-full place-items-center px-6 text-center text-sm">
            {{ t('scaffold.shape.nothingSelected') }}
          </p>
        </div>
      </div>
      </motion.div>

      <!-- 3 · Conventions ------------------------------------------------- -->
      <motion.div v-else-if="step === 'conventions'" key="conventions" class="h-full overflow-y-auto" v-bind="STEP_MOTION">
        <BlueprintConventions
          :conventions="conventions"
          :can-admin="auth.canAdminWorkspace"
          :offer="derivedFrom?.glossary.length ? { from: derivedFrom.projectName, terms: derivedFrom.glossary } : null"
          @update:conventions="(c) => blueprint && send({ type: 'SET', patch: { blueprint: { ...blueprint, conventions: c } } })"
        />
      </motion.div>

      <!-- 4 · Create ------------------------------------------------------ -->
      <motion.div v-else key="create" class="h-full min-h-0" v-bind="STEP_MOTION">
        <!-- The same spine: what Create will make down the rail, the form beside it. -->
        <div class="grid h-full min-h-0 content-start overflow-y-auto lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:content-stretch lg:overflow-hidden">
        <form class="min-w-0 px-4 py-6 lg:order-last lg:min-h-0 lg:overflow-y-auto lg:px-6" @submit.prevent="create">
          <div class="max-w-2xl space-y-5">
            <div>
              <h2 class="text-lg font-semibold">{{ t('scaffold.create.title') }}</h2>
              <p class="kn-measure text-muted-foreground mt-1 text-sm leading-relaxed">{{ t('scaffold.create.body') }}</p>
            </div>

            <label class="block space-y-1.5">
              <span class="text-muted-foreground text-xs font-medium">{{ t('nav.projectName') }}</span>
              <Input
                :model-value="context.name"
                maxlength="120"
                autocomplete="off"
                :placeholder="t('nav.projectNamePlaceholder')"
                :aria-invalid="!!createError || undefined"
                @update:model-value="(v) => send({ type: 'SET', patch: { name: String(v) } })"
              />
            </label>
            <label class="block space-y-1.5">
              <span class="text-muted-foreground text-xs font-medium">
                {{ t('nav.description') }} <span class="font-normal">{{ t('nav.optionalSuffix') }}</span>
              </span>
              <Input
                :model-value="context.description"
                maxlength="2000"
                autocomplete="off"
                :placeholder="t('nav.scopeDescriptionPlaceholder')"
                @update:model-value="(v) => send({ type: 'SET', patch: { description: String(v) } })"
              />
            </label>

            <fieldset v-if="pages" class="space-y-1.5">
              <legend class="text-muted-foreground text-xs font-medium">{{ t('scaffold.create.language') }}</legend>
              <div class="inline-flex rounded-lg border p-0.5" role="radiogroup">
                <button
                  v-for="l in SUPPORTED_LOCALES"
                  :key="l"
                  type="button"
                  role="radio"
                  :aria-checked="lang === l"
                  class="rounded-md px-3 py-1 text-ui transition-colors"
                  :class="lang === l ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground'"
                  @click="send({ type: 'SET', patch: { locale: l } })"
                >
                  {{ t(`scaffold.create.lang.${l}`) }}
                </button>
              </div>
              <p class="text-muted-foreground text-caption">{{ t('scaffold.create.languageHint') }}</p>
            </fieldset>

            <fieldset class="space-y-1.5">
              <legend class="text-muted-foreground text-xs font-medium">{{ t('project.appearance') }}</legend>
              <div class="flex flex-wrap items-center gap-1.5">
                <button
                  v-for="choice in EMOJI_CHOICES"
                  :key="choice"
                  type="button"
                  class="grid size-9 place-items-center rounded-md border text-base transition-colors hover:bg-muted"
                  :class="context.avatarEmoji === choice ? 'border-primary bg-muted' : 'border-transparent'"
                  :aria-pressed="context.avatarEmoji === choice"
                  :aria-label="choice"
                  @click="send({ type: 'SET', patch: { avatarEmoji: context.avatarEmoji === choice ? null : choice } })"
                >
                  {{ choice }}
                </button>
              </div>
            </fieldset>

            <label class="flex items-start gap-2.5 rounded-lg border p-3">
              <Checkbox
                class="mt-0.5"
                :model-value="context.restricted"
                @update:model-value="send({ type: 'SET', patch: { restricted: $event === true } })"
              />
              <span>
                <span class="flex items-center gap-1.5 text-sm font-medium"><Lock class="size-3.5" /> {{ t('scaffold.create.restricted') }}</span>
                <span class="text-muted-foreground mt-0.5 block text-xs leading-snug">{{ t('scaffold.create.restrictedHint') }}</span>
              </span>
            </label>

            <p v-if="createError" role="alert" class="text-destructive text-sm">{{ createError }}</p>
          </div>
        </form>

          <!-- What Create will make, read before it is pressed. -->
          <aside class="border-t px-4 py-6 lg:order-first lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:border-r lg:px-6">
            <div class="flex items-center gap-3">
              <ProjectAvatar
                project-id="new"
                :name="context.name || t('scaffold.create.unnamed')"
                :avatar-emoji="context.avatarEmoji"
                size="md"
              />
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">{{ context.name.trim() || t('scaffold.create.unnamed') }}</p>
                <p class="text-muted-foreground truncate text-caption">
                  {{ blueprint ? blueprintText(blueprint.name, lang) : '' }}
                  <template v-if="context.restricted"> · {{ t('scaffold.create.restrictedShort') }}</template>
                </p>
              </div>
            </div>
            <ul class="text-muted-foreground mt-4 space-y-1 border-t pt-3 text-ui">
              <li v-for="line in summary" :key="line">{{ line }}</li>
            </ul>
            <p v-if="!auth.canAdminWorkspace && conventions.styleguide" class="text-muted-foreground mt-3 text-caption leading-snug">
              {{ t('scaffold.conventions.styleguideSkipped') }}
            </p>
            <section v-if="pages" class="mt-5 border-t pt-4" :aria-label="t('scaffold.shape.outline')">
              <h3 class="text-muted-foreground mb-2 text-xs font-medium">{{ t('scaffold.shape.outline') }}</h3>
              <BlueprintTreePreview :tree="tree" :locale="lang" />
            </section>
          </aside>
        </div>
      </motion.div>
      </AnimatePresence>
    </div>

    <footer class="flex shrink-0 items-center gap-2 border-t px-4 py-3 lg:px-6">
      <Button v-if="step !== 'start'" variant="ghost" size="sm" class="gap-1.5" :disabled="creating" @click="stepBack">
        <ArrowLeft class="size-4" /> {{ t('common.back') }}
      </Button>
      <Button v-if="resumed && step !== 'start'" variant="ghost" size="sm" class="text-muted-foreground" :disabled="creating" @click="send({ type: 'RESTART' })">
        {{ t('scaffold.startOver') }}
      </Button>

      <Button
        v-if="step === 'shape' && auth.canAdminWorkspace"
        variant="ghost"
        size="sm"
        class="gap-1.5"
        :disabled="!pages || untitled || overLimit"
        @click="saveOpen = true"
      >
        <BookmarkPlus class="size-4" /> <span class="max-sm:sr-only">{{ t('blueprints.save.title') }}</span>
      </Button>

      <p
        v-if="step === 'shape'"
        class="ml-auto text-xs tabular-nums"
        :class="overLimit ? 'text-destructive' : 'text-muted-foreground'"
      >
        {{ t('scaffold.shape.limits', { pages, maxPages: BLUEPRINT_MAX_PAGES, depth, maxDepth: BLUEPRINT_MAX_DEPTH }) }}
        <template v-if="untitled"> · <span class="text-destructive">{{ t('scaffold.shape.untitledBlocks') }}</span></template>
      </p>
      <p v-else class="text-muted-foreground ml-auto hidden text-xs sm:block">{{ t(`scaffold.footer.${step}`) }}</p>

      <Button v-if="step === 'shape' || step === 'conventions'" size="sm" class="gap-1.5" :disabled="!canContinue" @click="send({ type: 'NEXT' })">
        {{ t('common.continue') }} <ArrowRight class="size-4" />
      </Button>
      <Button v-else-if="step === 'create'" size="sm" class="gap-1.5" :disabled="!canContinue" @click="create">
        <Loader2 v-if="creating" class="size-4 animate-spin" />
        {{ creating ? t('scaffold.create.creating', { count: pages }, pages) : t('scaffold.create.submitPages', { count: pages }, pages) }}
      </Button>
    </footer>
    <SaveBlueprintDialog v-if="auth.canAdminWorkspace" v-model:open="saveOpen" :blueprint="blueprint" :origin="origin" :locale="lang" @saved="onSaved" />
  </div>
  </MotionConfig>
</template>

<style scoped>
.kn-sc-group {
  padding: 1rem 1rem 0.375rem;
  font-size: var(--text-caption, 0.75rem);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}
.kn-sc-row {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.625rem 1rem;
  text-align: left;
  transition: background-color 120ms ease-out;
}
/* The rows reach the rail's edges; their content keeps the header's gutter. */
@media (min-width: 64rem) {
  .kn-sc-group,
  .kn-sc-row {
    padding-inline: 1.5rem;
  }
}
.kn-sc-row:hover:not(:disabled) {
  background: var(--accent);
}
.kn-sc-row[aria-pressed='true'] {
  background: color-mix(in oklab, var(--primary) 8%, transparent);
}
.kn-sc-row:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
.kn-sc-row:disabled {
  opacity: 0.55;
}

@media (prefers-reduced-motion: reduce) {
  .kn-sc-row {
    transition-duration: 0.01ms;
  }
}
</style>
