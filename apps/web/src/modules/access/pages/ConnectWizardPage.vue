<script setup lang="ts">
/**
 * /setup/connect (#1225): connecting an AI client as questions, full screen.
 *
 * Three columns at lg: the steps (each answered one shows its answer), the
 * question, and the config that answer produces, re-rendered live — what is
 * being built is literally a file and a command, so it is on screen from the
 * first answer. Below lg the rail becomes "Step n of m" and the config folds
 * under the question.
 *
 * Every step stays mounted (`v-show`), so going back keeps what was typed and
 * the key minted here stays in memory until the page goes; on reload it is
 * gone, by design. What the answers mean (scope, toolsets, which steps apply)
 * is `connect-plan.ts`, pure and spec'd.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { ArrowLeft, ArrowRight, Check, ChevronDown, X } from 'lucide-vue-next'
import { useQueryClient } from '@tanstack/vue-query'
import type { ApiKeyInfo, McpConnectionInfo } from '@knowledge/contracts'
import { Button } from '@knowledge/ui/button'
import { Skeleton } from '@knowledge/ui/skeleton'
import { fetchApi } from '@/shared/api/queries'
import { ownPath } from '@/shared/utils/own-path'
import {
  CONNECT_ROLES,
  CONNECT_WORKFLOWS,
  KEY_ENV,
  mcpClients,
  scopeFor,
  skillStackInstallCommand,
  stepsFor,
  toolsetsFor,
  workflowsFor,
  type ConnectRole,
  type ConnectStep,
  type ConnectWorkflow,
} from '@/entities/access'
import { useWorkspacesStore } from '@/stores/workspaces'
import ChoiceCards from '../components/connect/ChoiceCards.vue'
import ClientCards from '../components/connect/ClientCards.vue'
import ConfigPane from '../components/connect/ConfigPane.vue'
import KeyStep from '../components/connect/KeyStep.vue'
import SkillStep from '../components/connect/SkillStep.vue'
import StepHelp from '../components/connect/StepHelp.vue'
import VerifyPanel from '../components/connect/VerifyPanel.vue'

const { t, tm, rt } = useI18n()
const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const workspaces = useWorkspacesStore()

const since = Date.now()
const connection = ref<McpConnectionInfo | null>(null)
const loading = ref(true)
const needsKey = computed(() => connection.value?.authMode === 'api-key')

onMounted(async () => {
  workspaces.ensureLoaded()
  try {
    connection.value = await fetchApi(queryClient, '/v1/mcp/connection')
  } catch {
    toast.error(t('connect.loadFailed'))
  } finally {
    loading.value = false
  }
})

function close() {
  void router.push(ownPath(route.query.next, '/settings/ai/connect'))
}

/* ------------------------------------------------------------------ answers */

const role = ref<ConnectRole | null>(null)
// `?client=` is an opening instruction (house rule), checked against the list once it exists.
const clientId = ref<string | null>(typeof route.query.client === 'string' ? route.query.client : null)
/** null = follow the role. */
const workflowPick = ref<ConnectWorkflow[] | null>(null)
const workflows = computed<ConnectWorkflow[]>({
  get: () => workflowPick.value ?? (role.value ? workflowsFor(role.value) : ['ask']),
  set: (v) => (workflowPick.value = v),
})
const keyMode = ref<'new' | 'existing'>('new')
const fresh = ref<{ key: ApiKeyInfo; apiKey: string } | null>(null)
const skillFormat = ref<'single' | 'stack'>('single')
const kit = ref<'yes' | 'no'>('yes')

const clients = computed(() =>
  connection.value
    ? mcpClients({ url: connection.value.url, serverName: connection.value.serverName, auth: needsKey.value, key: fresh.value?.apiKey ?? null })
    : [],
)
const client = computed(() => clients.value.find((c) => c.id === clientId.value) ?? null)
const wantsKit = computed(() => !!client.value?.captureKit && workflows.value.includes('capture') && kit.value === 'yes')

/** Run from the same shell as the client: the whoami call, with the variable it reads. */
const check = computed(() => {
  const http = clients.value.find((c) => c.id === 'http')?.config.code ?? ''
  const exported = needsKey.value && !client.value?.usesEnv ? `export ${KEY_ENV}=${fresh.value?.apiKey ?? '<your-api-key>'}\n` : ''
  return exported + http
})

/* -------------------------------------------------------------------- steps */

/** A skill directory the server can install the stack into (the claude and agents dirs); others take one SKILL.md. */
const stackable = computed(
  () => !!(connection.value && client.value?.skillDir && skillStackInstallCommand(connection.value.url, client.value.skillDir, false)),
)
const steps = computed(() =>
  stepsFor({
    needsKey: needsKey.value,
    client: client.value && { stackable: stackable.value, captureKit: client.value.captureKit },
    workflows: workflows.value,
  }),
)
const index = ref(0)
const step = computed<ConnectStep>(() => steps.value[Math.min(index.value, steps.value.length - 1)]!)

