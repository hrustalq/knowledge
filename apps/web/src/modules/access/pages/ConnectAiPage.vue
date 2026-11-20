<script setup lang="ts">
/**
 * Connect AI, the manage side (docs/features/33): the endpoint, your keys,
 * what a connected client is offered, and the plain-HTTP URLs.
 *
 * Setting a client up — key, config, skill, capture kit — is the full-screen
 * wizard at /setup/connect (#1225), and `?client=` on this URL (printed in
 * every SKILL.md already handed out) goes straight there. This page is where
 * you come back to: revoke a key, see what a key reaches, run the setup
 * command again (#1347), or its separate skill commands (#1343).
 *
 * Everything here acts on the caller. Keys are yours; the tool list is what
 * *your* credential would be offered. Nothing on this page needs a workspace
 * role.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { ArrowRight, ChevronRight, FileText, KeyRound } from 'lucide-vue-next'
import type { ApiKeyInfo, McpConnectionInfo, McpToolset } from '@knowledge/contracts'
import { MCP_TOOLSET_KEYS, featureOfToolset } from '@knowledge/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { api, fetchApi } from '@/shared/api/queries'
import { getProjectId, getWorkspaceId } from '@/shared/api/api'
import { formatDate, formatRelative } from '@/shared/utils/format'
import {
  CopyBlock,
  KEY_ENV,
  SKILL_NAME,
  captureKitInstallCommand,
  mcpClients,
  setupInstallCommand,
  hasProjectConfig,
  skillDirGuides,
  skillInstallCommand,
  skillStackInstallCommand,
} from '@/entities/access'
import { useWorkspacesStore } from '@/stores/workspaces'
import { useProjectsStore } from '@/stores/projects'
import { useFeaturesStore } from '@/stores/features'
import { usePermission } from '@/stores/permissions'
import { Button } from '@knowledge/ui/button'
import { Badge } from '@knowledge/ui/badge'
import { Skeleton } from '@knowledge/ui/skeleton'
import { Collapse } from '@knowledge/ui/collapse'
import { Checkbox } from '@knowledge/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@knowledge/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@knowledge/ui/alert-dialog'
import { CONNECT_SETUP_PATH } from '../model/connect-setup-path'
import ChoiceCards from '../components/connect/ChoiceCards.vue'

const { t } = useI18n()
const router = useRouter()
const workspaces = useWorkspacesStore()
const projects = useProjectsStore()
const features = useFeaturesStore()
const queryClient = useQueryClient()

const connection = ref<McpConnectionInfo | null>(null)
const keys = ref<ApiKeyInfo[]>([])
const loading = ref(true)

/** The server takes keys; a sign-in session manages them. Dev mode has neither. */
const needsKey = computed(() => connection.value?.authMode === 'api-key')
const setupLink = { path: CONNECT_SETUP_PATH, query: { next: '/settings/ai/connect' } }

onMounted(async () => {
  origin.value = window.location.origin
  workspaces.ensureLoaded()
  try {
    const info = await fetchApi(queryClient, '/v1/mcp/connection')
    connection.value = info
    if (info.authMode === 'api-key') keys.value = (await fetchApi(queryClient, '/v1/me/api-keys', {}, { fresh: true })).keys
  } catch {
    toast.error(t('connect.loadFailed'))
  } finally {
    loading.value = false
  }
})

/* --------------------------------------------------------------------- keys */

