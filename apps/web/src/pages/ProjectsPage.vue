<script setup lang="ts">
// Projects: the organizational layer between a workspace and its pages
// (Workspace > Project > Document). Editing needs the `editor` role, deleting
// `admin` — the API enforces both, this only hides what would 403.
import { computed, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import type { CreateProjectResponse, ProjectSummary } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId, relativeTime } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

const auth = useAuthStore()
const store = useProjectsStore()

const loading = ref(true)
const newName = ref('')
const newDescription = ref('')
const creating = ref(false)
const editingId = ref<string | null>(null)
const editName = ref('')
const editDescription = ref('')

const canEdit = computed(() => auth.canEdit)
const canDelete = computed(() => auth.canAdminWorkspace)

async function reload() {
  loading.value = true
  try {
    await store.fetchList()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(reload)

async function create() {
  const name = newName.value.trim()
  if (!name) return
  creating.value = true
  try {
    const res = await apiFetch<CreateProjectResponse>('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: getWorkspaceId(),
        name,
        description: newDescription.value.trim() || null,
      }),
    })
    newName.value = ''
    newDescription.value = ''
    toast.success(`Project "${res.project.name}" created`)
    await reload()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

function startEdit(project: ProjectSummary) {
  editingId.value = project.projectId
  editName.value = project.name
  editDescription.value = project.description ?? ''
}

async function saveEdit(project: ProjectSummary) {
  try {
    await apiFetch(`/v1/projects/${project.projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: editName.value.trim(),
        description: editDescription.value.trim() || null,
      }),
    })
    editingId.value = null
    toast.success('Project updated')
    await reload()
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function remove(project: ProjectSummary) {
  if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) return
  try {
    await apiFetch(`/v1/projects/${project.projectId}`, { method: 'DELETE' })
    toast.success(`Project "${project.name}" deleted`)
    await reload()
  } catch (e) {
    toast.error((e as Error).message)
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-4xl space-y-6 p-4 lg:p-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">Projects</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Every page belongs to exactly one project. Switch the active project in the sidebar to
        re-scope the page tree.
      </p>
    </header>

    <Card v-if="canEdit">
      <CardHeader><CardTitle class="text-base">New project</CardTitle></CardHeader>
      <CardContent class="flex flex-col gap-2 sm:flex-row">
        <Input v-model="newName" placeholder="Name" class="sm:max-w-xs" @keyup.enter="create" />
        <Input v-model="newDescription" placeholder="Description (optional)" />
        <Button :disabled="creating || !newName.trim()" @click="create">Create</Button>
      </CardContent>
    </Card>

    <div v-if="loading" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-20 w-full" />
    </div>

    <p v-else-if="store.items.length === 0" class="text-sm text-muted-foreground">
      No projects in this workspace yet.
    </p>

    <ul v-else class="space-y-3">
      <li v-for="project in store.items" :key="project.projectId">
        <Card>
          <CardContent class="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div v-if="editingId === project.projectId" class="flex-1 space-y-2">
              <Input v-model="editName" placeholder="Name" />
              <Input v-model="editDescription" placeholder="Description" />
              <div class="flex gap-2">
                <Button size="sm" @click="saveEdit(project)">Save</Button>
                <Button size="sm" variant="ghost" @click="editingId = null">Cancel</Button>
              </div>
            </div>

            <template v-else>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-medium">{{ project.name }}</span>
                  <Badge v-if="project.projectId === store.activeId" variant="secondary">active</Badge>
                  <Badge variant="outline">{{ project.documentCount }} pages</Badge>
                </div>
                <p v-if="project.description" class="mt-1 text-sm text-muted-foreground">
                  {{ project.description }}
                </p>
                <p class="mt-1 text-xs text-muted-foreground">Created {{ relativeTime(project.createdAt) }}</p>
              </div>

              <div class="flex shrink-0 gap-2">
                <Button
                  v-if="project.projectId !== store.activeId"
                  size="sm"
                  variant="outline"
                  @click="store.switchProject(project.projectId)"
                >
                  Open
                </Button>
                <Button v-if="canEdit" size="sm" variant="ghost" @click="startEdit(project)">Rename</Button>
                <Button
                  v-if="canDelete"
                  size="sm"
                  variant="ghost"
                  class="text-destructive"
                  @click="remove(project)"
                >
                  Delete
                </Button>
              </div>
            </template>
          </CardContent>
        </Card>
      </li>
    </ul>
  </div>
</template>
