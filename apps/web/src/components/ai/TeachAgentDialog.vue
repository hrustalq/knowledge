<script setup lang="ts">
// Teach an agent (#70): write a learning — a correction the agent is given on
// its later turns — or edit one.
//
// One dialog for every place a learning starts: "Teach agent" on a thread
// comment, the Learnings panel's add and edit. What a person writes is
// proposed; only an admin makes it active, which is the moment it reaches a
// prompt, so an admin is offered that here and nobody else is.
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import {
  AGENT_LEARNING_MAX_CHARS,
  MCP_LEARNING_TARGET,
  type AgentLearningPersonSource,
  type AgentLearningSummary,
} from '@knowledge/contracts'
import { useApiMutation } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useAgentNames } from '@/components/merge-requests/use-agent-names'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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

const props = withDefaults(
  defineProps<{
    /** Edit this learning; absent writes a new one. */
    learning?: AgentLearningSummary | null
    /** The agent a new learning teaches; null is every agent. */
    agentKey?: string | null
    sourceKind?: AgentLearningPersonSource
    sourceId?: string | null
    initialText?: string
  }>(),
  { learning: null, agentKey: null, sourceKind: 'manual', sourceId: null, initialText: '' },
)
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [learning: AgentLearningSummary] }>()
const { t } = useI18n()

const workspaceId = getWorkspaceId()
const auth = useAuthStore()
const projects = useProjectsStore()
const { agentNames } = useAgentNames()

/** Select values are strings; this one stands for null ("every"). */
const ALL = '__all__'

const invalidates = () => [['/v1/ai/agents/learnings']]
const create = useApiMutation('post', '/v1/ai/agents/learnings', { invalidates })
const update = useApiMutation('patch', '/v1/ai/agents/learnings/{id}', { invalidates })

const form = ref({ text: '', agentKey: ALL, projectId: ALL, active: false })
watch(open, (now) => {
  if (!now) return
  const l = props.learning
  form.value = {
    text: l?.text ?? props.initialText,
    agentKey: (l ? l.agentKey : props.agentKey) ?? ALL,
    projectId: l?.projectId ?? ALL,
    active: false,
  }
})

const agentLabel = computed(() =>
  form.value.agentKey === ALL
    ? t('ai.learnings.everyAgent')
    : form.value.agentKey === MCP_LEARNING_TARGET
      ? t('ai.learnings.mcpTarget')
      : (agentNames.value.get(form.value.agentKey) ?? form.value.agentKey),
)
const agents = computed(() => [...agentNames.value.entries()].map(([key, name]) => ({ key, name })))
const tooLong = computed(() => form.value.text.length > AGENT_LEARNING_MAX_CHARS)
const pending = computed(() => create.isPending.value || update.isPending.value)

async function submit() {
  const f = form.value
  const scope = {
    agentKey: f.agentKey === ALL ? null : f.agentKey,
    projectId: f.projectId === ALL ? null : f.projectId,
  }
  try {
    let saved: AgentLearningSummary
    if (props.learning) {
      saved = (await update.mutateAsync({
        path: { id: props.learning.id },
        body: { text: f.text.trim(), ...scope },
      })) as AgentLearningSummary
      toast.success(t('ai.learnings.updated'))
    } else {
      saved = (await create.mutateAsync({
        body: {
          workspaceId,
          text: f.text.trim(),
          ...scope,
          sourceKind: props.sourceKind,
          ...(props.sourceId ? { sourceId: props.sourceId } : {}),
          ...(f.active ? { status: 'active' as const } : {}),
        },
      })) as AgentLearningSummary
      toast.success(saved.status === 'active' ? t('ai.learnings.savedActive') : t('ai.learnings.savedProposed'))
    }
    emit('saved', saved)
    open.value = false
  } catch (e) {
    toast.error((e as Error).message)
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ learning ? t('ai.learnings.editTitle') : t('ai.learnings.teachTitle', { agent: agentLabel }) }}</DialogTitle>
        <DialogDescription>
          {{ auth.canAdminWorkspace ? t('ai.learnings.teachDescAdmin') : t('ai.learnings.teachDesc') }}
        </DialogDescription>
      </DialogHeader>

      <form id="kn-teach-agent" class="space-y-3" @submit.prevent="submit">
        <label class="block space-y-1">
          <span class="text-muted-foreground text-xs font-medium">{{ t('ai.learnings.text') }}</span>
          <Textarea v-model="form.text" rows="4" :placeholder="t('ai.learnings.textPlaceholder')" />
          <span class="block text-right text-caption" :class="tooLong ? 'text-destructive' : 'text-muted-foreground'">
            {{ form.text.length }} / {{ AGENT_LEARNING_MAX_CHARS }}
          </span>
        </label>

        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.learnings.agent') }}</span>
            <Select v-model="form.agentKey">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="ALL">{{ t('ai.learnings.everyAgent') }}</SelectItem>
                <SelectItem :value="MCP_LEARNING_TARGET">{{ t('ai.learnings.mcpTarget') }}</SelectItem>
                <SelectItem v-for="a in agents" :key="a.key" :value="a.key">{{ a.name }}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.learnings.project') }}</span>
            <Select v-model="form.projectId">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="ALL">{{ t('ai.learnings.everyProject') }}</SelectItem>
                <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>

        <label v-if="!learning && auth.canAdminWorkspace" class="flex items-center gap-2 text-sm">
          <Checkbox :model-value="form.active" @update:model-value="form.active = $event === true" />
          {{ t('ai.learnings.activeNow') }}
        </label>
      </form>

      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t('common.cancel') }}</Button>
        <Button type="submit" form="kn-teach-agent" :disabled="pending || !form.text.trim() || tooLong">
          {{ learning ? t('common.save') : form.active ? t('ai.learnings.save') : t('ai.learnings.propose') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
