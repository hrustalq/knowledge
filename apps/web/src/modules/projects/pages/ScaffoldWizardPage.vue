<script setup lang="ts">
/**
 * Creating a project (#716): pick a shape, adjust it, create it.
 *
 * The workflow wizard's frame — a fixed header with the stepper, a body that
 * flexes, one action bar — over `scaffoldMachine`. Nothing is written until
 * Create, which sends the edited blueprint inline to `POST /v1/projects/scaffold`:
 * the project, its conventions and every page in one transaction. The pages
 * are published skeletons that stay out of search until someone writes them.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { createActor, type Actor } from 'xstate'
import { AnimatePresence, Motion, MotionConfig, motion } from 'motion-v'
import { toast } from 'vue-sonner'
import { ArrowLeft, ArrowRight, BookmarkPlus, Check, FilePlus, FolderTree, ListTree, Loader2, Lock, MessagesSquare, Sparkles } from 'lucide-vue-next'
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
import { useTemplatesStore } from '@/entities/template'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Checkbox } from '@/shared/ui/checkbox'
import { Skeleton } from '@/shared/ui/skeleton'
import BlueprintOutline from '@/modules/projects/components/BlueprintOutline.vue'
import BlueprintNodeEditor from '@/modules/projects/components/BlueprintNodeEditor.vue'
import BlueprintConventions from '@/modules/projects/components/BlueprintConventions.vue'
import ProjectBlueprintPicker from '@/modules/projects/components/ProjectBlueprintPicker.vue'
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

/* ------------------------------------------------------------------ machine */

const actor = shallowRef<Actor<typeof scaffoldMachine> | null>(null)
const step = ref<ScaffoldStep>('start')
const context = ref<ScaffoldContext>(emptyContext())
const resumed = ref(false)

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
  if (typeof wanted === 'string') void router.replace({ query: { ...route.query, blueprint: undefined } })
  if (entry && auth.canEdit) pick(entry)
}

interface StartCard {
  key: string
  icon: string | Component
  name: string
  meta: string
  description: string
  chips: string[]
  more: number
  soon: boolean
  entry?: BlueprintEntry
}

const CHIPS = 4
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
      chips: tree.slice(0, CHIPS).map((n) => blueprintText(n.title, lang.value)),
      more: Math.max(0, tree.length - CHIPS),
      soon: false,
      entry,
    }
  }),
  {
    key: 'derive',
    icon: FolderTree,
    name: t('scaffold.start.derive'),
    meta: t('scaffold.start.deriveMeta'),
    description: t('scaffold.start.deriveBody'),
    chips: [],
    more: 0,
    soon: false,
  },
  // The source still to come (phase 5), drawn so the flow's shape is honest.
  {
    key: 'describe',
    icon: MessagesSquare,
    name: t('scaffold.start.describe'),
    meta: t('scaffold.start.soon'),
    description: t('scaffold.start.describeBody'),
    chips: [],
    more: 0,
    soon: true,
  },
])

/** Start shows the cards, or the From a project picker in their place. */
const startView = ref<'cards' | 'derive'>('cards')

