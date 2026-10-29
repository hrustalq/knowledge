<script setup lang="ts">
/**
 * Connect an account and link what it reaches to projects (#564):
 * service → sign in → resources → done.
 *
 * One flow for every provider. A token is pasted and identified on save; a
 * GitHub App install or a Figma authorisation happens in another tab, and
 * this dialog learns of it from the connections long poll, so it moves on
 * whether or not it has focus. An account the workspace already connected is
 * offered first: the point of a connection is not pasting the token twice.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ArrowLeft, CircleAlert, CircleCheck, Figma, Github, Link2, Loader2, Plus } from 'lucide-vue-next'
import { connectionKindsFor, connectorKindInfo, type ConnectionLinkResult, type ConnectionMethod, type ConnectionProvider, type ConnectionSummary, type GithubInstallationsResponse, type ListConnectionsResponse } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { apiQueryOptions } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { Textarea } from '@/shared/ui/textarea'
import { ImportStepper } from '@/entities/rich-editor'
import { getWorkspaceId } from '@/shared/api/api'
import { INTERCOM_REGIONS, PROVIDER_GROUPS, PROVIDERS, offeredMethods, providerMeta } from '@/entities/connector/model/connection-providers'
import { openOauthTab } from '@/entities/connector/model/oauth-tab'
import { useConnectionsWait } from '@/entities/connector/model/use-connections-wait'
import { useProjectsStore } from '@/stores/projects'
import ConnectionAccount from './ConnectionAccount.vue'
import ConnectionLinkStep from './ConnectionLinkStep.vue'

const props = defineProps<{
  open: boolean
  /** Which non-token methods this deployment can complete (`ListConnectionsResponse.methods`). */
  methods: { app: boolean; oauth: boolean }
  canStoreSecrets: boolean
  connections: ConnectionSummary[]
  /** Started from a project's page: new links land there unless changed. */
  projectId?: string
}>()
const emit = defineEmits<{ 'update:open': [boolean]; connected: [ConnectionSummary] }>()

const { t, te } = useI18n()
const queryClient = useQueryClient()
const workspaceId = getWorkspaceId()
/** Where a provider tab's landing page offers to go back to. */
const RETURN_TO = '/settings/connectors?tab=connections'

type Step = 'provider' | 'signin' | 'resources' | 'done'
const step = ref<Step>('provider')
const provider = ref<ConnectionProvider | null>(null)
const method = ref<ConnectionMethod>('token')
const result = ref<ConnectionSummary | null>(null)
const links = ref<ConnectionLinkResult[]>([])

const steps = computed(() => [
  t('connectors.connections.steps.provider'),
  t('connectors.connections.steps.signin'),
  t('connectors.connections.steps.resources'),
  t('connectors.connections.steps.done'),
])
const current = computed(() => ['provider', 'signin', 'resources', 'done'].indexOf(step.value))
const meta = computed(() => (provider.value ? providerMeta(provider.value) : null))
const providerName = computed(() => meta.value?.label ?? t('connectors.connections.providers.git'))

const existing = computed(() => props.connections.filter((c) => c.provider === provider.value))
/**
 * Someone who already signed in to this provider through OAuth or the App is
 * never asked for a token: an `app` / `oauth` connection exists, or (GitHub)
 * their own GitHub sign-in is done and only the install remains.
 */
const signedIn = computed(
  () => existing.value.some((c) => c.method !== 'token') || (provider.value === 'github' && githubState.value?.connected === true),
)
/** Methods this provider has *and* this deployment can finish, without the token once the person is signed in. */
const offered = computed<ConnectionMethod[]>(() => (provider.value ? offeredMethods(provider.value, props.methods, signedIn.value) : []))
// The sign-in can land while this step is open: the token choice goes with it.
watch(offered, (now) => {
  if (now.length && !now.includes(method.value)) method.value = now[0]
})

function choose(next: ConnectionProvider) {
  provider.value = next
  // The App or OAuth when offered: no secret to paste, and it renews itself.
  method.value = offered.value.find((m) => m !== 'token') ?? 'token'
  resetToken()
  step.value = 'signin'
}

function finish(connection: ConnectionSummary) {
  wait.stop()
  result.value = connection
  links.value = []
  step.value = 'resources'
  emit('connected', connection)
}

function linked(results: ConnectionLinkResult[]) {
  links.value = results
  step.value = 'done'
  void queryClient.invalidateQueries({ queryKey: ['/v1/connectors'] })
  void queryClient.invalidateQueries({ queryKey: ['/v1/connections'] })
}

function back() {
  wait.stop()
  step.value = 'provider'
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      step.value = 'provider'
      provider.value = null
      result.value = null
    } else wait.stop()
  },
)

