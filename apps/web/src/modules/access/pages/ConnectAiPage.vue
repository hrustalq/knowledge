<script setup lang="ts">
/**
 * Connect an AI client to this knowledge base (docs/features/33).
 *
 * The `connect` section of /settings/ai (issue #182) — it was its own settings
 * row until then, and `/settings/connect` still redirects here. Its `<h1>` is
 * the section's, as every other section's is.
 *
 * Numbered steps, because that is the order the work has to happen in and
 * each one needs something from the one before: a key, then a client
 * configured with that key, then the skill that tells the client's model how
 * to use what it can now reach, then (issue #73) the capture kit that has it
 * offer back what a session learned. Numbered cards rather than one long form so a
 * person coming back to add a second client can skip straight to step 2.
 *
 * The key minted on this page is the only moment the plaintext exists outside
 * the client. Every snippet below picks it up while it is on screen — the ones
 * that read an env var show the `export` line with it, the ones that cannot
 * (Claude Desktop, Zed) get it inline — and it is gone on reload, by design.
 *
 * Everything here acts on the caller. Keys are yours; the skill is generated
 * for your workspaces; the tool list is what *your* credential would be
 * offered. Nothing on this page needs a workspace role.
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { ChevronRight, Download, ExternalLink, FileCode, FileText, KeyRound, Plus, Settings2, TriangleAlert } from 'lucide-vue-next'
import type {
  ApiKeyInfo,
  ApiKeyScope,
  CaptureKitClient,
  CaptureKitFile,
  CaptureKitResponse,
  McpConnectionInfo,
  ProjectSummary,
} from '@knowledge/contracts'
import { API_KEY_SCOPES, CAPTURE_KIT_CLIENTS } from '@knowledge/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { api, fetchApi, isApiRequestError } from '@/shared/api/queries'
import { getProjectId, getWorkspaceId, saveFile } from '@/shared/api/api'
import { formatDate, formatRelative } from '@/shared/utils/format'
import { KEY_ENV, SKILL_NAME, captureKitFileRole, captureKitInstallCommand, mcpClients, skillInstallCommand } from '@/entities/access'
import { useWorkspacesStore } from '@/stores/workspaces'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Badge } from '@/shared/ui/badge'
import { Skeleton } from '@/shared/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog'
import { CopyBlock } from '@/entities/access'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const workspaces = useWorkspacesStore()
const projects = useProjectsStore()
const queryClient = useQueryClient()

const connection = ref<McpConnectionInfo | null>(null)
const keys = ref<ApiKeyInfo[]>([])
const skill = ref<string | null>(null)
const loading = ref(true)

/** The server takes keys; a sign-in session manages them. Dev mode has neither. */
const needsKey = computed(() => connection.value?.authMode === 'api-key')

onMounted(async () => {
  origin.value = window.location.origin
  workspaces.ensureLoaded()
  try {
    const [info, md] = await Promise.all([
      fetchApi(queryClient, '/v1/mcp/connection'),
      api.get('/v1/mcp/skill', { config: { responseType: 'text' } }) as unknown as Promise<string>,
    ])
    connection.value = info
    skill.value = md
    if (info.authMode === 'api-key') keys.value = (await fetchApi(queryClient, '/v1/me/api-keys', {}, { fresh: true })).keys
  } catch {
    toast.error(t('connect.loadFailed'))
  } finally {
    loading.value = false
  }
})

/* ------------------------------------------------------------- step 1: key */

const EXPIRY_CHOICES = ['never', '30', '90', '365'] as const
const ALL_WORKSPACES = 'all'

const form = reactive({
  name: '',
  scope: 'write' as ApiKeyScope,
  workspaceId: ALL_WORKSPACES,
  expiry: 'never' as (typeof EXPIRY_CHOICES)[number],
  /** A `capture` key's project pin (issue #73). Empty = every project. */
  projectIds: [] as string[],
})

/*
 * The pin is offered only on a `capture` key — the API refuses it on any other
 * scope — and lists the projects of the workspace the key is pinned to, or of
 * the current one when it is not. Switching either clears it, so a pin can
 * never carry ids the list above it no longer shows.
 */
const pinProjects = ref<ProjectSummary[]>([])
const pinWorkspace = computed(() => (form.workspaceId === ALL_WORKSPACES ? getWorkspaceId() : form.workspaceId))

