<script setup lang="ts">
// Agents (docs/features/20): the named actors behind every AI call site. The
// built-in roster always exists, so this panel never has an empty state — what
// it has instead is the distinction between a shipped default and an override.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Play, Plus, RotateCcw, Trash2 } from 'lucide-vue-next'
import {
  ASSISTANT_TOOL_NAMES,
  isConnectorScopedAgent,
  type AiAgentSummary,
  type AiProviderSummary,
  type ListAiAgentsResponse,
  type ListAiProvidersResponse,
  type ListConnectorsResponse,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId, relativeTime } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const { t } = useI18n()

defineProps<{ canManage: boolean }>()

const workspaceId = getWorkspaceId()
const query = useQuery(apiQueryOptions('/v1/ai/agents', { query: { workspaceId } }))
const agents = computed(() => (query.data.value as ListAiAgentsResponse | undefined)?.agents ?? [])

const providersQuery = useQuery(apiQueryOptions('/v1/ai/providers', { query: { workspaceId } }))
const providers = computed<AiProviderSummary[]>(
  () => (providersQuery.data.value as ListAiProvidersResponse | undefined)?.providers ?? [],
)

const invalidates = () => [['/v1/ai/agents'], ['/v1/ai/agents/choices']]
const createAgent = useApiMutation('post', '/v1/ai/agents', { invalidates })
const updateAgent = useApiMutation('patch', '/v1/ai/agents/{key}', { invalidates })
const resetAgent = useApiMutation('delete', '/v1/ai/agents/{key}/override', { invalidates })
const deleteAgent = useApiMutation('delete', '/v1/ai/agents/{key}', { invalidates })
const runAgent = useApiMutation('post', '/v1/ai/agents/{key}/run', {
  invalidates: () => [['/v1/ai/agents'], ['/v1/ai/agents/runs']],
})

/**
 * The repositories a connector-scoped agent can read (docs/features/31). The
 * archaeologist runs against one; with exactly one connected it is implied,
 * with several the person picks, with none the button says what to connect.
 * `isConnectorScopedAgent` is the same predicate the API refuses with, so the
 * dialog and the 400 cannot disagree about which agents need a pick.
 */
const connectorsQuery = useQuery(apiQueryOptions('/v1/connectors', { query: { workspaceId } }))
const repositories = computed(() =>
  ((connectorsQuery.data.value as ListConnectorsResponse | undefined)?.connectors ?? []).filter(
    (c) => c.enabled && (c.kind === 'codebase' || c.kind === 'markdown-git'),
  ),
)
const runOpen = ref(false)
const runTarget = ref<AiAgentSummary | null>(null)
const runConnectorId = ref('')

/**
 * reka-ui reserves the empty string for "nothing selected", so "follow the
 * workspace route" needs a sentinel of its own (the AiProvidersSection gotcha).
 */
const ROUTED = '__routed__'

const open = ref(false)
const editing = ref<AiAgentSummary | null>(null)
const blank = {
  key: '',
  name: '',
  description: '',
  instructions: '',
  tools: [] as string[],
  providerId: ROUTED,
  scheduleEnabled: false,
  scheduleMinutes: null as number | null,
  scheduleNote: '',
}
const form = ref({ ...blank })
/** What the agent looked like when the dialog opened, so submit can send only what changed. */
const snapshot = ref({ ...blank })

/** Built-in tools plus anything already set (an MCP tool assigned through the API). */
const toolChoices = computed(() => [
  ...new Set<string>([...ASSISTANT_TOOL_NAMES, ...(editing.value?.tools ?? [])]),
])

function openNew() {
  editing.value = null
  form.value = { ...blank }
  snapshot.value = { ...blank }
  open.value = true
}

function openEdit(agent: AiAgentSummary) {
  editing.value = agent
  const loaded = {
    key: agent.key,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    tools: [...agent.tools],
    providerId: agent.providerId ?? ROUTED,
    scheduleEnabled: agent.scheduleEnabled,
    scheduleMinutes: agent.scheduleMinutes,
    scheduleNote: agent.scheduleNote ?? '',
  }
  form.value = { ...loaded, tools: [...loaded.tools] }
  snapshot.value = { ...loaded, tools: [...loaded.tools] }
  open.value = true
}