// --- token ---

const site = ref('')
const region = ref<keyof typeof INTERCOM_REGIONS>('us')
const secret = ref('')
const saving = ref(false)
const tokenError = ref<string | null>(null)

function resetToken() {
  site.value = ''
  region.value = 'us'
  secret.value = ''
  tokenError.value = null
}

/** The kind whose credential help describes this provider's token. */
const credentialKind = computed(() => (provider.value ? connectionKindsFor(provider.value)[0] : null))
const credentialPlaceholder = computed(() => (credentialKind.value ? connectorKindInfo(credentialKind.value)?.credentialLabel ?? '' : ''))
const credentialHelp = computed(() => {
  if (!credentialKind.value) return null
  const key = `connectors.kindText.${credentialKind.value.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}.credential`
  return te(key) ? t(key) : null
})
const siteRequired = computed(() => meta.value?.site?.kind === 'url' && !meta.value.site.optional)
const canSave = computed(() => props.canStoreSecrets && secret.value.trim() !== '' && (!siteRequired.value || site.value.trim() !== ''))

async function saveToken() {
  if (!provider.value || !canSave.value) return
  saving.value = true
  tokenError.value = null
  try {
    const siteValue = meta.value?.site?.kind === 'region' ? INTERCOM_REGIONS[region.value] : site.value.trim() || null
    const res = await api.post('/v1/connections', {
      body: { workspaceId, provider: provider.value, site: siteValue, credential: secret.value.trim() },
    })
    await queryClient.invalidateQueries({ queryKey: ['/v1/connections'] })
    finish(res.connection)
  } catch (e) {
    tokenError.value = errorMessage(e, t)
  } finally {
    saving.value = false
  }
}

// --- the App and OAuth, finished in another tab ---

const github = useQuery({
  ...apiQueryOptions('/v1/connectors/github/installations', { query: { workspaceId, returnTo: RETURN_TO } }),
  // Read for any GitHub sign-in, not only the App method: it says whether the person already signed in.
  enabled: computed(() => props.open && step.value === 'signin' && provider.value === 'github' && props.methods.app),
})
const githubState = computed(() => github.data.value as GithubInstallationsResponse | undefined)

/** What the connection list looked like when the other tab opened: a new or touched row is the answer. */
let baseline = new Map<string, string>()
const wait = useConnectionsWait(async () => {
  void github.refetch()
  const fresh = (await queryClient.fetchQuery({
    ...apiQueryOptions('/v1/connections', { query: { workspaceId } }),
    staleTime: 0,
  })) as ListConnectionsResponse
  const landed = fresh.connections.find(
    (c) => c.provider === provider.value && c.method === method.value && baseline.get(c.id) !== c.updatedAt,
  )
  if (landed) finish(landed)
})

const opening = ref(false)
const tabError = ref<string | null>(null)

async function openProvider(url: () => Promise<string | null | undefined>) {
  baseline = new Map(props.connections.map((c) => [c.id, c.updatedAt]))
  tabError.value = null
  opening.value = true
  try {
    await openOauthTab(async () => {
      const target = await url()
      if (!target) throw new Error(t('connectors.connections.methodUnavailable'))
      return target
    }, () => undefined)
    wait.start()
  } catch (e) {
    tabError.value = errorMessage(e, t)
  } finally {
    opening.value = false
  }
}

const connectFigma = () =>
  openProvider(async () => (await api.get('/v1/connectors/figma/authorize', { query: { workspaceId, returnTo: RETURN_TO } })).url)
const signInGithub = () => openProvider(async () => githubState.value?.authorizeUrl)
const installGithub = () => openProvider(async () => githubState.value?.installUrl)

const projects = useProjectsStore()
const projectNameOf = (id: string) => projects.items.find((p) => p.projectId === id)?.name ?? id