watch(
  [() => form.scope, pinWorkspace],
  async ([scope, ws], [prevScope, prevWs]) => {
    if (scope !== prevScope || ws !== prevWs) form.projectIds = []
    if (scope !== 'capture') return
    try {
      pinProjects.value = (await fetchApi(queryClient, '/v1/projects', { query: { workspaceId: ws } })).projects
    } catch {
      pinProjects.value = []
    }
  },
)

function togglePin(projectId: string) {
  form.projectIds = form.projectIds.includes(projectId)
    ? form.projectIds.filter((id) => id !== projectId)
    : [...form.projectIds, projectId]
}

/** A pinned project's name, when this page has met it; otherwise the start of its id. */
function projectName(id: string): string {
  return (
    pinProjects.value.find((p) => p.projectId === id)?.name ??
    projects.items.find((p) => p.projectId === id)?.name ??
    id.slice(0, 8)
  )
}
const creating = ref(false)
const fresh = ref<{ key: ApiKeyInfo; apiKey: string } | null>(null)

async function createKey() {
  if (!form.name.trim()) return
  creating.value = true
  try {
    const res = await api.post('/v1/me/api-keys', {
      body: {
        name: form.name.trim(),
        scope: form.scope,
        ...(form.workspaceId !== ALL_WORKSPACES ? { workspaceId: form.workspaceId } : {}),
        ...(form.expiry !== 'never' ? { expiresInDays: Number(form.expiry) } : {}),
        ...(form.scope === 'capture' && form.projectIds.length ? { projectIds: form.projectIds } : {}),
      },
    })
    fresh.value = { key: res.key, apiKey: res.apiKey }
    keys.value = [res.key, ...keys.value]
    form.name = ''
    // The skill names the workspaces and tools of the credential that fetches
    // it — so fetch it as the new key, and a read-only or pinned key gets the
    // skill that describes exactly what it can do.
    await refreshSkill(res.apiKey)
  } catch (e) {
    toast.error((e as Error).message || t('connect.keys.createFailed'))
  } finally {
    creating.value = false
  }
}

const revoking = ref<ApiKeyInfo | null>(null)

/**
 * Where what a key proposed is reviewed (issue #235): the captures inbox
 * narrowed to it. Only a key that may capture has anything there, and only in
 * the workspace open now — the inbox is that workspace's.
 */
function capturesOf(key: ApiKeyInfo): string | null {
  if (key.scope === 'read' || (key.workspaceId && key.workspaceId !== getWorkspaceId())) return null
  return `/captures?apiKeyId=${key.id}`
}

async function revoke() {
  const key = revoking.value
  if (!key) return
  try {
    await api.delete('/v1/me/api-keys/{keyId}', { path: { keyId: key.id } })
    keys.value = keys.value.filter((k) => k.id !== key.id)
    if (fresh.value?.key.id === key.id) fresh.value = null
    // Revoking stops new captures and leaves the old ones pending: point at them
    // rather than rejecting them, since a revoked key's past output may be good.
    const review = capturesOf(key)
    toast.success(t('connect.keys.revoked', { name: key.name }), {
      ...(review ? { action: { label: t('connect.keys.reviewCaptures'), onClick: () => void router.push(review) } } : {}),
    })
  } catch (e) {
    toast.error((e as Error).message || t('connect.keys.revokeFailed'))
  } finally {
    revoking.value = null
  }
}

function workspaceName(id: string | null): string {
  if (!id) return t('connect.keys.allWorkspaces')
  return workspaces.items.find((w) => w.workspaceId === id)?.name ?? id.slice(0, 8)
}

/* ---------------------------------------------------------- step 2: client */

const clients = computed(() =>
  connection.value
    ? mcpClients({
        url: connection.value.url,
        serverName: connection.value.serverName,
        auth: needsKey.value,
        key: fresh.value?.apiKey ?? null,
      })
    : [],
)

// `?client=` is an opening instruction, not two-way state (house rule for tabs).
const clientId = ref(typeof route.query.client === 'string' ? route.query.client : 'claude-code')
const client = computed(() => clients.value.find((c) => c.id === clientId.value) ?? clients.value[0])

const exportLine = computed(() => `export ${KEY_ENV}=${fresh.value?.apiKey ?? '<your-api-key>'}`)

/* ----------------------------------------------------------- step 3: skill */