/** A key's project pin, by name when this page has met the project; otherwise the start of its id. */
function projectName(id: string): string {
  return projects.items.find((p) => p.projectId === id)?.name ?? id.slice(0, 8)
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

/* ------------------------------------------------------------------ skills */

/*
 * The wizard's skill commands, to run again (#1343): the skill is fetched, so a
 * re-run is how it learns a new workspace or toolset. They read the key from
 * the environment; this page never shows one.
 */
const clients = computed(() =>
  connection.value
    ? mcpClients({ url: connection.value.url, serverName: connection.value.serverName, auth: needsKey.value, key: null, anyClientName: t('connect.wizard.client.anyName') })
    : [],
)
const skillDirs = computed(() => skillDirGuides(clients.value))
/** The one command (#1347) for the client picked here; the separate commands sit behind a disclosure. */
const setupClient = ref('claude-code')
const setupGuide = computed(() => clients.value.find((c) => c.id === setupClient.value) ?? null)
/** "For this repository" (#1348): offered only for a client with a committable config; the server refuses the rest. */
const setupProjectPath = computed(() => (setupGuide.value && hasProjectConfig(setupGuide.value) ? setupGuide.value.projectConfig.path : null))
const setupForRepo = ref(false)
const setupProject = computed(() => setupForRepo.value && !!setupProjectPath.value)
const setupCommand = computed(() =>
  connection.value ? setupInstallCommand(connection.value.url, setupClient.value, needsKey.value, { project: setupProject.value }) : '',
)
const setupKit = computed(() => !!setupGuide.value?.captureKit && capturesOffered.value)
const separate = ref(false)
const skillDirOptions = computed(() => skillDirs.value.map((g) => ({ value: g.dir, label: g.dir, hint: g.clients.join(', ') })))
const pickedDir = ref<string | null>(null)
const skillDir = computed(() => skillDirs.value.find((g) => g.dir === pickedDir.value) ?? skillDirs.value[0] ?? null)
const skillStack = computed(() =>
  connection.value && skillDir.value ? skillStackInstallCommand(connection.value.url, skillDir.value.dir, needsKey.value) : null,
)
/** A kit is refused to a credential offered no capture tool (403 `capture-not-offered`). */
const capturesOffered = computed(() => connection.value?.tools.some((tool) => tool.toolset === 'captures') ?? false)

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

/* ------------------------------------------------------------------- tools */

/*
 * The offer by toolset (#945). A toolset with nothing offered is still a row,
 * with the server's reason, so a missing group of tools is explained rather
 * than absent. `offHere` is this workspace's own switch: a toolset can be
 * offered (another workspace has the section on) and still refuse every call
 * that names this one.
 */
const toolGroups = computed(() => {
  const info = connection.value
  if (!info) return []
  const reasons = new Map(info.notOffered.map((n) => [n.toolset, n.reason]))
  return MCP_TOOLSET_KEYS.map((key) => {
    const tools = info.tools.filter((tool) => tool.toolset === key)
    const feature = featureOfToolset(key)
    return {
      key,
      tools,
      read: tools.filter((tool) => tool.readOnly).length,
      write: tools.filter((tool) => !tool.readOnly).length,
      reason: tools.length ? null : (reasons.get(key) ?? null),
      offHere: feature !== null && !features.isOn(feature),
    }
    // Not registered on this server at all (the draft tools without co-editing): nothing to say.
  }).filter((group) => group.tools.length || group.reason)
})
const openToolset = ref<McpToolset | null>(null)
const canManageFeatures = usePermission('workspace:admin')
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
      <!-- Setting a client up is the wizard (#1225). ------------------------ -->
      <section class="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl border bg-card px-5 py-4">
        <div class="min-w-0">
          <h2 class="font-display text-base font-semibold tracking-tight">{{ t('connect.wizard.title') }}</h2>
          <p class="kn-measure mt-0.5 text-xs text-muted-foreground">{{ t('connect.wizard.manage.startHint') }}</p>
        </div>
        <Button as-child class="gap-1.5">
          <RouterLink :to="setupLink">{{ t('connect.wizard.manage.start') }}<ArrowRight class="size-4" /></RouterLink>
        </Button>
      </section>

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

      <!-- Your keys: revoke, and see what each reaches. ------------------- -->
      <section v-if="needsKey" class="min-w-0 rounded-xl border bg-card px-5 py-4">
        <h2 class="font-display text-base font-semibold tracking-tight">{{ t('connect.keys.active', { n: keys.length }) }}</h2>
        <p v-if="!keys.length" class="mt-3 rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
          {{ t('connect.keys.empty') }}
        </p>
        <ul v-else class="mt-3 divide-y rounded-lg border">
          <li v-for="k in keys" :key="k.id" class="flex items-start gap-3 px-3 py-2.5">
            <KeyRound class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="truncate text-sm font-medium">{{ k.name }}</span>
                <Badge :variant="k.scope === 'read' ? 'secondary' : 'outline'">{{ t(`connect.keys.scopes.${k.scope}`) }}</Badge>
                <Badge v-if="k.workspaceId" variant="outline">{{ workspaceName(k.workspaceId) }}</Badge>
                <Badge v-for="id in k.projectIds ?? []" :key="id" variant="outline" class="font-normal">{{ projectName(id) }}</Badge>
                <Badge v-if="k.toolsets" variant="secondary">{{ t('connect.keys.mcpOnly') }}</Badge>
                <!-- An OAuth grant (#1352): the client signed in through the browser; revoked like a key. -->
                <Badge v-if="k.oauth" variant="secondary">{{ t('connect.oauth.via') }}</Badge>
              </div>
              <p v-if="k.toolsets" class="mt-0.5 text-caption text-muted-foreground">
                {{ t('connect.keys.toolsets', { list: k.toolsets.map((key) => t(`connect.toolsets.${key}.label`)).join(', ') }) }}
              </p>
              <p class="mt-0.5 text-caption text-muted-foreground">
                <template v-if="!k.oauth"><code class="font-mono">{{ k.prefix }}…</code> · </template>{{ k.lastUsedAt ? t('connect.keys.lastUsed', { when: formatRelative(k.lastUsedAt) }) : t('connect.keys.neverUsed') }}
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
      </section>

      <!-- Set a client up again, or on a new machine (#1347); the skill commands one by one (#1343). -->
      <section class="min-w-0 rounded-xl border bg-card px-5 py-4">
        <h2 class="font-display text-base font-semibold tracking-tight">{{ t('connect.skill.manage.title') }}</h2>
        <p class="kn-measure mt-0.5 text-xs text-muted-foreground">{{ t('connect.setup.manageHint') }}</p>
        <div class="mt-3 grid min-w-0 gap-3">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span id="kn-connect-setup-client" class="text-xs font-medium">{{ t('connect.setup.client') }}</span>
            <Select v-model="setupClient">
              <SelectTrigger class="h-8 w-auto min-w-44 text-sm" aria-labelledby="kn-connect-setup-client">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="c in clients" :key="c.id" :value="c.id">{{ c.name }}</SelectItem>
              </SelectContent>
            </Select>
            <label v-if="setupProjectPath" class="inline-flex min-h-8 items-center gap-2 text-xs">
              <Checkbox :model-value="setupForRepo" @update:model-value="setupForRepo = $event === true" />
              {{ t('connect.setup.forRepo', { path: setupProjectPath }) }}
            </label>
          </div>
          <div class="grid min-w-0 gap-2">
            <CopyBlock v-if="needsKey" :code="`export ${KEY_ENV}=<your-api-key>`" :label="t('connect.clients.step.env')" />
            <CopyBlock :code="setupCommand" :label="t('connect.setup.manageLabel')" />
            <p v-if="setupProject" class="kn-measure text-caption text-muted-foreground">
              {{ t('connect.setup.projectHint', { client: setupGuide?.name ?? '' }) }}
            </p>
            <p v-else class="kn-measure text-caption text-muted-foreground">
              {{ setupKit ? `${t('connect.setup.hint')} ${t('connect.setup.kitHint')}` : t('connect.setup.hint') }}
            </p>
            <!-- #1349: what a skill installed now carries, to compare with an installed one by eye. -->
            <p class="kn-measure text-caption text-muted-foreground">
              {{ t('connect.setup.stampLabel') }}
              <code class="rounded bg-muted px-1 font-mono text-foreground">{{ connection.skill.stamp }}</code>.
              {{ t('connect.setup.stampHint') }}
            </p>
          </div>

          <div v-if="skillDir" class="min-w-0">
            <button
              type="button"
              class="-mx-1 inline-flex min-h-6 items-center gap-1 rounded-md px-1 py-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring"
              :aria-expanded="separate"
              @click="separate = !separate"
            >
              <ChevronRight class="size-3.5 transition-transform motion-reduce:transition-none" :class="separate ? 'rotate-90' : ''" aria-hidden="true" />
              {{ t('connect.setup.separate') }}
            </button>
            <Collapse :open="separate">
              <div class="grid min-w-0 gap-3 pt-2">
                <ChoiceCards
                  :model-value="skillDir.dir"
                  name="kn-connect-skill-dir"
                  compact
                  :legend="t('connect.skill.manage.dirLegend')"
                  :options="skillDirOptions"
                  @update:model-value="(dir) => (pickedDir = dir as string)"
                />
                <div class="grid min-w-0 gap-2">
                  <CopyBlock
                    :code="skillInstallCommand(`${connection.url}/skill`, skillDir.dir, needsKey)"
                    :label="t('connect.skill.manage.single', { path: `${skillDir.dir}/${SKILL_NAME}/SKILL.md` })"
                  />
                  <template v-if="skillStack">
                    <CopyBlock :code="skillStack" :label="t('connect.skill.manage.stack', { path: skillDir.dir })" />
                    <p class="kn-measure text-caption text-muted-foreground">{{ t('connect.skill.stackHint') }}</p>
                  </template>
                  <template v-if="capturesOffered">
                    <CopyBlock
                      v-for="kit in skillDir.kits"
                      :key="kit.client"
                      :code="captureKitInstallCommand(`${connection.url}/capture-kit`, kit.client, needsKey)"
                      :label="t('connect.skill.manage.kit', { client: kit.name })"
                    />
                  </template>
                </div>
              </div>
            </Collapse>
          </div>
          <p class="kn-measure text-caption text-muted-foreground">{{ t('connect.skill.alsoServed') }}</p>
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
        <ul class="mt-3 divide-y rounded-lg border">
          <li v-for="group in toolGroups" :key="group.key" class="min-w-0">
            <template v-if="group.tools.length">
              <button
                type="button"
                class="flex w-full min-w-0 items-start gap-3 px-3 py-2.5 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring"
                :aria-expanded="openToolset === group.key"
                @click="openToolset = openToolset === group.key ? null : group.key"
              >
                <span class="min-w-0 flex-1">
                  <span class="flex flex-wrap items-baseline gap-x-2">
                    <span class="text-sm font-medium">{{ t(`connect.toolsets.${group.key}.label`) }}</span>
                    <span class="text-caption tabular-nums text-muted-foreground">
                      {{ t('connect.tools.counts', { read: group.read, write: group.write }) }}
                    </span>
                    <span v-if="group.offHere" class="text-caption text-panel-warning-ink">{{ t('connect.tools.offHere') }}</span>
                  </span>
                  <span class="mt-0.5 block text-caption text-muted-foreground">{{ t(`connect.toolsets.${group.key}.description`) }}</span>
                </span>
                <ChevronRight
                  class="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none"
                  :class="openToolset === group.key ? 'rotate-90' : ''"
                  aria-hidden="true"
                />
              </button>
              <div v-if="openToolset === group.key" class="grid gap-2 px-3 pb-3">
                <p v-if="group.offHere" class="text-caption text-panel-warning-ink">
                  {{ t('connect.tools.offHereHint') }}
                  <RouterLink v-if="canManageFeatures" to="/settings/features" class="ml-1 text-primary underline underline-offset-2">{{ t('connect.tools.features') }}</RouterLink>
                </p>
                <ul class="space-y-1.5">
                  <li v-for="tool in group.tools" :key="tool.name" class="min-w-0 text-xs">
                    <code class="font-mono text-caption font-medium wrap-anywhere">{{ tool.name }}</code>
                    <span class="ml-1.5 text-caption text-muted-foreground">{{ tool.readOnly ? t('connect.tools.readTag') : t('connect.tools.writeTag') }}</span>
                    <p class="line-clamp-2 text-muted-foreground">{{ tool.description }}</p>
                  </li>
                </ul>
              </div>
            </template>
            <div v-else class="px-3 py-2.5">
              <p class="text-sm font-medium text-muted-foreground">{{ t(`connect.toolsets.${group.key}.label`) }}</p>
              <p class="mt-0.5 text-caption text-muted-foreground">
                {{ t(`connect.tools.offReason.${group.reason}`) }}
                <RouterLink
                  v-if="group.reason === 'section-off' && canManageFeatures"
                  to="/settings/features"
                  class="ml-1 text-primary underline underline-offset-2"
                >{{ t('connect.tools.features') }}</RouterLink>
              </p>
            </div>
          </li>
          <li v-if="!toolGroups.length" class="px-3 py-2.5 text-xs text-muted-foreground">{{ t('connect.tools.noneForKey') }}</li>
        </ul>
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
