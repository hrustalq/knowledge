<script setup lang="ts">
// Plugins: external MCP servers whose tools join the assistant's tool harness.
// Registering one is an admin action with real reach — the server sees every
// argument the model sends it — so the rows show status and last error plainly.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { CircleDashed, CircleCheck, CircleX, Plug, Plus, RefreshCw, Trash2 } from 'lucide-vue-next'
import type { AiPluginSummary, AiPluginTestResponse, ListAiPluginsResponse } from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId, relativeTime } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import AiEmptyState from './AiEmptyState.vue'

const { t } = useI18n()

const props = defineProps<{ canManage: boolean }>()

const workspaceId = getWorkspaceId()
const queryClient = useQueryClient()
const query = useQuery(apiQueryOptions('/v1/ai/plugins', { query: { workspaceId } }))
const plugins = computed(() => (query.data.value as ListAiPluginsResponse | undefined)?.plugins ?? [])

const invalidates = () => [['/v1/ai/plugins']]
const createPlugin = useApiMutation('post', '/v1/ai/plugins', { invalidates })
const updatePlugin = useApiMutation('patch', '/v1/ai/plugins/{id}', { invalidates })
const deletePlugin = useApiMutation('delete', '/v1/ai/plugins/{id}', { invalidates })

const open = ref(false)
const editing = ref<AiPluginSummary | null>(null)
const testingId = ref<string | null>(null)
const form = ref({
  name: '',
  transport: 'streamable-http' as 'streamable-http' | 'sse',
  url: '',
  authHeader: 'Authorization',
  authValue: '',
  enabled: true,
})

function openNew() {
  editing.value = null
  form.value = {
    name: '',
    transport: 'streamable-http',
    url: '',
    authHeader: 'Authorization',
    authValue: '',
    enabled: true,
  }
  open.value = true
}

function openEdit(plugin: AiPluginSummary) {
  editing.value = plugin
  form.value = {
    name: plugin.name,
    transport: plugin.transport,
    url: plugin.url,
    authHeader: plugin.authHeader ?? '',
    // Write-only, exactly like the provider key: empty means "keep".
    authValue: '',
    enabled: plugin.enabled,
  }
  open.value = true
}

