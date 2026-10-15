<script setup lang="ts">
// Agent triggers (#70): start a run when something happens in the workspace.
// Saved one by one as they are edited, separately from the agent dialog's own
// form — a trigger is its own row, not a field of the agent.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Copy, KeyRound, Pencil, Plus, Trash2 } from 'lucide-vue-next'
import {
  AGENT_TRIGGER_COOLDOWN_MAX_MINUTES,
  AGENT_TRIGGER_FILTER_FIELDS,
  agentTriggerEventsFor,
  type AgentTriggerEvent,
  type AgentTriggerSummary,
  type AiAgentSummary,
  type ListAgentTriggersResponse,
  type ListConnectorsResponse,
  type RotateAgentTriggerSecretResponse,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId, relativeTime } from '@/lib/api'
import { formatList } from '@/lib/format'
import { useProjectsStore } from '@/stores/projects'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const props = defineProps<{ agent: AiAgentSummary }>()
const { t } = useI18n()

const workspaceId = getWorkspaceId()
const query = useQuery(apiQueryOptions('/v1/ai/agents/triggers', { query: { workspaceId } }))
const response = computed(() => query.data.value as ListAgentTriggersResponse | undefined)
const triggers = computed(() => (response.value?.triggers ?? []).filter((x) => x.agentKey === props.agent.key))

const connectorsQuery = useQuery(apiQueryOptions('/v1/connectors', { query: { workspaceId } }))
const connectors = computed(() => (connectorsQuery.data.value as ListConnectorsResponse | undefined)?.connectors ?? [])
const projects = useProjectsStore()

const invalidates = () => [['/v1/ai/agents/triggers']]
const createTrigger = useApiMutation('post', '/v1/ai/agents/{key}/triggers', { invalidates })
const updateTrigger = useApiMutation('patch', '/v1/ai/agents/triggers/{id}', { invalidates })
const deleteTrigger = useApiMutation('delete', '/v1/ai/agents/triggers/{id}', { invalidates })
const rotateSecret = useApiMutation('post', '/v1/ai/agents/triggers/{id}/rotate-secret', { invalidates })

/**
 * The secret a rotation just returned, shown under its trigger until the
 * dialog closes. The API never reads one back, so this is the only time it
 * exists outside the sender.
 */
const revealed = ref<{ id: string; secret: string } | null>(null)