const skillUrl = computed(() => (connection.value ? `${connection.value.url}/skill` : ''))
const skillLines = computed(() => skill.value?.split('\n').length ?? 0)
const showSkill = ref(false)

async function refreshSkill(asKey: string) {
  try {
    // Plain api.get, not the cache: the query key carries no credential, so a
    // read as the new key would collide with the session's answer.
    skill.value = (await api.get('/v1/mcp/skill', {
      config: { responseType: 'text', headers: { Authorization: `Bearer ${asKey}` } },
    })) as unknown as string
  } catch {
    /* the session's copy stays; it only over-describes a narrower key */
  }
}

function downloadSkill() {
  if (!skill.value) return
  saveFile(new Blob([skill.value], { type: 'text/markdown' }), 'SKILL.md')
}

/* ---------------------------------------------------- step 4: capture kit */

// The kit follows the client picked in step 2 when that client has one, and
// keeps its own pick otherwise — the other clients capture through the skill.
const kitPick = ref<CaptureKitClient>('claude-code')
watch(
  () => client.value?.captureKit,
  (kit) => {
    if (kit) kitPick.value = kit
  },
  { immediate: true },
)
const kitName = (id: CaptureKitClient) => clients.value.find((c) => c.captureKit === id)?.name ?? id

const kitUrl = computed(() => (connection.value ? `${connection.value.url}/capture-kit` : ''))
const kit = ref<CaptureKitResponse | null>(null)
/** `refused`: the credential is offered no capture tools, so the server will not render a kit for it. */
const kitState = ref<'idle' | 'loading' | 'ready' | 'refused' | 'failed'>('idle')
const openFile = ref<string | null>(null)

// Fetched as the key just minted when there is one, like the skill: a read
// key is refused a kit, and a pinned capture key's kit names only its projects.
watch(
  [() => connection.value, kitPick, () => fresh.value?.apiKey],
  async ([info, pick, asKey]) => {
    if (!info) return
    kitState.value = 'loading'
    openFile.value = null
    try {
      // Not cached, for the skill's reason: the answer depends on the credential.
      kit.value = await api.get('/v1/mcp/capture-kit', {
        query: { client: pick },
        ...(asKey ? { config: { headers: { Authorization: `Bearer ${asKey}` } } } : {}),
      })
      kitState.value = 'ready'
    } catch (e) {
      kit.value = null
      kitState.value = isApiRequestError(e) && e.status === 403 ? 'refused' : 'failed'
    }
  },
  { immediate: true },
)

const KIT_FILE_ICON = { instructions: FileText, script: FileCode, entries: Settings2 } as const

function toggleFile(file: CaptureKitFile) {
  openFile.value = openFile.value === file.path ? null : file.path
}

/* ---------------------------------------------------------------- llms.txt */

// The web origin serves llms.txt and `.md` pages (issue #68). Set on mount —
// the SSR pass has no `window` and renders the card without URLs.
const origin = ref('')

interface LlmsUrl {
  label: string
  url: string
}

const llmsUrls = computed<LlmsUrl[]>(() => {
  if (!origin.value) return []
  const ws = getWorkspaceId()
  const proj = getProjectId()
  const wsLabel = t('connect.llms.workspace', { name: workspaceName(ws) })
  const out: LlmsUrl[] = [
    { label: t('connect.llms.root'), url: `${origin.value}/llms.txt` },
    { label: wsLabel, url: `${origin.value}/workspaces/${ws}/llms.txt` },
    { label: t('connect.llms.full', { scope: wsLabel }), url: `${origin.value}/workspaces/${ws}/llms-full.txt` },
  ]
  if (proj) {
    const projLabel = t('connect.llms.project', { name: projects.active?.name ?? proj.slice(0, 8) })
    out.push(
      { label: projLabel, url: `${origin.value}/projects/${proj}/llms.txt` },
      { label: t('connect.llms.full', { scope: projLabel }), url: `${origin.value}/projects/${proj}/llms-full.txt` },
    )
  }
  return out
})

// The key rides in a header, never in the URL, where it would end up in logs.
const llmsCurl = computed(() =>
  origin.value
    ? `curl -H "Authorization: Bearer $${KEY_ENV}" ${origin.value}/workspaces/${getWorkspaceId()}/llms.txt`
    : '',
)

const readTools = computed(() => connection.value?.tools.filter((tool) => tool.readOnly) ?? [])
const writeTools = computed(() => connection.value?.tools.filter((tool) => !tool.readOnly) ?? [])
</script>