async function submit() {
  const f = form.value
  const body = {
    name: f.name.trim(),
    transport: f.transport,
    url: f.url.trim(),
    authHeader: f.authHeader.trim() || null,
    ...(f.authValue ? { authValue: f.authValue } : {}),
    enabled: f.enabled,
  }
  try {
    if (editing.value) {
      await updatePlugin.mutateAsync({ path: { id: editing.value.id }, body })
      toast.success('Plugin updated')
    } else {
      await createPlugin.mutateAsync({ body: { workspaceId, ...body } })
      toast.success('Plugin registered')
    }
    open.value = false
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function test(plugin: AiPluginSummary) {
  testingId.value = plugin.id
  try {
    const result = (await api.post('/v1/ai/plugins/{id}/test', {
      path: { id: plugin.id },
    })) as AiPluginTestResponse
    if (result.ok) toast.success(`${plugin.name}: ${result.tools.length} tool(s) discovered`)
    else toast.error(`${plugin.name}: ${result.error}`)
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    testingId.value = null
    void queryClient.invalidateQueries({ queryKey: ['/v1/ai/plugins'] })
  }
}

async function remove(plugin: AiPluginSummary) {
  try {
    await deletePlugin.mutateAsync({ path: { id: plugin.id } })
    toast.success(`Removed "${plugin.name}"`)
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/** An empty tick list means every discovered tool is offered. */
function isToolOn(plugin: AiPluginSummary, tool: string): boolean {
  return plugin.enabledTools.length === 0 || plugin.enabledTools.includes(tool)
}

/**
 * Ticking tools writes an explicit list. Unticking the first one has to
 * materialize "all of them" first, or the empty-means-all rule would silently
 * re-enable everything.
 */
async function toggleTool(plugin: AiPluginSummary, tool: string, on: boolean) {
  const current =
    plugin.enabledTools.length === 0 ? plugin.discoveredTools.map((t) => t.name) : [...plugin.enabledTools]
  const next = on ? [...new Set([...current, tool])] : current.filter((t) => t !== tool)
  try {
    await updatePlugin.mutateAsync({ path: { id: plugin.id }, body: { enabledTools: next } })
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function toggleEnabled(plugin: AiPluginSummary, enabled: boolean) {
  try {
    await updatePlugin.mutateAsync({ path: { id: plugin.id }, body: { enabled } })
  } catch (e) {
    toast.error((e as Error).message)
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <p class="text-muted-foreground text-sm">
        <template v-if="plugins.length">
          {{ plugins.filter((p) => p.enabled).length }} of {{ plugins.length }} enabled
        </template>
        <template v-else>{{ t('ai.externalTools') }}</template>
      </p>
      <Button v-if="canManage && plugins.length > 0" size="sm" @click="openNew">
        <Plus class="size-3.5" /> Add plugin
      </Button>
    </div>

    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton v-for="i in 2" :key="i" class="h-20 w-full" />
    </div>

    <AiEmptyState
      v-else-if="plugins.length === 0"
      :icon="Plug"
      :title="t('ai.noPlugins')"
      body="Connect an MCP server and its tools join the assistant's own — so it can reach your issue tracker or CI the same way it searches this workspace. Anything a plugin returns is treated as untrusted data."
      :example="{
        label: 'What you need',
        lines: [
          'url        https://mcp.example.com/jira',
          'transport  streamable HTTP',
          'auth       Authorization: Bearer …',
        ],
      }"
    >
      <template #action>
        <Button v-if="canManage" size="sm" @click="openNew"><Plus class="size-3.5" /> Add plugin</Button>
        <p v-else class="text-muted-foreground text-xs">A workspace admin can connect one.</p>
      </template>
    </AiEmptyState>

    <ul v-else class="space-y-3">
      <li v-for="plugin in plugins" :key="plugin.id" class="rounded-lg border p-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <CircleCheck v-if="plugin.status === 'connected'" class="size-4 shrink-0 text-emerald-600" />
              <CircleX v-else-if="plugin.status === 'error'" class="text-destructive size-4 shrink-0" />
              <CircleDashed v-else class="text-muted-foreground size-4 shrink-0" />
              <button class="font-medium" :disabled="!canManage" @click="openEdit(plugin)">{{ plugin.name }}</button>
              <Badge variant="outline" class="font-normal">{{ plugin.transport }}</Badge>
              <Badge v-if="plugin.hasAuthValue" variant="secondary" class="font-normal">authenticated</Badge>
            </div>
            <p class="text-muted-foreground truncate font-mono text-xs">{{ plugin.url }}</p>
            <p v-if="plugin.lastError" class="text-destructive mt-1 text-xs">{{ plugin.lastError }}</p>
            <p v-else-if="plugin.lastCheckedAt" class="text-muted-foreground mt-1 text-xs">
              checked {{ relativeTime(plugin.lastCheckedAt) }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <label class="flex items-center gap-1.5 text-xs">
              <Checkbox
                :model-value="plugin.enabled"
                :disabled="!canManage"
                @update:model-value="toggleEnabled(plugin, $event === true)"
              />
              enabled
            </label>
            <Button
              variant="outline"
              size="sm"
              :disabled="!canManage || testingId === plugin.id"
              @click="test(plugin)"
            >
              <RefreshCw class="size-3.5" :class="testingId === plugin.id && 'animate-spin'" />
              Test
            </Button>
            <Button v-if="canManage" variant="ghost" size="sm" :aria-label="`Remove ${plugin.name}`" @click="remove(plugin)">
              <Trash2 class="size-3.5" />
            </Button>
          </div>
        </div>

        <div v-if="plugin.discoveredTools.length" class="mt-3 border-t pt-3">
          <p class="text-muted-foreground mb-2 text-xs font-medium">
            Tools offered to the assistant ({{ plugin.discoveredTools.filter((t) => isToolOn(plugin, t.name)).length }}
            of {{ plugin.discoveredTools.length }})
          </p>
          <div class="grid gap-1.5 sm:grid-cols-2">
            <label v-for="tool in plugin.discoveredTools" :key="tool.name" class="flex items-start gap-2 text-xs">
              <Checkbox
                :model-value="isToolOn(plugin, tool.name)"
                :disabled="!canManage"
                @update:model-value="toggleTool(plugin, tool.name, $event === true)"
              />
              <span class="min-w-0">
                <span class="font-mono">{{ tool.name }}</span>
                <span v-if="tool.description" class="text-muted-foreground block truncate">{{ tool.description }}</span>
              </span>
            </label>
          </div>
        </div>
      </li>
    </ul>

    <Dialog v-model:open="open">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ editing ? 'Edit plugin' : 'Add plugin' }}</DialogTitle>
          <DialogDescription>
            The server must speak MCP over HTTP. Streamable HTTP is the current transport; SSE is for older servers
            that have not migrated yet.
          </DialogDescription>
        </DialogHeader>

        <form id="plugin-form" class="space-y-4" @submit.prevent="submit">
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">Name</span>
            <Input v-model="form.name" required placeholder="Jira" />
          </label>
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.transport') }}</span>
            <Select v-model="form.transport">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                <SelectItem value="sse">SSE (legacy)</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">URL</span>
            <Input v-model="form.url" required placeholder="https://mcp.example.com/jira" />
          </label>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block space-y-1">
              <span class="text-muted-foreground text-xs font-medium">{{ t('ai.authHeader') }}</span>
              <Input v-model="form.authHeader" placeholder="Authorization" />
            </label>
            <label class="block space-y-1">
              <span class="text-muted-foreground text-xs font-medium">{{ t('ai.authValue') }}</span>
              <Input
                v-model="form.authValue"
                type="password"
                autocomplete="off"
                :placeholder="editing?.hasAuthValue ? 'configured — leave empty to keep' : 'Bearer …'"
              />
            </label>
          </div>
          <label class="flex items-center gap-2">
            <Checkbox :model-value="form.enabled" @update:model-value="form.enabled = $event === true" />
            <span class="text-sm">Enabled</span>
          </label>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" @click="open = false">Cancel</Button>
          <Button
            type="submit"
            form="plugin-form"
            size="sm"
            :disabled="createPlugin.isPending.value || updatePlugin.isPending.value"
          >
            {{ editing ? 'Save' : 'Add' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
