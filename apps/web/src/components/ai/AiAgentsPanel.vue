<script setup lang="ts">
// Agents (docs/features/20): the named actors behind every AI call site. The
// built-in roster always exists, so this panel never has an empty state — what
// it has instead is the distinction between a shipped default and an override.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Plus, RotateCcw, Trash2 } from 'lucide-vue-next'
import {
  ASSISTANT_TOOL_NAMES,
  type AiAgentSummary,
  type AiProviderSummary,
  type ListAiAgentsResponse,
  type ListAiProvidersResponse,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
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

/**
 * reka-ui reserves the empty string for "nothing selected", so "follow the
 * workspace route" needs a sentinel of its own (the AiProvidersSection gotcha).
 */
const ROUTED = '__routed__'

const open = ref(false)
const editing = ref<AiAgentSummary | null>(null)
const blank = { key: '', name: '', description: '', instructions: '', tools: [] as string[], providerId: ROUTED }
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
      } = { workspaceId }
      if (f.name !== s.name) body.name = f.name.trim()
      if (f.description !== s.description) body.description = f.description.trim()
      if (f.instructions !== s.instructions) body.instructions = f.instructions
      if (JSON.stringify([...f.tools].sort()) !== JSON.stringify([...s.tools].sort())) body.tools = f.tools
      if (f.providerId !== s.providerId) body.providerId = f.providerId === ROUTED ? null : f.providerId
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