async function rotate(trigger: AgentTriggerSummary) {
  try {
    const res = (await rotateSecret.mutateAsync({ path: { id: trigger.id } })) as RotateAgentTriggerSecretResponse
    revealed.value = { id: trigger.id, secret: res.secret }
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('ai.triggers.webhook.copied'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/** The same predicate the API refuses with, so the picker never offers a 400. */
const events = computed(() => agentTriggerEventsFor(props.agent.key))

/** reka-ui reserves the empty string for "nothing selected" (the AiProvidersSection gotcha). */
const ALL = '__all__'

/** `null` while closed, `'new'` while adding, a trigger id while editing one. */
const editingId = ref<string | null>(null)
const blank = () => ({
  event: events.value[0] as AgentTriggerEvent,
  projectId: ALL,
  categories: '',
  connectorIds: [] as string[],
  branch: '',
  /** Null on a new trigger: left out of the create, so `AGENT_TRIGGER_COOLDOWN_MINUTES` decides. */
  cooldownMinutes: null as number | null,
  note: '',
  enabled: false,
})
const form = ref(blank())
const fields = computed(() => AGENT_TRIGGER_FILTER_FIELDS[form.value.event])

function openNew() {
  form.value = blank()
  editingId.value = 'new'
}

function openEdit(trigger: AgentTriggerSummary) {
  form.value = {
    event: trigger.event,
    projectId: trigger.projectId ?? ALL,
    categories: (trigger.filter.categories ?? []).join(', '),
    connectorIds: [...(trigger.filter.connectorIds ?? [])],
    branch: trigger.filter.branch ?? '',
    cooldownMinutes: trigger.cooldownMinutes,
    note: trigger.note ?? '',
    enabled: trigger.enabled,
  }
  editingId.value = trigger.id
}

function toggleConnector(id: string, on: boolean) {
  const set = new Set(form.value.connectorIds)
  if (on) set.add(id)
  else set.delete(id)
  form.value.connectorIds = [...set]
}

/** Every field the event has, sent whole: null clears what the form emptied. */
function bodyFrom() {
  const f = form.value
  const categories = f.categories.split(',').map((c) => c.trim()).filter(Boolean)
  return {
    projectId: f.projectId === ALL ? null : f.projectId,
    ...(fields.value.includes('categories') ? { categories: categories.length ? categories : null } : {}),
    ...(fields.value.includes('connectorIds') ? { connectorIds: f.connectorIds.length ? f.connectorIds : null } : {}),
    ...(fields.value.includes('branch') ? { branch: f.branch.trim() || null } : {}),
    ...(f.cooldownMinutes !== null ? { cooldownMinutes: f.cooldownMinutes } : {}),
    note: f.note.trim() || null,
    enabled: f.enabled,
  }
}

async function save() {
  try {
    if (editingId.value === 'new') {
      await createTrigger.mutateAsync({
        path: { key: props.agent.key },
        body: { workspaceId, event: form.value.event, ...bodyFrom() },
      })
      toast.success(t('ai.triggers.created'))
    } else if (editingId.value) {
      await updateTrigger.mutateAsync({ path: { id: editingId.value }, body: bodyFrom() })
      toast.success(t('ai.triggers.saved'))
    }
    editingId.value = null
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function setEnabled(trigger: AgentTriggerSummary, enabled: boolean) {
  try {
    await updateTrigger.mutateAsync({ path: { id: trigger.id }, body: { enabled } })
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function remove(trigger: AgentTriggerSummary) {
  try {
    await deleteTrigger.mutateAsync({ path: { id: trigger.id } })
    if (editingId.value === trigger.id) editingId.value = null
    toast.success(t('ai.triggers.deleted'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

function onEnter(event: KeyboardEvent) {
  if ((event.target as HTMLElement | null)?.tagName === 'INPUT') event.preventDefault()
}

/** "project · guide, runbook · main" — only what narrows it. */
function scopeLabel(trigger: AgentTriggerSummary): string {
  const parts: string[] = []
  if (trigger.projectId) parts.push(projects.items.find((p) => p.projectId === trigger.projectId)?.name ?? trigger.projectId)
  if (trigger.filter.categories?.length) parts.push(formatList(trigger.filter.categories))
  if (trigger.filter.connectorIds?.length) {
    parts.push(formatList(trigger.filter.connectorIds.map((id) => connectors.value.find((c) => c.id === id)?.name ?? id)))
  }
  if (trigger.filter.branch) parts.push(trigger.filter.branch)
  return parts.join(' · ')
}
</script>

<template>
  <!-- Mounted inside the agent dialog's form: Enter in a field here must not
       submit the agent. -->
  <div class="space-y-3 border-t pt-4" @keydown.enter="onEnter">
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="text-sm">{{ t('ai.triggers.title') }}</p>
        <p class="text-muted-foreground mt-0.5 text-xs">{{ t('ai.triggers.hint') }}</p>
      </div>
      <Button v-if="editingId === null" type="button" variant="outline" size="sm" @click="openNew">
        <Plus class="size-3.5" /> {{ t('ai.triggers.add') }}
      </Button>
    </div>

    <!-- The env kill switch is a ceiling the toggles below cannot lift. -->
    <p v-if="response && !response.listening" class="text-destructive text-xs">{{ t('ai.triggers.notListening') }}</p>

    <ul v-if="triggers.length" class="divide-y rounded-md border">
      <li v-for="trigger in triggers" :key="trigger.id" class="flex items-start gap-3 p-2.5">
        <Checkbox
          class="mt-0.5"
          :model-value="trigger.enabled"
          :aria-label="t('ai.triggers.enabled')"
          @update:model-value="setEnabled(trigger, $event === true)"
        />
        <div class="min-w-0 flex-1">
          <span class="flex flex-wrap items-center gap-1.5 text-sm">
            {{ t(`ai.triggers.events.${trigger.event}`) }}
            <Badge v-if="scopeLabel(trigger)" variant="outline" class="max-w-64 truncate font-normal">
              {{ scopeLabel(trigger) }}
            </Badge>
          </span>
          <span class="text-muted-foreground block text-xs">
            {{ t('ai.triggers.cooldownShort', { count: trigger.cooldownMinutes }) }}
            ·
            {{
              trigger.lastFiredAt
                ? t('ai.triggers.lastFired', { when: relativeTime(trigger.lastFiredAt) })
                : t('ai.triggers.neverFired')
            }}
            <template v-if="trigger.ownerId"> · {{ t('ai.triggers.owned') }}</template>
          </span>
          <!-- A webhook is configured on the sender's side: it needs the URL
               and a secret, and a trigger without a secret refuses everything. -->
          <div v-if="trigger.webhook" class="mt-2 space-y-1.5 text-xs">
            <p class="text-muted-foreground font-medium">{{ t('ai.triggers.webhook.url') }}</p>
            <p class="flex items-center gap-1">
              <code class="bg-muted min-w-0 break-all rounded px-1 py-0.5 font-mono">{{ trigger.webhook.url }}</code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                :aria-label="t('ai.triggers.webhook.copy')"
                @click="copy(trigger.webhook.url)"
              >
                <Copy class="size-3.5" />
              </Button>
            </p>
            <p :class="trigger.webhook.secretSet ? 'text-muted-foreground' : 'text-destructive'">
              {{ trigger.webhook.secretSet ? t('ai.triggers.webhook.secretSet') : t('ai.triggers.webhook.noSecret') }}
            </p>
            <div v-if="revealed?.id === trigger.id" class="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
              <p>{{ t('ai.triggers.webhook.rotated') }}</p>
              <p class="flex items-center gap-1">
                <code class="bg-background min-w-0 break-all rounded px-1 py-0.5 font-mono">{{ revealed.secret }}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  :aria-label="t('ai.triggers.webhook.copy')"
                  @click="copy(revealed.secret)"
                >
                  <Copy class="size-3.5" />
                </Button>
              </p>
            </div>
            <p class="text-muted-foreground">{{ t('ai.triggers.webhook.signing') }}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              :disabled="rotateSecret.isPending.value"
              @click="rotate(trigger)"
            >
              <KeyRound class="size-3.5" />
              {{ trigger.webhook.secretSet ? t('ai.triggers.webhook.rotate') : t('ai.triggers.webhook.create') }}
            </Button>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" :aria-label="t('common.edit')" @click="openEdit(trigger)">
          <Pencil class="size-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" :aria-label="t('ai.triggers.delete')" @click="remove(trigger)">
          <Trash2 class="size-3.5" />
        </Button>
      </li>
    </ul>
    <p v-else-if="editingId === null && !query.isPending.value" class="text-muted-foreground text-xs">
      {{ t('ai.triggers.empty') }}
    </p>

    <!-- Inline rather than a second dialog: this already sits in one. -->
    <div v-if="editingId !== null" class="space-y-3 rounded-md border p-3">
      <label class="block space-y-1">
        <span class="text-muted-foreground text-xs font-medium">{{ t('ai.triggers.event') }}</span>
        <Select v-model="form.event" :disabled="editingId !== 'new'">
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="event in events" :key="event" :value="event">
              {{ t(`ai.triggers.events.${event}`) }}
            </SelectItem>
          </SelectContent>
        </Select>
        <span class="text-muted-foreground block text-xs">{{ t(`ai.triggers.eventHints.${form.event}`) }}</span>
      </label>

      <label class="block space-y-1">
        <span class="text-muted-foreground text-xs font-medium">{{ t('ai.triggers.project') }}</span>
        <Select v-model="form.projectId">
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem :value="ALL">{{ t('ai.triggers.allProjects') }}</SelectItem>
            <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</SelectItem>
          </SelectContent>
        </Select>
      </label>

      <label v-if="fields.includes('categories')" class="block space-y-1">
        <span class="text-muted-foreground text-xs font-medium">{{ t('ai.triggers.categories') }}</span>
        <Input v-model="form.categories" :placeholder="t('ai.triggers.categoriesPlaceholder')" />
      </label>

      <div v-if="fields.includes('connectorIds') && connectors.length" class="space-y-1">
        <span class="text-muted-foreground text-xs font-medium">{{ t('ai.triggers.connectors') }}</span>
        <div class="grid gap-1.5 sm:grid-cols-2">
          <label v-for="c in connectors" :key="c.id" class="flex items-center gap-2">
            <Checkbox
              :model-value="form.connectorIds.includes(c.id)"
              @update:model-value="toggleConnector(c.id, $event === true)"
            />
            <span class="truncate text-xs">{{ c.name }}</span>
          </label>
        </div>
        <span class="text-muted-foreground block text-xs">{{ t('ai.triggers.anyConnector') }}</span>
      </div>

      <label v-if="fields.includes('branch')" class="block max-w-64 space-y-1">
        <span class="text-muted-foreground text-xs font-medium">{{ t('ai.triggers.branch') }}</span>
        <Input
          v-model="form.branch"
          :placeholder="form.event === 'page.indexed' ? t('ai.triggers.defaultBranch') : t('ai.triggers.anyBranch')"
        />
      </label>

      <label class="block max-w-48 space-y-1">
        <span class="text-muted-foreground text-xs font-medium">{{ t('ai.triggers.cooldown') }}</span>
        <Input
          :model-value="form.cooldownMinutes ?? ''"
          type="number"
          min="0"
          :max="AGENT_TRIGGER_COOLDOWN_MAX_MINUTES"
          :placeholder="t('ai.triggers.cooldownDefault')"
          @update:model-value="form.cooldownMinutes = $event === '' ? null : Number($event)"
        />
      </label>
      <p class="text-muted-foreground -mt-2 text-xs">{{ t('ai.triggers.cooldownHint') }}</p>

      <label class="block space-y-1">
        <span class="text-muted-foreground text-xs font-medium">{{ t('ai.triggers.note') }}</span>
        <Textarea v-model="form.note" rows="2" />
      </label>

      <label class="flex items-center gap-2">
        <Checkbox :model-value="form.enabled" @update:model-value="form.enabled = $event === true" />
        <span class="text-sm">{{ t('ai.triggers.enabled') }}</span>
      </label>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" @click="editingId = null">{{ t('common.cancel') }}</Button>
        <Button
          type="button"
          size="sm"
          :disabled="createTrigger.isPending.value || updateTrigger.isPending.value"
          @click="save"
        >
          {{ editingId === 'new' ? t('common.create') : t('common.save') }}
        </Button>
      </div>
    </div>
  </div>
</template>