function ok(s: ConnectStep): boolean {
  if (s === 'role') return !!role.value
  if (s === 'client') return !!client.value
  if (s === 'workflow') return workflows.value.length > 0
  if (s === 'key') return !!fresh.value || keyMode.value === 'existing'
  return true
}
/** A step is open once every step before it is answered. */
const reachable = (i: number) => steps.value.slice(0, i).every(ok)
const blocked = computed(() => {
  if (ok(step.value)) return null
  if (step.value === 'workflow') return t('connect.wizard.workflow.none')
  if (step.value === 'key') return t('connect.wizard.key.createFirst')
  return null
})
const last = computed(() => index.value >= steps.value.length - 1)

function go(i: number) {
  if (i >= 0 && i < steps.value.length && reachable(i)) index.value = i
}
function next() {
  if (last.value) return close()
  if (ok(step.value)) go(index.value + 1)
}
/** Enter on a choice moves on, as it would submit a one-question form. */
function onEnter(e: KeyboardEvent) {
  const el = e.target as HTMLInputElement
  if (el.type === 'radio' || el.type === 'checkbox') {
    e.preventDefault()
    next()
  }
}

// Each step replaces the last: focus its heading so a screen reader hears where it is.
const heading = ref<HTMLElement | null>(null)
const paneOpen = ref(false)
watch(step, (now) => {
  if (now === 'configure') paneOpen.value = true
  void nextTick(() => heading.value?.focus({ preventScroll: true }))
  main.value?.scrollTo({ top: 0 })
})
const main = ref<HTMLElement | null>(null)

/* ---------------------------------------------------------------- the words */

const titles = computed<Record<ConnectStep, string>>(() => {
  const name = client.value?.name ?? ''
  return {
    role: t('connect.wizard.role.title'),
    client: t('connect.wizard.client.title'),
    workflow: t('connect.wizard.workflow.title'),
    key: t('connect.wizard.key.title'),
    preferences: t('connect.wizard.preferences.title'),
    configure: t('connect.wizard.configure.title', { client: name }),
    skill: t('connect.wizard.skill.title', { client: name }),
    verify: t('connect.wizard.verify.title'),
  }
})

const roleOptions = computed(() =>
  CONNECT_ROLES.map((r) => ({ value: r, label: t(`connect.wizard.role.options.${r}.label`), hint: t(`connect.wizard.role.options.${r}.hint`) })),
)
const workflowOptions = computed(() =>
  CONNECT_WORKFLOWS.map((w) => ({
    value: w,
    label: t(`connect.wizard.workflow.options.${w}.label`),
    hint: t(`connect.wizard.workflow.options.${w}.hint`),
  })),
)
const skillOptions = computed(() =>
  (['single', 'stack'] as const).map((v) => ({
    value: v,
    label: t(`connect.wizard.preferences.skill.${v}.label`),
    hint: t(`connect.wizard.preferences.skill.${v}.hint`),
  })),
)
const kitOptions = computed(() =>
  (['yes', 'no'] as const).map((v) => ({
    value: v,
    label: t(`connect.wizard.preferences.kit.${v}.label`),
    hint: t(`connect.wizard.preferences.kit.${v}.hint`),
  })),
)

/** What each answered step says in the rail. */
const answers = computed<Partial<Record<ConnectStep, string>>>(() => ({
  role: role.value ? t(`connect.wizard.role.options.${role.value}.label`) : undefined,
  client: client.value?.name,
  workflow: workflows.value.map((w) => t(`connect.wizard.workflow.options.${w}.label`)).join(', '),
  key: fresh.value?.key.name ?? (keyMode.value === 'existing' ? t('connect.wizard.key.have') : undefined),
  preferences: stackable.value ? t(`connect.wizard.preferences.skill.${skillFormat.value}.label`) : undefined,
}))

type HelpItem = { q: string; a: string }
function helpAt(key: string): HelpItem[] {
  const raw = tm(key) as unknown
  return Array.isArray(raw) ? (raw as { q: unknown; a: unknown }[]).map((i) => ({ q: rt(i.q as string), a: rt(i.a as string) })) : []
}
const help = computed(() => [
  ...helpAt(`connect.wizard.help.${step.value}`),
  ...(client.value && (step.value === 'configure' || step.value === 'verify') ? helpAt(`connect.wizard.clientHelp.${client.value.note}`) : []),
])
</script>