function close() {
  emit('update:open', false)
}
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="max-sm:h-dvh max-sm:max-w-none max-sm:overflow-y-auto max-sm:rounded-none sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{{ t('connectors.connections.addTitle') }}</DialogTitle>
        <DialogDescription>{{ t('connectors.connections.addBody') }}</DialogDescription>
      </DialogHeader>

      <ImportStepper :current="current" :steps="steps" :label="t('connectors.steps')" class="kn-scroll-strip overflow-x-auto pb-1" />

      <!-- 1. Which system. Grouped by what it holds, which is how people look for it. -->
      <div v-if="step === 'provider'" class="space-y-4">
        <section v-for="group in PROVIDER_GROUPS" :key="group" class="space-y-2">
          <h3 class="text-muted-foreground text-xs font-medium">{{ t(`connectors.connections.groups.${group}`) }}</h3>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <button
              v-for="p in PROVIDERS.filter((x) => x.group === group)"
              :key="p.provider"
              type="button"
              class="hover:bg-muted focus-visible:ring-ring flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2.5 text-start transition-colors focus-visible:ring-2 focus-visible:outline-none"
              @click="choose(p.provider)"
            >
              <component :is="p.icon" class="size-4 shrink-0" aria-hidden="true" />
              <span class="min-w-0">
                <span class="block text-sm leading-snug font-medium text-pretty">{{ p.label ?? t('connectors.connections.providers.git') }}</span>
                <span v-if="connections.some((c) => c.provider === p.provider)" class="text-muted-foreground block truncate text-xs">
                  {{ t('connectors.connections.connectedCount', { count: connections.filter((c) => c.provider === p.provider).length }, connections.filter((c) => c.provider === p.provider).length) }}
                </span>
              </span>
            </button>
          </div>
        </section>
      </div>

      <!-- 2. Sign in: reuse an account, paste a token, or go to the provider. -->
      <div v-else-if="step === 'signin' && provider" class="space-y-5">
        <button type="button" class="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs" @click="back">
          <ArrowLeft class="size-3.5" aria-hidden="true" /> {{ t('connectors.connections.otherProvider') }}
        </button>

        <section v-if="existing.length" class="space-y-2">
          <h3 class="text-sm font-medium">{{ t('connectors.connections.alreadyConnected', { provider: providerName }) }}</h3>
          <ul class="divide-y rounded-lg border">
            <li v-for="c in existing" :key="c.id" class="flex items-center gap-3 p-2.5">
              <ConnectionAccount :connection="c" class="min-w-0 flex-1" />
              <Button size="sm" variant="outline" @click="finish(c)">{{ t('connectors.connections.use') }}</Button>
            </li>
          </ul>
          <p class="text-muted-foreground text-xs">{{ t('connectors.connections.orAnother') }}</p>
        </section>

        <!-- Shown only when there is a choice: with every App/OAuth key empty, a token is the whole flow. -->
        <div v-if="offered.length > 1" role="group" :aria-label="t('connectors.connections.methodLabel')" class="bg-muted inline-flex rounded-lg p-0.5">
          <button
            v-for="m in offered"
            :key="m"
            type="button"
            :aria-pressed="method === m"
            class="focus-visible:ring-ring rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
            :class="method === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            @click="method = m; wait.stop()"
          >
            {{ t(`connectors.connections.methodChoice.${m}`) }}
          </button>
        </div>

        <!-- Token -->
        <form v-if="method === 'token'" class="space-y-3" @submit.prevent="saveToken">
          <label v-if="meta?.site?.kind === 'url'" class="block space-y-1.5">
            <span class="text-sm font-medium">{{ t('connectors.connections.site') }}</span>
            <Input v-model="site" type="url" inputmode="url" autocomplete="off" :placeholder="meta.site.placeholder" />
            <span v-if="meta.site.optional" class="text-muted-foreground block text-xs">{{ t('connectors.connections.siteOptional', { site: meta.site.placeholder }) }}</span>
          </label>
          <label v-else-if="meta?.site?.kind === 'region'" class="block space-y-1.5">
            <span class="text-sm font-medium">{{ t('connectors.connections.region') }}</span>
            <Select v-model="region">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="r in Object.keys(INTERCOM_REGIONS)" :key="r" :value="r">{{ t(`connectors.connections.regions.${r}`) }}</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <label class="block space-y-1.5">
            <span class="text-sm font-medium">{{ t('connectors.credential') }}</span>
            <Textarea
              v-if="provider === 'google'"
              v-model="secret"
              rows="4"
              class="font-mono text-xs"
              spellcheck="false"
              :placeholder="credentialPlaceholder"
              :disabled="!canStoreSecrets"
              :aria-invalid="tokenError ? 'true' : undefined"
            />
            <Input
              v-else
              v-model="secret"
              type="password"
              autocomplete="off"
              :placeholder="credentialPlaceholder"
              :disabled="!canStoreSecrets"
              :aria-invalid="tokenError ? 'true' : undefined"
            />
            <span v-if="credentialHelp" class="text-muted-foreground block text-xs">{{ credentialHelp }}</span>
            <span v-if="provider !== 'git'" class="text-muted-foreground block text-xs">{{ t('connectors.connections.identifyHint') }}</span>
          </label>
          <p v-if="!canStoreSecrets" class="text-panel-warning-ink text-xs" role="status">{{ t('connectors.connections.noKey') }}</p>
          <p v-if="tokenError" class="text-destructive text-xs" role="alert">{{ tokenError }}</p>
          <div class="flex justify-end">
            <Button type="submit" :disabled="!canSave || saving">
              <Loader2 v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              {{ saving ? t('connectors.connections.checking', { provider: providerName }) : t('connectors.connections.connect') }}
            </Button>
          </div>
        </form>

        <!-- GitHub App: a person's GitHub sign-in first (it decides which installations they may browse), then the install. -->
        <div v-else-if="method === 'app'" class="space-y-3">
          <div v-if="github.isPending.value" class="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 class="size-4 animate-spin" aria-hidden="true" /> {{ t('connectors.github.loading') }}
          </div>
          <template v-else-if="!githubState?.connected">
            <Button class="w-full" variant="outline" :disabled="opening" @click="signInGithub">
              <Github class="size-4" aria-hidden="true" /> {{ t('connectors.github.connect') }}
            </Button>
            <p class="text-muted-foreground text-xs">{{ t('connectors.github.connectHint') }}</p>
          </template>
          <template v-else>
            <Button class="w-full" variant="outline" :disabled="opening" @click="installGithub">
              <Plus class="size-4" aria-hidden="true" /> {{ t('connectors.github.install') }}
            </Button>
            <p class="text-muted-foreground text-xs">{{ t('connectors.connections.installHint') }}</p>
          </template>
        </div>

        <!-- Figma OAuth -->
        <div v-else-if="method === 'oauth'" class="space-y-3">
          <Button class="w-full" variant="outline" :disabled="opening" @click="connectFigma">
            <Figma class="size-4" aria-hidden="true" /> {{ t('connectors.figmaAccess.connect') }}
          </Button>
          <p class="text-muted-foreground text-xs">{{ t('connectors.connections.oauthHint') }}</p>
        </div>

        <p v-if="tabError" class="text-destructive text-xs" role="alert">{{ tabError }}</p>
        <!-- The other tab is the slow part; say this one is listening for it. -->
        <div v-if="wait.waiting.value" class="bg-muted/50 flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm" role="status" aria-live="polite">
          <Loader2 class="text-muted-foreground size-4 shrink-0 animate-spin" aria-hidden="true" />
          <span class="min-w-0 flex-1">{{ t('connectors.connections.waiting', { provider: providerName }) }}</span>
          <Button size="sm" variant="ghost" @click="wait.check()">{{ t('connectors.connections.checkAgain') }}</Button>
        </div>
      </div>

      <!-- 3. What it reaches, and where each lands. -->
      <div v-else-if="step === 'resources' && result" class="space-y-4">
        <div class="rounded-lg border p-3"><ConnectionAccount :connection="result" /></div>
        <ConnectionLinkStep :connection="result" :project-id="projectId" @linked="linked" @skip="step = 'done'" />
      </div>

      <!-- 4. Done: one line per pair, each to its connector, where schedule and direction are finished. -->
      <div v-else-if="step === 'done' && result" class="space-y-4">
        <p class="flex items-center gap-2 text-sm font-medium">
          <CircleCheck class="text-primary size-4 shrink-0" aria-hidden="true" /> {{ t('connectors.connections.ready') }}
        </p>
        <div class="rounded-lg border p-3"><ConnectionAccount :connection="result" /></div>
        <ul v-if="links.length" class="divide-y rounded-lg border text-sm">
          <li v-for="(r, i) in links" :key="i" class="flex min-w-0 items-start gap-2.5 px-3 py-2">
            <component :is="r.status === 'failed' ? CircleAlert : r.status === 'created' ? CircleCheck : Link2" class="mt-0.5 size-4 shrink-0" :class="r.status === 'failed' ? 'text-destructive' : r.status === 'created' ? 'text-primary' : 'text-muted-foreground'" aria-hidden="true" />
            <span class="min-w-0 flex-1">
              <span class="block truncate" :title="r.label">{{ r.label }} → {{ projectNameOf(r.projectId) }}</span>
              <span class="text-muted-foreground block text-xs">
                {{ r.status === 'failed' ? r.error : t(`connectors.link.results.${r.status}`) }}
              </span>
            </span>
            <RouterLink v-if="r.connectorId" :to="`/settings/connectors/${r.connectorId}`" class="shrink-0 text-xs underline-offset-2 hover:underline" @click="close">
              {{ t('connectors.link.open') }}
            </RouterLink>
          </li>
        </ul>
        <p class="text-muted-foreground text-sm">{{ links.length ? t('connectors.link.finishHint') : t('connectors.connections.readyBody') }}</p>
        <div class="flex justify-end">
          <Button @click="close">{{ t('common.close') }}</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