<template>
  <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-5">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('connect.title') }}</h1>
      <p class="kn-measure mt-1 text-sm text-muted-foreground">{{ t('connect.subtitle') }}</p>
    </div>

    <div v-if="loading" class="grid gap-5">
      <Skeleton class="h-40 w-full rounded-xl" />
      <Skeleton class="h-72 w-full rounded-xl" />
    </div>

    <template v-else-if="connection">
      <!-- The endpoint: the one value every client config below contains. -->
      <section class="min-w-0 rounded-xl border bg-card px-5 py-4">
        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 class="font-display text-base font-semibold tracking-tight">{{ t('connect.endpoint.title') }}</h2>
          <span class="text-xs text-muted-foreground">
            {{ t('connect.endpoint.meta', { version: connection.version, tools: connection.tools.length }) }}
          </span>
        </div>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t('connect.endpoint.hint') }}</p>
        <div class="mt-3"><CopyBlock :code="connection.url" label="Streamable HTTP" /></div>
      </section>

      <!-- Step 1 ---------------------------------------------------------- -->
      <section class="min-w-0 rounded-xl border bg-card">
        <h2 class="flex items-center gap-2.5 border-b px-5 py-3.5 font-display text-base font-semibold tracking-tight">
          <span class="kn-step">1</span>{{ t('connect.keys.title') }}
        </h2>

        <p v-if="!needsKey" class="px-5 py-4 text-sm text-muted-foreground">{{ t('connect.keys.devMode') }}</p>

        <div v-else class="grid gap-5 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <form class="grid content-start gap-3" @submit.prevent="createKey">
            <p class="text-xs text-muted-foreground">{{ t('connect.keys.hint') }}</p>
            <div class="grid gap-1.5">
              <Label for="kn-key-name" class="text-xs">{{ t('connect.keys.name') }}</Label>
              <Input id="kn-key-name" v-model="form.name" :placeholder="t('connect.keys.namePlaceholder')" maxlength="80" />
            </div>
            <div class="grid gap-3 sm:grid-cols-3">
              <div class="grid gap-1.5">
                <Label for="kn-key-scope" class="text-xs">{{ t('connect.keys.scope') }}</Label>
                <Select v-model="form.scope">
                  <SelectTrigger id="kn-key-scope" class="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="s in API_KEY_SCOPES" :key="s" :value="s">{{ t(`connect.keys.scopes.${s}`) }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="grid gap-1.5">
                <Label for="kn-key-ws" class="text-xs">{{ t('connect.keys.workspace') }}</Label>
                <Select v-model="form.workspaceId">
                  <SelectTrigger id="kn-key-ws" class="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="ALL_WORKSPACES">{{ t('connect.keys.allWorkspaces') }}</SelectItem>
                    <SelectItem v-for="w in workspaces.items" :key="w.workspaceId" :value="w.workspaceId">
                      {{ w.name }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="grid gap-1.5">
                <Label for="kn-key-exp" class="text-xs">{{ t('connect.keys.expiry') }}</Label>
                <Select v-model="form.expiry">
                  <SelectTrigger id="kn-key-exp" class="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="e in EXPIRY_CHOICES" :key="e" :value="e">
                      {{ e === 'never' ? t('connect.keys.never') : t('connect.keys.days', { n: e }) }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p class="text-caption text-muted-foreground">{{ t(`connect.keys.scopeHint.${form.scope}`) }}</p>

            <!-- Where a capture key may propose. Toggles rather than a
                 multi-select: a workspace has a handful of projects, and seeing
                 them all at once is the decision. -->
            <fieldset v-if="form.scope === 'capture'" class="grid gap-1.5">
              <legend class="text-xs font-medium">{{ t('connect.keys.projects') }}</legend>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="p in pinProjects"
                  :key="p.projectId"
                  type="button"
                  class="rounded-md border px-2.5 py-0.5 text-xs transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring"
                  :class="form.projectIds.includes(p.projectId)
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
                  :aria-pressed="form.projectIds.includes(p.projectId)"
                  @click="togglePin(p.projectId)"
                >
                  {{ p.name }}
                </button>
              </div>
              <p class="text-caption text-muted-foreground">
                {{ form.projectIds.length
                  ? t('connect.keys.projectsPinned', { n: form.projectIds.length }, form.projectIds.length)
                  : t('connect.keys.projectsAll') }}
              </p>
            </fieldset>
            <div>
              <Button type="submit" size="sm" class="gap-1.5" :disabled="creating || !form.name.trim()">
                <Plus class="size-3.5" />
                {{ creating ? t('connect.keys.creating') : t('connect.keys.create') }}
              </Button>
            </div>

            <!-- The one and only sighting of the value. -->
            <div v-if="fresh" class="grid gap-2 rounded-lg border border-dashed kn-callout-warning p-3">
              <p class="flex items-start gap-2 text-xs text-panel-warning-ink">
                <TriangleAlert class="size-3.5 shrink-0 translate-y-0.5" aria-hidden="true" />
                <span>{{ t('connect.keys.onceOnly', { name: fresh.key.name }) }}</span>
              </p>
              <CopyBlock :code="fresh.apiKey" label="API key" secret />
              <CopyBlock :code="exportLine" :label="t('connect.keys.shellProfile')" />
            </div>
          </form>

          <div class="min-w-0">
            <h3 class="text-xs font-medium text-muted-foreground">{{ t('connect.keys.active', { n: keys.length }) }}</h3>
            <p v-if="!keys.length" class="mt-2 rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
              {{ t('connect.keys.empty') }}
            </p>
            <ul v-else class="mt-2 divide-y rounded-lg border">
              <li v-for="k in keys" :key="k.id" class="flex items-start gap-3 px-3 py-2.5">
                <KeyRound class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="truncate text-sm font-medium">{{ k.name }}</span>
                    <Badge :variant="k.scope === 'read' ? 'secondary' : 'outline'">{{ t(`connect.keys.scopes.${k.scope}`) }}</Badge>
                    <Badge v-if="k.workspaceId" variant="outline">{{ workspaceName(k.workspaceId) }}</Badge>
                    <Badge v-for="id in k.projectIds ?? []" :key="id" variant="outline" class="font-normal">{{ projectName(id) }}</Badge>
                  </div>
                  <p class="mt-0.5 text-caption text-muted-foreground">
                    <code class="font-mono">{{ k.prefix }}…</code>
                    · {{ k.lastUsedAt ? t('connect.keys.lastUsed', { when: formatRelative(k.lastUsedAt) }) : t('connect.keys.neverUsed') }}
                    · {{ k.expiresAt ? t('connect.keys.expires', { when: formatDate(k.expiresAt) }) : t('connect.keys.noExpiry') }}
                    <template v-if="capturesOf(k)">
                      · <RouterLink :to="capturesOf(k)!" class="text-primary underline underline-offset-2">{{ t('connect.keys.captures') }}</RouterLink>
                    </template>
                  </p>
                </div>
                <Button variant="ghost" size="sm" class="shrink-0 text-destructive hover:text-destructive" @click="revoking = k">
                  {{ t('connect.keys.revoke') }}
                </Button>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <!-- Step 2 ---------------------------------------------------------- -->
      <section class="min-w-0 rounded-xl border bg-card">
        <h2 class="flex items-center gap-2.5 border-b px-5 py-3.5 font-display text-base font-semibold tracking-tight">
          <span class="kn-step">2</span>{{ t('connect.clients.title') }}
        </h2>

        <!-- Hand-rolled tab strip (no tab library in this app). -->
        <div role="tablist" class="kn-scroll-strip flex gap-1 overflow-x-auto border-b px-3 py-2">
          <button
            v-for="c in clients"
            :key="c.id"
            type="button"
            role="tab"
            :aria-selected="c.id === client?.id"
            class="shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors"
            :class="c.id === client?.id ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'"
            @click="clientId = c.id"
          >
            {{ c.name }}
          </button>
        </div>

        <div v-if="client" role="tabpanel" class="grid gap-3 px-5 py-4">
          <p class="text-xs text-muted-foreground">
            {{ t(`connect.clients.notes.${client.note}`) }}
            <a :href="client.docs" target="_blank" rel="noopener noreferrer" class="ml-1 inline-flex items-center gap-0.5 text-primary underline underline-offset-2">
              {{ t('connect.clients.docs') }}<ExternalLink class="size-3" aria-hidden="true" />
            </a>
          </p>

          <CopyBlock v-if="client.usesEnv" :code="exportLine" :label="t('connect.clients.step.env')" />
          <CopyBlock v-if="client.command" :code="client.command" :label="t('connect.clients.step.command')" />
          <p v-if="client.command" class="text-caption text-muted-foreground">{{ t('connect.clients.orEdit') }}</p>
          <CopyBlock :code="client.config.code" :label="client.config.path" :secret="!client.usesEnv && !!fresh" />
          <p v-if="needsKey && !client.usesEnv && client.id !== 'vscode' && !fresh" class="text-caption text-panel-warning-ink">
            {{ t('connect.clients.placeholder') }}
          </p>
        </div>
      </section>

      <!-- Step 3 ---------------------------------------------------------- -->
      <section class="min-w-0 rounded-xl border bg-card">
        <h2 class="flex items-center gap-2.5 border-b px-5 py-3.5 font-display text-base font-semibold tracking-tight">
          <span class="kn-step">3</span>{{ t('connect.skill.title') }}
        </h2>
        <div class="grid gap-3 px-5 py-4">
          <p class="max-w-3xl text-xs text-muted-foreground">{{ t('connect.skill.hint') }}</p>

          <div class="flex flex-wrap gap-2">
            <Button size="sm" class="gap-1.5" :disabled="!skill" @click="downloadSkill">
              <Download class="size-3.5" />{{ t('connect.skill.download') }}
            </Button>
            <Button variant="outline" size="sm" @click="showSkill = !showSkill">
              {{ showSkill ? t('connect.skill.hide') : t('connect.skill.preview', { n: skillLines }) }}
            </Button>
          </div>

          <CopyBlock v-if="client?.skillDir" :code="skillInstallCommand(skillUrl, client.skillDir, needsKey)" :label="t('connect.skill.installFor', { client: client.name, path: `${client.skillDir}/${SKILL_NAME}/SKILL.md` })" />
          <p v-else-if="client" class="text-caption text-muted-foreground">{{ t('connect.skill.noSkillDir', { client: client.name }) }}</p>
          <p class="text-caption text-muted-foreground">{{ t('connect.skill.alsoServed') }}</p>

          <CopyBlock v-if="showSkill && skill" :code="skill" label="SKILL.md" />
        </div>
      </section>

      <!-- Step 4 ---------------------------------------------------------- -->
      <section class="min-w-0 rounded-xl border bg-card">
        <h2 class="flex items-center gap-2.5 border-b px-5 py-3.5 font-display text-base font-semibold tracking-tight">
          <span class="kn-step">4</span>{{ t('connect.capture.title') }}
        </h2>

        <!-- Two kits only, so a segmented pick rather than step 2's strip. -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-2">
          <div role="tablist" :aria-label="t('connect.capture.title')" class="flex gap-1">
            <button
              v-for="id in CAPTURE_KIT_CLIENTS"
              :key="id"
              type="button"
              role="tab"
              :aria-selected="id === kitPick"
              class="shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors"
              :class="id === kitPick ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'"
              @click="kitPick = id"
            >
              {{ kitName(id) }}
            </button>
          </div>
          <p v-if="client && !client.captureKit" class="text-caption text-muted-foreground">
            {{ t('connect.capture.noKit', { client: client.name }) }}
          </p>
        </div>

        <div role="tabpanel" class="grid gap-3 px-5 py-4">
          <p class="max-w-3xl text-xs text-muted-foreground">{{ t('connect.capture.hint', { client: kitName(kitPick) }) }}</p>

          <template v-if="kitState === 'loading' && !kit">
            <Skeleton class="h-14 w-full rounded-lg" />
            <Skeleton class="h-28 w-full rounded-lg" />
          </template>

          <p
            v-else-if="kitState === 'refused'"
            class="flex max-w-3xl items-start gap-2 rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground"
          >
            <KeyRound class="size-3.5 shrink-0 translate-y-0.5" aria-hidden="true" />
            <span>{{ t('connect.capture.refused') }}</span>
          </p>

          <p v-else-if="kitState === 'failed'" class="text-xs text-destructive">{{ t('connect.capture.loadFailed') }}</p>

          <template v-else-if="kit">
            <CopyBlock
              :code="captureKitInstallCommand(kitUrl, kit.client, needsKey)"
              :label="t('connect.capture.installLabel')"
            />

            <div class="min-w-0">
              <h3 class="text-xs font-medium text-muted-foreground">{{ t('connect.capture.filesTitle', { n: kit.files.length }) }}</h3>
              <ul class="mt-1.5 divide-y rounded-lg border">
                <li v-for="file in kit.files" :key="file.path" class="min-w-0">
                  <button
                    type="button"
                    class="flex w-full min-w-0 items-start gap-3 px-3 py-2.5 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring"
                    :aria-expanded="openFile === file.path"
                    @click="toggleFile(file)"
                  >
                    <component
                      :is="KIT_FILE_ICON[captureKitFileRole(file)]"
                      class="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span class="min-w-0 flex-1">
                      <span class="flex flex-wrap items-center gap-1.5">
                        <code class="truncate font-mono text-xs font-medium">{{ file.path }}</code>
                        <Badge v-if="file.mode === 'merge'" variant="outline" class="font-normal">{{ t('connect.capture.merged') }}</Badge>
                      </span>
                      <span class="mt-0.5 block text-caption text-muted-foreground">
                        {{ t(`connect.capture.files.${captureKitFileRole(file)}`) }}
                      </span>
                    </span>
                    <ChevronRight
                      class="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none"
                      :class="openFile === file.path ? 'rotate-90' : ''"
                      aria-hidden="true"
                    />
                  </button>
                  <div v-if="openFile === file.path" class="px-3 pb-3">
                    <CopyBlock :code="file.content" :label="file.path" />
                  </div>
                </li>
              </ul>
            </div>

            <p class="text-caption text-muted-foreground">
              {{ t('connect.capture.footnote', { version: kit.version }) }}
              <RouterLink to="/captures" class="ml-1 text-primary underline underline-offset-2">{{ t('connect.capture.review') }}</RouterLink>
            </p>
          </template>
        </div>
      </section>

      <!-- Plain HTTP for tools that fetch URLs instead of speaking MCP. ------ -->
      <section class="min-w-0 rounded-xl border bg-card px-5 py-4">
        <h2 class="flex items-center gap-2 font-display text-base font-semibold tracking-tight">
          <FileText class="size-4 text-muted-foreground" aria-hidden="true" />{{ t('connect.llms.title') }}
        </h2>
        <p class="mt-0.5 max-w-3xl text-xs text-muted-foreground">{{ t('connect.llms.hint') }}</p>
        <div v-if="llmsUrls.length" class="mt-3 grid gap-2">
          <CopyBlock v-for="u in llmsUrls" :key="u.url" :code="u.url" :label="u.label" />
          <CopyBlock v-if="needsKey" :code="llmsCurl" :label="t('connect.llms.curl')" />
        </div>
      </section>

      <!-- What the credential gets. ------------------------------------------ -->
      <section class="min-w-0 rounded-xl border bg-card px-5 py-4">
        <h2 class="font-display text-base font-semibold tracking-tight">{{ t('connect.tools.title') }}</h2>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t('connect.tools.hint') }}</p>
        <div class="mt-3 grid gap-4 md:grid-cols-2">
          <div v-for="group in [{ key: 'read', tools: readTools }, { key: 'write', tools: writeTools }]" :key="group.key" class="min-w-0">
            <h3 class="text-xs font-medium text-muted-foreground">{{ t(`connect.tools.${group.key}`, { n: group.tools.length }) }}</h3>
            <ul class="mt-1.5 space-y-1.5">
              <li v-for="tool in group.tools" :key="tool.name" class="min-w-0 text-xs">
                <code class="font-mono text-caption font-medium">{{ tool.name }}</code>
                <p class="line-clamp-2 text-muted-foreground">{{ tool.description }}</p>
              </li>
              <li v-if="!group.tools.length" class="text-xs text-muted-foreground">{{ t('connect.tools.noneForKey') }}</li>
            </ul>
          </div>
        </div>
      </section>
    </template>

    <AlertDialog :open="revoking !== null" @update:open="(open: boolean) => { if (!open) revoking = null }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('connect.keys.revokeTitle', { name: revoking?.name ?? '' }) }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t('connect.keys.revokeBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" @click="revoke">
            {{ t('connect.keys.revoke') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

<style scoped>
.kn-step {
  display: inline-grid;
  place-items: center;
  width: 1.375rem;
  height: 1.375rem;
  border-radius: 9999px;
  background: color-mix(in oklab, var(--primary) 12%, transparent);
  color: var(--primary);
  font-size: var(--kn-text-xs);
  font-weight: 600;
}
</style>
