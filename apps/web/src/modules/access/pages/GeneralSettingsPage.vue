<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { DeleteWorkspaceResponse } from '@knowledge/contracts'
import { Badge } from '@knowledge/ui/badge'
import { Button } from '@knowledge/ui/button'
import { Input } from '@knowledge/ui/input'
import { api } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { useAuthStore } from '@/stores/auth'
import { useWorkspacesStore } from '@/stores/workspaces'
import DeleteWorkspaceDialog from '@/modules/access/components/DeleteWorkspaceDialog.vue'

const { t } = useI18n()
const auth = useAuthStore()
const workspaces = useWorkspacesStore()
const workspace = computed(() => workspaces.items.find((w) => w.workspaceId === getWorkspaceId()) ?? workspaces.items[0])
const canManage = computed(() => auth.isDev || auth.isAdmin || workspace.value?.myRole === 'admin')

onMounted(() => workspaces.ensureLoaded())

const nameDraft = ref('')
const renaming = ref(false)
watch(() => workspace.value?.name, (name) => { nameDraft.value = name ?? '' }, { immediate: true })
const nameChanged = computed(() => {
  const next = nameDraft.value.trim()
  return next !== '' && next !== workspace.value?.name
})

async function renameWorkspace() {
  const ws = workspace.value
  if (!ws || !nameChanged.value) return
  renaming.value = true
  try {
    const res = await api.patch('/v1/workspaces/{id}', {
      path: { id: ws.workspaceId },
      body: { name: nameDraft.value.trim() },
    })
    workspaces.rename(res.workspaceId, res.name)
    toast.success(t('access.renameWorkspace.renamed', { name: res.name }))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    renaming.value = false
  }
}

const deleteOpen = ref(false)
async function onWorkspaceDeleted(res: DeleteWorkspaceResponse) {
  toast.success(t('access.deleteWorkspace.deleted', { name: workspace.value?.name ?? '' }))
  await workspaces.forget(res.workspaceId)
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between gap-3">
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('nav.general') }}</h1>
      <Badge v-if="!canManage" variant="outline">{{ t('access.readOnly') }}</Badge>
    </div>

    <p v-if="!workspace" class="text-sm text-muted-foreground">{{ t('common.loading') }}</p>
    <template v-else-if="canManage">
      <section
        aria-labelledby="rename-workspace-heading"
        class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3"
      >
        <div class="min-w-0 flex-1 space-y-0.5">
          <h2 id="rename-workspace-heading" class="text-sm font-medium">
            <label for="workspace-name">{{ t('access.renameWorkspace.title') }}</label>
          </h2>
          <p class="max-w-prose text-xs text-muted-foreground">{{ t('access.renameWorkspace.body') }}</p>
        </div>
        <form class="flex w-full gap-2 sm:w-auto" @submit.prevent="renameWorkspace">
          <Input id="workspace-name" v-model="nameDraft" maxlength="120" required class="h-8 sm:w-64" />
          <Button type="submit" size="sm" variant="outline" :disabled="!nameChanged || renaming">
            {{ t('access.renameWorkspace.save') }}
          </Button>
        </form>
      </section>

      <section
        aria-labelledby="delete-workspace-heading"
        class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t pt-6"
      >
        <div class="min-w-0 flex-1 space-y-0.5">
          <h2 id="delete-workspace-heading" class="text-sm font-medium">{{ t('access.deleteWorkspace.zoneTitle') }}</h2>
          <p class="max-w-prose break-words text-xs text-muted-foreground">
            {{ t('access.deleteWorkspace.zoneBody', { name: workspace.name }) }}
          </p>
        </div>
        <Button size="sm" variant="outline" class="text-destructive hover:text-destructive" @click="deleteOpen = true">
          {{ t('access.deleteWorkspace.open') }}
        </Button>
      </section>
    </template>

    <DeleteWorkspaceDialog
      v-if="workspace"
      v-model:open="deleteOpen"
      :workspace="workspace"
      @deleted="onWorkspaceDeleted"
    />
  </div>
</template>
