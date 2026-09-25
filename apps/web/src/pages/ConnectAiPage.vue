<script setup lang="ts">
/**
 * Connect an AI client to this knowledge base (docs/features/33).
 *
 * Three numbered steps, because that is the order the work has to happen in
 * and each one needs something from the one before: a key, then a client
 * configured with that key, then the skill that tells the client's model how
 * to use what it can now reach. Numbered cards rather than one long form so a
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
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { toast } from 'vue-sonner'
import { Download, ExternalLink, KeyRound, Plus, TriangleAlert } from 'lucide-vue-next'
import type {
  ApiKeyInfo,
  ApiKeyScope,
  CreateApiKeyResponse,
  ListApiKeysResponse,
  McpConnectionInfo,
} from '@knowledge/contracts'
import { API_KEY_SCOPES } from '@knowledge/contracts'
import { apiFetch, apiFetchText } from '@/lib/api'
import { formatDate, formatRelative } from '@/lib/format'
import { KEY_ENV, SKILL_NAME, mcpClients, skillInstallCommand } from '@/lib/mcp-clients'
import { useWorkspacesStore } from '@/stores/workspaces'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
import CopyBlock from '@/components/connect/CopyBlock.vue'

const { t } = useI18n()
const route = useRoute()
const workspaces = useWorkspacesStore()

const connection = ref<McpConnectionInfo | null>(null)
const keys = ref<ApiKeyInfo[]>([])
const skill = ref<string | null>(null)
const loading = ref(true)

/** The server takes keys; a sign-in session manages them. Dev mode has neither. */
const needsKey = computed(() => connection.value?.authMode === 'api-key')

