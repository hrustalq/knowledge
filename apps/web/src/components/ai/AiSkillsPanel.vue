<script setup lang="ts">
// Skills: instruction packs merged into the assistant's system prompt when a
// trigger word matches the user's message, or when picked in the composer.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Plus, Sparkles, Trash2 } from 'lucide-vue-next'
import type { AiSkillSummary, ListAiSkillsResponse } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import AiEmptyState from './AiEmptyState.vue'

const { t } = useI18n()

const props = defineProps<{ canManage: boolean }>()

const workspaceId = getWorkspaceId()
const query = useQuery(apiQueryOptions('/v1/ai/skills', { query: { workspaceId } }))
const skills = computed(() => (query.data.value as ListAiSkillsResponse | undefined)?.skills ?? [])

const invalidates = () => [['/v1/ai/skills']]
const createSkill = useApiMutation('post', '/v1/ai/skills', { invalidates })
const updateSkill = useApiMutation('patch', '/v1/ai/skills/{id}', { invalidates })
const deleteSkill = useApiMutation('delete', '/v1/ai/skills/{id}', { invalidates })

const open = ref(false)
const editing = ref<AiSkillSummary | null>(null)
const form = ref({ name: '', description: '', instructions: '', triggers: '', enabled: true })

function openNew() {
  editing.value = null
  form.value = { name: '', description: '', instructions: '', triggers: '', enabled: true }
  open.value = true
}

function openEdit(skill: AiSkillSummary) {
  editing.value = skill
  form.value = {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    triggers: skill.triggers.join(', '),
    enabled: skill.enabled,
  }
  open.value = true
}

async function submit() {
  const f = form.value
  const triggers = f.triggers
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const body = {
    name: f.name.trim(),
    description: f.description.trim(),
    instructions: f.instructions,
    triggers,
    enabled: f.enabled,
  }
  try {
    if (editing.value) {
      await updateSkill.mutateAsync({ path: { id: editing.value.id }, body })
      toast.success(t('ai.skillUpdated'))
    } else {
      await createSkill.mutateAsync({ body: { workspaceId, ...body } })
      toast.success(t('ai.skillCreated'))
    }
    open.value = false
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function toggle(skill: AiSkillSummary, enabled: boolean) {
  try {
    await updateSkill.mutateAsync({ path: { id: skill.id }, body: { enabled } })
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function remove(skill: AiSkillSummary) {
  try {
    await deleteSkill.mutateAsync({ path: { id: skill.id } })
    toast.success(t('ai.deletedNamed', { name: skill.name }))
  } catch (e) {
    toast.error((e as Error).message)
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <p class="text-muted-foreground text-sm">
        <template v-if="skills.length">
          {{ t('ai.enabledOfTotal', { enabled: skills.filter((s) => s.enabled).length, total: skills.length }) }}
        </template>
        <template v-else>{{ t('ai.instructionsFollowed') }}</template>
      </p>
      <Button v-if="canManage && skills.length > 0" size="sm" @click="openNew">
        <Plus class="size-3.5" /> {{ t('ai.skills.new') }}
      </Button>
    </div>

    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-10 w-full" />
    </div>

    <AiEmptyState
      v-else-if="skills.length === 0"
      :icon="Sparkles"
      :title="t('ai.noSkills')"
      :body="t('ai.skills.body')"
      :example="{
        label: t('ai.forExample'),
        lines: [
          t('ai.skills.exampleName'),
          t('ai.skills.exampleTriggers'),
          t('ai.skills.exampleSays1'),
          t('ai.skills.exampleSays2'),
        ],
      }"
    >
      <template #action>
        <Button v-if="canManage" size="sm" @click="openNew"><Plus class="size-3.5" /> {{ t('ai.skills.new') }}</Button>
        <p v-else class="text-muted-foreground text-xs">{{ t('ai.adminCanAdd') }}</p>
      </template>
    </AiEmptyState>

    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('ai.name') }}</TableHead>
          <TableHead>{{ t('ai.triggers') }}</TableHead>
          <TableHead class="w-24">{{ t('ai.enabled') }}</TableHead>
          <TableHead class="w-20"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="skill in skills" :key="skill.id">
          <TableCell>
            <button class="text-left" :disabled="!canManage" @click="openEdit(skill)">
              <span class="font-medium" :class="canManage && 'hover:text-primary'">{{ skill.name }}</span>
              <span class="text-muted-foreground block text-xs">{{ skill.description }}</span>
            </button>
          </TableCell>
          <TableCell>
            <div v-if="skill.triggers.length" class="flex flex-wrap gap-1">
              <Badge v-for="trigger in skill.triggers" :key="trigger" variant="secondary" class="font-normal">{{ trigger }}</Badge>
            </div>
            <span v-else class="text-muted-foreground text-xs">{{ t('ai.skills.manualOnly') }}</span>
          </TableCell>
          <TableCell>
            <Checkbox
              :model-value="skill.enabled"
              :disabled="!canManage"
              @update:model-value="toggle(skill, $event === true)"
            />
          </TableCell>
          <TableCell class="text-right">
            <Button
              v-if="canManage"
              variant="ghost"
              size="sm"
              :aria-label="t('ai.skills.deleteNamed', { name: skill.name })"
              @click="remove(skill)"
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
          <DialogTitle>{{ editing ? t('ai.skills.edit') : t('ai.skills.new') }}</DialogTitle>
          <DialogDescription>
            {{ t('ai.skills.dialogDesc') }}
          </DialogDescription>
        </DialogHeader>

        <form id="skill-form" class="space-y-4" @submit.prevent="submit">
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.name') }}</span>
            <Input v-model="form.name" required :placeholder="t('ai.skills.namePlaceholder')" />
          </label>
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.description') }}</span>
            <Input v-model="form.description" :placeholder="t('ai.skills.descriptionPlaceholder')" />
          </label>
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.triggersCsv') }}</span>
            <Input v-model="form.triggers" placeholder="release, changelog, notes" />
          </label>
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs font-medium">{{ t('ai.skills.instructions') }}</span>
            <Textarea
              v-model="form.instructions"
              required
              rows="10"
              class="font-mono text-xs"
              :placeholder="t('ai.skills.instructionsPlaceholder')"
            />
          </label>
          <label class="flex items-center gap-2">
            <Checkbox :model-value="form.enabled" @update:model-value="form.enabled = $event === true" />
            <span class="text-sm">{{ t('ai.enabled') }}</span>
          </label>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" @click="open = false">{{ t('common.cancel') }}</Button>
          <Button
            type="submit"
            form="skill-form"
            size="sm"
            :disabled="createSkill.isPending.value || updateSkill.isPending.value"
          >
            {{ editing ? t('common.save') : t('common.create') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