function choose(card: StartCard) {
  if (card.entry) pick(card.entry)
  else if (card.key === 'derive') startView.value = 'derive'
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

/* ---------------------------------------------------------- save as blueprint */

const saveOpen = ref(false)
function onSaved(entry: BlueprintEntry) {
  // Saving again now updates that row — unless the outline came from a project,
  // whose provenance and offered terms the later steps still need.
  if (origin.value?.kind !== 'project') {
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
const summary = computed(() => {
  const c = outgoing.value?.conventions
  return [
    t('scaffold.create.summaryPages', { count: pages.value }, pages.value),
    c?.styleguide && t('scaffold.create.summaryRules', { count: c.styleguide.rules.length }, c.styleguide.rules.length),
    c?.glossary && t('scaffold.create.summaryTerms', { count: c.glossary.length }, c.glossary.length),
    c?.templates && t('scaffold.create.summaryTemplates', { count: c.templates.length }, c.templates.length),
  ].filter(Boolean) as string[]
})

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

function leave() {
  clearSnapshot()
  if (window.history.length > 1) router.back()
  else void router.push('/documents')
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
      <motion.div v-if="step === 'start' && startView === 'derive'" key="start-derive" class="h-full overflow-y-auto" v-bind="STEP_MOTION">
        <ProjectBlueprintPicker
          :built-ins="blueprints ?? []"
          :locale="lang"
          :can-edit="auth.canEdit"
          @back="startView = 'cards'"
          @pick="picked"
          @pick-entry="pick"
        />
      </motion.div>
      <motion.div v-else-if="step === 'start'" key="start" class="h-full overflow-y-auto" v-bind="STEP_MOTION">
        <div class="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-8 lg:py-10">
          <div>
            <h2 class="text-lg font-semibold">{{ t('scaffold.start.title') }}</h2>
            <p class="kn-measure text-muted-foreground mt-1 text-sm leading-relaxed">{{ t('scaffold.start.body') }}</p>
          </div>

          <p v-if="!auth.canEdit" class="kn-callout-warning rounded-lg px-3 py-2 text-xs">{{ t('scaffold.start.readOnly') }}</p>

          <div v-if="loadError" class="rounded-xl border p-4 text-sm" role="alert">
            <p>{{ t('scaffold.start.loadFailed') }}</p>
            <p class="text-muted-foreground mt-1 text-xs">{{ loadError }}</p>
            <Button size="sm" variant="outline" class="mt-3" @click="loadBlueprints">{{ t('common.retry') }}</Button>
          </div>
          <div v-else-if="!blueprints" class="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
            <Skeleton v-for="i in 6" :key="i" class="h-32 rounded-xl" />
          </div>
          <!-- One card shape for every source: header, two lines of what it is
               for, then its top-level sections pinned to the foot, so a row of
               cards reads as a row of the same thing. -->
          <div v-else class="grid auto-rows-fr grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            <Motion
              :as="card.soon ? 'div' : 'button'"
              v-for="(card, i) in cards"
              :key="card.key"
              :type="card.soon ? undefined : 'button'"
              class="kn-sc-card"
              :class="card.soon && 'kn-sc-card--soon'"
              :aria-disabled="card.soon || undefined"
              :disabled="!card.soon && !auth.canEdit"
              :initial="{ opacity: 0, y: 8 }"
              :animate="{ opacity: 1, y: 0 }"
              :transition="{ duration: 0.24, delay: i * 0.035, ease: EASE }"
              :while-hover="card.soon || !auth.canEdit ? undefined : { y: -2 }"
              :while-press="card.soon || !auth.canEdit ? undefined : { scale: 0.99 }"
              @click="!card.soon && choose(card)"
            >
              <span class="flex items-center gap-2.5">
                <span class="bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center rounded-lg text-base" aria-hidden="true">
                  <template v-if="typeof card.icon === 'string'">{{ card.icon }}</template>
                  <component :is="card.icon" v-else class="size-4" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium">{{ card.name }}</span>
                  <span class="text-muted-foreground block text-caption tabular-nums">{{ card.meta }}</span>
                </span>
              </span>
              <span class="text-muted-foreground mt-2 line-clamp-2 text-ui leading-snug">{{ card.description }}</span>
              <span v-if="card.chips.length" class="kn-sc-chips mt-auto flex min-w-0 gap-1 overflow-hidden pt-2.5">
                <span
                  v-for="chip in card.chips"
                  :key="chip"
                  class="bg-muted text-muted-foreground shrink-0 truncate rounded px-1.5 py-px text-caption"
                >{{ chip }}</span>
                <span v-if="card.more" class="text-muted-foreground shrink-0 text-caption">+{{ card.more }}</span>
              </span>
            </Motion>
          </div>
        </div>
      </motion.div>

      <!-- 2 · Shape ------------------------------------------------------- -->
      <motion.div v-else-if="step === 'shape'" key="shape" v-bind="STEP_MOTION" class="flex h-full min-h-0 flex-col">
        <!-- Where the outline came from, said plainly: a rules-only read is never
             dressed up as an AI draft. -->
        <p
          v-if="derivedFrom"
          class="text-muted-foreground flex shrink-0 items-start gap-2 border-b px-4 py-2 text-xs leading-snug lg:px-6"
          role="status"
        >
          <component :is="derivedFrom.drafted ? Sparkles : ListTree" class="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span class="text-foreground font-medium">{{ t('scaffold.provenance.from', { name: derivedFrom.projectName }) }}</span>
            {{ derivedFrom.drafted ? t('scaffold.provenance.drafted') : t('scaffold.provenance.rulesOnly') }}
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
      <motion.div v-else key="create" class="h-full overflow-y-auto" v-bind="STEP_MOTION">
        <form class="mx-auto grid max-w-4xl gap-8 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:py-10" @submit.prevent="create">
          <div class="min-w-0 space-y-5">
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

          <!-- What Create will make, read before it is pressed. -->
          <aside class="h-fit rounded-xl border p-4">
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
          </aside>
        </form>
      </motion.div>
      </AnimatePresence>
    </div>

    <footer class="flex shrink-0 items-center gap-2 border-t px-4 py-3 lg:px-6">
      <Button v-if="step !== 'start'" variant="ghost" size="sm" class="gap-1.5" :disabled="creating" @click="send({ type: 'BACK' })">
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
.kn-sc-card {
  /* A grid item's min-width is its content's: the chip row would push it wide. */
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--card);
  padding: 0.875rem;
  text-align: left;
  transition: border-color 160ms ease-out;
}
button.kn-sc-card:hover:not(:disabled) {
  border-color: color-mix(in oklab, var(--primary) 40%, var(--border));
}
button.kn-sc-card:focus-visible {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
}
button.kn-sc-card:disabled,
.kn-sc-card--soon {
  opacity: 0.55;
}
.kn-sc-chips {
  /* Sections past the card's edge fade out rather than being cut mid-word. */
  mask-image: linear-gradient(to right, #000 82%, transparent);
}
.kn-sc-card--soon {
  border-style: dashed;
  background: transparent;
}

@media (prefers-reduced-motion: reduce) {
  .kn-sc-card {
    transition-duration: 0.01ms;
  }
}
</style>