onMounted(async () => {
  workspaces.ensureLoaded()
  try {
    const [info, md] = await Promise.all([
      apiFetch<McpConnectionInfo>('/v1/mcp/connection'),
      apiFetchText('/v1/mcp/skill'),
    ])
    connection.value = info
    skill.value = md
    if (info.authMode === 'api-key') keys.value = (await apiFetch<ListApiKeysResponse>('/v1/me/api-keys')).keys
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
})
const creating = ref(false)
const fresh = ref<{ key: ApiKeyInfo; apiKey: string } | null>(null)

async function createKey() {
  if (!form.name.trim()) return
  creating.value = true
  try {
    const res = await apiFetch<CreateApiKeyResponse>('/v1/me/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        name: form.name.trim(),
        scope: form.scope,
        ...(form.workspaceId !== ALL_WORKSPACES ? { workspaceId: form.workspaceId } : {}),
        ...(form.expiry !== 'never' ? { expiresInDays: Number(form.expiry) } : {}),
      }),
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

async function revoke() {
  const key = revoking.value
  if (!key) return
  try {
    await apiFetch(`/v1/me/api-keys/${key.id}`, { method: 'DELETE' })
    keys.value = keys.value.filter((k) => k.id !== key.id)
    if (fresh.value?.key.id === key.id) fresh.value = null
    toast.success(t('connect.keys.revoked', { name: key.name }))
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
    skill.value = await apiFetchText('/v1/mcp/skill', { headers: { Authorization: `Bearer ${asKey}` } })
  } catch {
    /* the session's copy stays; it only over-describes a narrower key */
  }
}

function downloadSkill() {
  if (!skill.value) return
  const href = URL.createObjectURL(new Blob([skill.value], { type: 'text/markdown' }))
  const a = document.createElement('a')
  a.href = href
  a.download = 'SKILL.md'
  a.click()
  URL.revokeObjectURL(href)
}

const readTools = computed(() => connection.value?.tools.filter((tool) => tool.readOnly) ?? [])
const writeTools = computed(() => connection.value?.tools.filter((tool) => !tool.readOnly) ?? [])
</script>

<template>
  <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-5">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('connect.title') }}</h1>
      <p class="mt-1 max-w-3xl text-sm text-muted-foreground">{{ t('connect.subtitle') }}</p>
    </div>

    <div v-if="loading" class="grid gap-5">
      <Skeleton class="h-40 w-full rounded-xl" />
      <Skeleton class="h-72 w-full rounded-xl" />
    </div>

    <template v-else-if="connection">
      <!-- The endpoint: the one value every client config below contains. -->
      <section class="min-w-0 rounded-xl border bg-card px-5 py-4">
        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 class="font-display text-[15px] font-semibold tracking-tight">{{ t('connect.endpoint.title') }}</h2>
          <span class="text-xs text-muted-foreground">
            {{ t('connect.endpoint.meta', { version: connection.version, tools: connection.tools.length }) }}
          </span>
        </div>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t('connect.endpoint.hint') }}</p>
        <div class="mt-3"><CopyBlock :code="connection.url" label="Streamable HTTP" /></div>
      </section>

      <!-- Step 1 ---------------------------------------------------------- -->
      <section class="min-w-0 rounded-xl border bg-card">
        <h2 class="flex items-center gap-2.5 border-b px-5 py-3.5 font-display text-[15px] font-semibold tracking-tight">
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
            <p class="text-[11px] text-muted-foreground">{{ t(`connect.keys.scopeHint.${form.scope}`) }}</p>
            <div>
              <Button type="submit" size="sm" class="gap-1.5" :disabled="creating || !form.name.trim()">
                <Plus class="size-3.5" />
                {{ creating ? t('connect.keys.creating') : t('connect.keys.create') }}
              </Button>
            </div>

            <!-- The one and only sighting of the value. -->
            <div v-if="fresh" class="grid gap-2 rounded-lg border border-dashed border-amber-500/50 bg-amber-500/5 p-3">
              <p class="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
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
                  </div>
                  <p class="mt-0.5 text-[11px] text-muted-foreground">
                    <code class="font-mono">{{ k.prefix }}…</code>
                    · {{ k.lastUsedAt ? t('connect.keys.lastUsed', { when: formatRelative(k.lastUsedAt) }) : t('connect.keys.neverUsed') }}
                    · {{ k.expiresAt ? t('connect.keys.expires', { when: formatDate(k.expiresAt) }) : t('connect.keys.noExpiry') }}
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
        <h2 class="flex items-center gap-2.5 border-b px-5 py-3.5 font-display text-[15px] font-semibold tracking-tight">
          <span class="kn-step">2</span>{{ t('connect.clients.title') }}
        </h2>

        <!-- Hand-rolled tab strip (no tab library in this app). -->
        <div role="tablist" class="flex gap-1 overflow-x-auto border-b px-3 py-2">
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
            <a :href="client.docs" target="_blank" rel="noopener noreferrer" class="ml-1 inline-flex items-center gap-0.5 text-primary hover:underline">
              {{ t('connect.clients.docs') }}<ExternalLink class="size-3" aria-hidden="true" />
            </a>
          </p>

          <CopyBlock v-if="client.usesEnv" :code="exportLine" :label="t('connect.clients.step.env')" />
          <CopyBlock v-if="client.command" :code="client.command" :label="t('connect.clients.step.command')" />
          <p v-if="client.command" class="text-[11px] text-muted-foreground">{{ t('connect.clients.orEdit') }}</p>
          <CopyBlock :code="client.config.code" :label="client.config.path" :secret="!client.usesEnv && !!fresh" />
          <p v-if="needsKey && !client.usesEnv && client.id !== 'vscode' && !fresh" class="text-[11px] text-amber-700 dark:text-amber-400">
            {{ t('connect.clients.placeholder') }}
          </p>
        </div>
      </section>

      <!-- Step 3 ---------------------------------------------------------- -->
      <section class="min-w-0 rounded-xl border bg-card">
        <h2 class="flex items-center gap-2.5 border-b px-5 py-3.5 font-display text-[15px] font-semibold tracking-tight">
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
          <p v-else-if="client" class="text-[11px] text-muted-foreground">{{ t('connect.skill.noSkillDir', { client: client.name }) }}</p>
          <p class="text-[11px] text-muted-foreground">{{ t('connect.skill.alsoServed') }}</p>

          <CopyBlock v-if="showSkill && skill" :code="skill" label="SKILL.md" />
        </div>
      </section>

      <!-- What the credential gets. ------------------------------------------ -->
      <section class="min-w-0 rounded-xl border bg-card px-5 py-4">
        <h2 class="font-display text-[15px] font-semibold tracking-tight">{{ t('connect.tools.title') }}</h2>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t('connect.tools.hint') }}</p>
        <div class="mt-3 grid gap-4 md:grid-cols-2">
          <div v-for="group in [{ key: 'read', tools: readTools }, { key: 'write', tools: writeTools }]" :key="group.key" class="min-w-0">
            <h3 class="text-xs font-medium text-muted-foreground">{{ t(`connect.tools.${group.key}`, { n: group.tools.length }) }}</h3>
            <ul class="mt-1.5 space-y-1.5">
              <li v-for="tool in group.tools" :key="tool.name" class="min-w-0 text-xs">
                <code class="font-mono text-[11px] font-medium">{{ tool.name }}</code>
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
          <AlertDialogAction class="bg-destructive text-white hover:bg-destructive/90" @click="revoke">
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
  font-size: 0.75rem;
  font-weight: 600;
}
</style>