<template>
  <header class="flex h-14 shrink-0 items-center gap-3 border-b px-4 lg:px-6">
    <h1 class="min-w-0 truncate font-display text-base font-semibold tracking-tight">{{ t('connect.wizard.title') }}</h1>
    <!-- The rail's job below lg: where you are, and a way back to an answered step. -->
    <label v-if="!loading && connection" class="relative ml-auto flex min-w-0 items-center lg:hidden">
      <span class="sr-only">{{ t('connect.wizard.stepsLabel') }}</span>
      <select
        class="h-8 max-w-[10rem] appearance-none rounded-md border bg-transparent pr-7 pl-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring"
        :value="index"
        @change="go(Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="(s, i) in steps" :key="s" :value="i" :disabled="!reachable(i)">
          {{ i + 1 }}. {{ t(`connect.wizard.steps.${s}`) }}
        </option>
      </select>
      <ChevronDown class="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" aria-hidden="true" />
    </label>
    <Button variant="ghost" size="icon" class="shrink-0 lg:ml-auto" :aria-label="t('connect.wizard.close')" @click="close">
      <X class="size-4" />
    </Button>
  </header>

  <div v-if="loading" class="grid flex-1 gap-6 p-6 lg:grid-cols-[14rem_minmax(0,1fr)_minmax(19rem,26rem)]">
    <Skeleton class="hidden h-72 rounded-lg lg:block" />
    <Skeleton class="h-96 rounded-xl" />
    <Skeleton class="h-96 rounded-xl" />
  </div>

  <p v-else-if="!connection" class="m-auto px-4 text-sm text-muted-foreground">{{ t('connect.loadFailed') }}</p>

  <div v-else class="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[14rem_minmax(0,1fr)_minmax(19rem,26rem)] lg:overflow-hidden">
    <!-- The steps ---------------------------------------------------------- -->
    <nav :aria-label="t('connect.wizard.stepsLabel')" class="hidden overflow-y-auto border-r bg-sidebar px-3 py-6 lg:block">
      <ol class="grid gap-0.5">
        <li v-for="(s, i) in steps" :key="s" class="min-w-0">
          <button
            type="button"
            class="flex w-full min-w-0 items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring disabled:cursor-default"
            :class="i === index ? 'bg-primary/10 text-primary' : reachable(i) ? 'hover:bg-sidebar-accent' : 'text-muted-foreground/60'"
            :aria-current="i === index ? 'step' : undefined"
            :disabled="!reachable(i)"
            @click="go(i)"
          >
            <span class="kn-step mt-px" :class="{ 'kn-step-done': i < index && ok(s) }">
              <Check v-if="i < index && ok(s)" class="size-3" aria-hidden="true" />
              <template v-else>{{ i + 1 }}</template>
            </span>
            <span class="min-w-0">
              <span class="block text-ui font-medium">{{ t(`connect.wizard.steps.${s}`) }}</span>
              <span v-if="i < index && answers[s]" class="block truncate text-caption text-muted-foreground">{{ answers[s] }}</span>
            </span>
          </button>
        </li>
      </ol>
    </nav>

    <!-- The question ------------------------------------------------------- -->
    <main ref="main" class="min-w-0 px-4 pt-6 lg:overflow-y-auto lg:px-10 lg:pt-10" @keydown.enter="onEnter">
      <div class="grid gap-6">
        <header class="grid gap-1.5">
          <p class="text-caption text-muted-foreground lg:hidden">{{ t('connect.wizard.stepOf', { n: index + 1, m: steps.length }) }}</p>
          <h2 ref="heading" tabindex="-1" class="font-display text-xl font-semibold tracking-tight outline-none">{{ titles[step] }}</h2>
          <p v-if="step === 'role'" class="kn-measure text-sm text-muted-foreground">{{ t('connect.wizard.role.hint') }}</p>
          <p v-else-if="step === 'client'" class="kn-measure text-sm text-muted-foreground">{{ t('connect.wizard.client.hint') }}</p>
          <p v-else-if="step === 'workflow'" class="kn-measure text-sm text-muted-foreground">{{ t('connect.wizard.workflow.hint') }}</p>
          <p v-else-if="step === 'key'" class="kn-measure text-sm text-muted-foreground">{{ t('connect.wizard.key.hint') }}</p>
          <p v-else-if="step === 'configure'" class="kn-measure text-sm text-muted-foreground">
            {{ t('connect.wizard.configure.hint', { client: client?.name ?? '' }) }}
          </p>
        </header>

        <div v-show="step === 'role'">
          <ChoiceCards v-model="role" name="kn-wiz-role" quiet-legend :legend="t('connect.wizard.steps.role')" :options="roleOptions" />
        </div>
        <div v-show="step === 'client'">
          <ClientCards v-model="clientId" :clients="clients" :legend="t('connect.wizard.steps.client')" />
        </div>
        <div v-show="step === 'workflow'">
          <ChoiceCards
            v-model="workflows"
            name="kn-wiz-workflow"
            quiet-legend
            multiple
            :legend="t('connect.wizard.steps.workflow')"
            :note="workflows.length ? t('connect.wizard.workflow.needs', { scope: t(`connect.keys.scopes.${scopeFor(workflows)}`) }) : undefined"
            :options="workflowOptions"
          />
        </div>
        <div v-if="needsKey" v-show="step === 'key'">
          <KeyStep
            v-model:mode="keyMode"
            :default-name="t('connect.wizard.key.defaultName', { client: client?.name ?? 'AI' })"
            :suggested-scope="scopeFor(workflows)"
            :suggested-toolsets="toolsetsFor(workflows)"
            :fresh="fresh"
            @created="fresh = $event"
          />
        </div>
        <div v-show="step === 'preferences'" class="grid gap-6">
          <ChoiceCards v-if="stackable" v-model="skillFormat" name="kn-wiz-skill" :legend="t('connect.wizard.preferences.skill.legend')" :options="skillOptions" />
          <ChoiceCards
            v-if="client?.captureKit && workflows.includes('capture')"
            v-model="kit"
            name="kn-wiz-kit"
            :legend="t('connect.wizard.preferences.kit.legend')"
            :options="kitOptions"
          />
        </div>
        <div v-if="client" v-show="step === 'skill'">
          <SkillStep
            :url="connection.url"
            :client="client"
            :needs-key="needsKey"
            :api-key="fresh?.apiKey ?? null"
            :key-scope="fresh?.key.scope ?? null"
            :format="skillFormat"
            :kit="wantsKit"
            :ticket="workflows.includes('code')"
          />
        </div>
        <div v-show="step === 'verify'">
          <VerifyPanel
            :active="step === 'verify'"
            :needs-key="needsKey"
            :client-name="client?.name ?? ''"
            :key-id="fresh?.key.id ?? null"
            :api-key="fresh?.apiKey ?? null"
            :since="since"
            :check="check"
            :session-tools="connection.tools.length"
          />
        </div>

        <StepHelp :key="step" :items="help" />

        <!-- Pinned to the bottom of whatever scrolls, so a long step never hides its way on. -->
        <footer
          class="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t bg-background/90 px-4 py-3 backdrop-blur lg:-mx-10 lg:px-10 lg:py-4"
        >
          <Button v-if="index > 0" variant="ghost" class="gap-1.5" @click="go(index - 1)">
            <ArrowLeft class="size-4" />{{ t('connect.wizard.back') }}
          </Button>
          <Button class="ml-auto gap-1.5" :disabled="!ok(step)" @click="next">
            {{ last ? t('connect.wizard.done') : t('connect.wizard.continue') }}
            <ArrowRight v-if="!last" class="size-4" />
          </Button>
          <p v-if="blocked" class="w-full text-right text-caption text-muted-foreground">{{ blocked }}</p>
        </footer>
      </div>
    </main>

    <!-- The config --------------------------------------------------------- -->
    <aside class="min-w-0 border-t bg-sidebar px-4 py-6 lg:overflow-y-auto lg:border-t-0 lg:border-l lg:px-8 lg:py-10" :aria-label="t('connect.wizard.pane.title')">
      <h2 class="hidden font-display text-sm font-semibold tracking-tight lg:block">{{ t('connect.wizard.pane.title') }}</h2>
      <button
        type="button"
        class="flex w-full items-center justify-between gap-2 rounded-md text-left text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring lg:hidden"
        :aria-expanded="paneOpen"
        @click="paneOpen = !paneOpen"
      >
        <span class="font-display font-semibold tracking-tight">{{ t('connect.wizard.pane.title') }}</span>
        <ChevronDown class="size-4 text-muted-foreground transition-transform motion-reduce:transition-none" :class="paneOpen ? 'rotate-180' : ''" aria-hidden="true" />
      </button>
      <div class="mt-4" :class="paneOpen ? 'block' : 'hidden lg:block'">
        <ConfigPane :url="connection.url" :client="client" :needs-key="needsKey" :api-key="fresh?.apiKey ?? null" />
      </div>
    </aside>
  </div>
</template>

<style scoped>
.kn-step {
  display: inline-grid;
  flex-shrink: 0;
  place-items: center;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 9999px;
  border: 1px solid var(--border);
  font-size: var(--kn-text-micro);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
[aria-current='step'] .kn-step {
  border-color: transparent;
  background: var(--primary);
  color: var(--primary-foreground);
}
.kn-step-done {
  border-color: transparent;
  background: color-mix(in oklab, var(--primary) 12%, transparent);
  color: var(--primary);
}
</style>