function toggleTool(name: string, on: boolean) {
  const set = new Set(form.value.tools)
  if (on) set.add(name)
  else set.delete(name)
  form.value.tools = [...set]
}

async function submit() {
  const f = form.value
  try {
    if (!editing.value) {
      await createAgent.mutateAsync({
        body: {
          workspaceId,
          key: f.key.trim(),
          name: f.name.trim(),
          description: f.description.trim(),
          instructions: f.instructions,
          tools: f.tools,
          providerId: f.providerId === ROUTED ? null : f.providerId,
        },
      })
      toast.success(t('ai.agents.created'))
    } else {
      // Only what actually changed: sending an untouched field would turn a
      // shipped default into an override and freeze it against future releases.
      const s = snapshot.value
      const body: {
        workspaceId: string
        name?: string
        description?: string
        instructions?: string
        tools?: string[]
        providerId?: string | null
        scheduleEnabled?: boolean
        scheduleMinutes?: number | null
        scheduleNote?: string | null
      } = { workspaceId }
      if (f.name !== s.name) body.name = f.name.trim()
      if (f.description !== s.description) body.description = f.description.trim()
      if (f.instructions !== s.instructions) body.instructions = f.instructions
      if (JSON.stringify([...f.tools].sort()) !== JSON.stringify([...s.tools].sort())) body.tools = f.tools
      if (f.providerId !== s.providerId) body.providerId = f.providerId === ROUTED ? null : f.providerId
      if (f.scheduleEnabled !== s.scheduleEnabled) body.scheduleEnabled = f.scheduleEnabled
      if (f.scheduleMinutes !== s.scheduleMinutes) body.scheduleMinutes = f.scheduleMinutes
      if (f.scheduleNote !== s.scheduleNote) body.scheduleNote = f.scheduleNote.trim() || null
      if (Object.keys(body).length === 1) {
        open.value = false
        return
      }
      await updateAgent.mutateAsync({ path: { key: editing.value.key }, body })
      toast.success(t('ai.agents.saved'))
    }
    open.value = false
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function toggle(agent: AiAgentSummary, enabled: boolean) {
  try {
    await updateAgent.mutateAsync({ path: { key: agent.key }, body: { workspaceId, enabled } })
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function runNow(agent: AiAgentSummary) {
  if (isConnectorScopedAgent(agent.key)) {
    if (repositories.value.length === 0) {
      toast.error(t('ai.agents.noRepositories'))
      return
    }
    if (repositories.value.length > 1) {
      runTarget.value = agent
      runConnectorId.value = repositories.value[0].id
      runOpen.value = true
      return
    }
    return start(agent, repositories.value[0].id)
  }
  return start(agent)
}

async function start(agent: AiAgentSummary, connectorId?: string) {
  try {
    await runAgent.mutateAsync({
      path: { key: agent.key },
      body: { workspaceId, ...(connectorId ? { connectorId } : {}) },
    })
    toast.success(t('ai.agents.runStarted', { name: agent.name }))
    runOpen.value = false
  } catch (e) {
    // The server owns the refusals a client cannot check for itself — a run
    // already in flight, a spent budget, a disabled provider.
    toast.error((e as Error).message)
  }
}

async function reset(agent: AiAgentSummary) {
  try {
    await resetAgent.mutateAsync({ path: { key: agent.key }, query: { workspaceId } })
    toast.success(t('ai.agents.resetDone', { name: agent.name }))
    if (open.value && editing.value?.key === agent.key) open.value = false
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function remove(agent: AiAgentSummary) {
  try {
    await deleteAgent.mutateAsync({ path: { key: agent.key }, query: { workspaceId } })
    toast.success(t('ai.agents.deleted', { name: agent.name }))
  } catch (e) {
    toast.error((e as Error).message)
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <p class="text-muted-foreground text-sm">{{ t('ai.agents.subtitle') }}</p>
      <Button v-if="canManage" size="sm" @click="openNew">
        <Plus class="size-3.5" /> {{ t('ai.agents.new') }}
      </Button>
    </div>

    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton v-for="i in 6" :key="i" class="h-10 w-full" />
    </div>

    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('ai.agents.colAgent') }}</TableHead>
          <TableHead>{{ t('ai.agents.colModel') }}</TableHead>
          <TableHead class="w-24">{{ t('ai.enabled') }}</TableHead>
          <TableHead class="w-20"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="agent in agents" :key="agent.key">
          <TableCell>
            <button class="text-left" :disabled="!canManage" @click="openEdit(agent)">
              <span class="flex flex-wrap items-center gap-1.5">
                <span class="font-medium" :class="canManage && 'hover:text-primary'">{{ agent.name }}</span>
                <Badge v-if="!agent.builtIn" variant="secondary" class="font-normal">
                  {{ t('ai.agents.custom') }}
                </Badge>
                <Badge v-if="agent.overridden.length" variant="outline" class="font-normal">
                  {{ t('ai.agents.overridden', { count: agent.overridden.length }) }}
                </Badge>
                <!-- The routed model cannot do what this agent needs, so it will
                     refuse to run. Said here, where the routing was chosen. -->
                <Badge v-if="agent.missing.length" variant="destructive" class="font-normal">
                  {{ t('ai.agents.missing', { caps: agent.missing.join(', ') }) }}
                </Badge>
                <Badge v-if="agent.scheduleEnabled && agent.scheduleMinutes" variant="outline" class="font-normal">
                  {{ t('ai.agents.everyMinutes', { count: agent.scheduleMinutes }) }}
                </Badge>
              </span>
              <span class="text-muted-foreground block text-xs">{{ agent.description }}</span>
            </button>
          </TableCell>
          <TableCell>
            <span class="text-xs">{{ agent.providerName ?? t('ai.agents.routed', { purpose: agent.purpose }) }}</span>
            <span class="text-muted-foreground block font-mono text-[11px]">{{ agent.tools.length }} tools</span>
          </TableCell>
          <TableCell>
            <Checkbox
              :model-value="agent.enabled"
              :disabled="!canManage"
              @update:model-value="toggle(agent, $event === true)"
            />
          </TableCell>
          <TableCell class="text-right">
            <Button
              v-if="canManage && agent.runnable"
              variant="ghost"
              size="sm"
              :disabled="!agent.enabled || runAgent.isPending.value"
              :aria-label="t('ai.agents.runNow')"
              :title="t('ai.agents.runNow')"
              @click="runNow(agent)"
            >
              <Play class="size-3.5" />
            </Button>
            <Button
              v-if="canManage && agent.builtIn && agent.overridden.length"
              variant="ghost"
              size="sm"
              :aria-label="t('ai.agents.reset')"
              :title="t('ai.agents.reset')"
              @click="reset(agent)"
            >
              <RotateCcw class="size-3.5" />
            </Button>
            <Button
              v-else-if="canManage && !agent.builtIn"
              variant="ghost"
              size="sm"
              :aria-label="t('ai.agents.delete', { name: agent.name })"
              @click="remove(agent)"
            >
              <Trash2 class="size-3.5" />
            </Button>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>

    <!-- Which repository a connector-scoped run reads (docs/features/31).
         Opened only when there is a real choice; one repository is implied. -->
    <Dialog v-model:open="runOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('ai.agents.pickConnector', { name: runTarget?.name ?? '' }) }}</DialogTitle>
          <DialogDescription>{{ t('ai.agents.pickConnectorHint') }}</DialogDescription>
        </DialogHeader>
        <Select v-model="runConnectorId">
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="r in repositories" :key="r.id" :value="r.id">
              {{ r.name }} <span class="text-muted-foreground">· {{ r.config.repoUrl }}</span>
            </SelectItem>
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" @click="runOpen = false">{{ t('cancel') }}</Button>
          <Button
            :disabled="!runConnectorId || runAgent.isPending.value"
            @click="runTarget && start(runTarget, runConnectorId)"
          >
            <Play class="size-3.5" /> {{ t('ai.agents.runNow') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="open">
      <DialogContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editing ? editing.name : t('ai.agents.newTitle') }}</DialogTitle>
          <DialogDescription>{{ t('ai.agents.dialogHint') }}</DialogDescription>
        </DialogHeader>

        <form id="agent-form" class="max-h-[60vh] space-y-4 overflow-y-auto" @submit.prevent="submit">
          <label v-if="!editing" class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.agents.key') }}</span>
            <Input v-model="form.key" required placeholder="release-notes" pattern="[a-z0-9][a-z0-9-]*" />
          </label>
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.agents.name') }}</span>
            <Input v-model="form.name" required />
          </label>
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.description') }}</span>
            <Input v-model="form.description" />
          </label>
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.agents.instructions') }}</span>
            <Textarea v-model="form.instructions" rows="10" class="font-mono text-xs" />
          </label>

          <div class="space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.agents.tools') }}</span>
            <div class="grid gap-1.5 sm:grid-cols-2">
              <label v-for="name in toolChoices" :key="name" class="flex items-center gap-2">
                <Checkbox
                  :model-value="form.tools.includes(name)"
                  @update:model-value="toggleTool(name, $event === true)"
                />
                <span class="font-mono text-xs">{{ name }}</span>
              </label>
            </div>
          </div>

          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.agents.provider') }}</span>
            <Select
              :model-value="form.providerId"
              @update:model-value="form.providerId = String($event ?? ROUTED)"
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="ROUTED">{{ t('ai.agents.followRoute') }}</SelectItem>
                <SelectItem v-for="p in providers.filter((x) => x.enabled)" :key="p.id" :value="p.id">
                  {{ p.name }}
                </SelectItem>
              </SelectContent>
            </Select>
          </label>

          <!--
            Only for an agent that can actually run unattended. Gating on
            `runnable` rather than on the `background` surface is deliberate: the
            surface is a declaration, and a schedule set against a declaration
            with no executor behind it is a failed job every interval.
          -->
          <div v-if="editing?.runnable" class="space-y-3 border-t pt-4">
            <label class="flex items-start gap-2.5">
              <Checkbox
                class="mt-0.5"
                :model-value="form.scheduleEnabled"
                @update:model-value="form.scheduleEnabled = $event === true"
              />
              <span class="text-sm leading-snug">
                {{ t('ai.agents.scheduleEnabled') }}
                <span class="text-muted-foreground mt-0.5 block text-xs">
                  {{ t('ai.agents.scheduleHint') }}
                </span>
              </span>
            </label>

            <div v-if="form.scheduleEnabled" class="space-y-3 pl-7">
              <label class="block max-w-48 space-y-1">
                <span class="text-muted-foreground text-xs font-medium">{{ t('ai.agents.scheduleMinutes') }}</span>
                <Input
                  :model-value="form.scheduleMinutes ?? ''"
                  type="number"
                  min="15"
                  max="20160"
                  required
                  @update:model-value="form.scheduleMinutes = $event === '' ? null : Number($event)"
                />
              </label>
              <label class="block space-y-1">
                <span class="text-muted-foreground text-xs font-medium">{{ t('ai.agents.scheduleNote') }}</span>
                <Textarea v-model="form.scheduleNote" rows="2" :placeholder="t('ai.agents.scheduleNotePlaceholder')" />
              </label>
              <p class="text-muted-foreground text-xs">
                {{
                  editing.lastRunAt
                    ? t('ai.agents.lastRunAt', { when: relativeTime(editing.lastRunAt) })
                    : t('ai.agents.neverRun')
                }}
                <span v-if="editing.scheduleOwner"> · {{ t('ai.agents.scheduleOwned') }}</span>
              </p>
            </div>
          </div>
        </form>

        <DialogFooter class="gap-2">
          <Button
            v-if="editing?.builtIn && editing.overridden.length"
            type="button"
            variant="outline"
            size="sm"
            class="mr-auto"
            @click="reset(editing)"
          >
            <RotateCcw class="size-3.5" /> {{ t('ai.agents.reset') }}
          </Button>
          <Button type="button" variant="outline" size="sm" @click="open = false">{{ t('common.cancel') }}</Button>
          <Button
            type="submit"
            form="agent-form"
            size="sm"
            :disabled="createAgent.isPending.value || updateAgent.isPending.value"
          >
            {{ editing ? t('common.save') : t('common.create') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
