<script setup lang="ts">
// One project's settings, rendered beside the project rail. Deleting needs
// `admin`, editing `editor` — hidden here, enforced by the API.
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { apiFetch, relativeTime } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

const emit = defineEmits<{ changed: [] }>()

const auth = useAuthStore()
const store = useProjectsStore()
const route = useRoute()
const router = useRouter()

const project = computed(() => store.items.find((p) => p.projectId === route.params.id) ?? null)
const name = ref('')
const description = ref('')
const saving = ref(false)

// Re-seed the form whenever the selection (or a reload) changes it.
watch(
  project,
  (p) => {
    name.value = p?.name ?? ''
    description.value = p?.description ?? ''
  },
  { immediate: true },
)

const dirty = computed(
  () =>
    project.value !== null &&
    (name.value.trim() !== project.value.name ||
      description.value.trim() !== (project.value.description ?? '')),
)

async function save() {
  if (!project.value || !name.value.trim()) return
  saving.value = true
  try {
    await apiFetch(`/v1/projects/${project.value.projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: name.value.trim(), description: description.value.trim() || null }),
    })
    toast.success(t('project.updated'))
    emit('changed')
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

async function remove() {
  const p = project.value
  if (!p) return
  if (!confirm(`Delete project "${p.name}"? This cannot be undone.`)) return
  try {
    await apiFetch(`/v1/projects/${p.projectId}`, { method: 'DELETE' })
    toast.success(t('project.deleted', { name: p.name }))
    emit('changed')
    void router.push('/settings/projects')
  } catch (e) {
    toast.error((e as Error).message)
  }
}
</script>

<template>
  <div v-if="!route.params.id" class="space-y-2">
    <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('nav.projects') }}</h1>
    <p class="text-sm text-muted-foreground">
      {{ t('project.rosterHint') }}
    </p>
  </div>

  <p v-else-if="!project" class="text-sm text-muted-foreground">
    {{ store.loaded ? t('project.notFound') : t('common.loading') }}
  </p>

  <div v-else class="space-y-6">
    <header class="space-y-2">
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ project.name }}</h1>
      <div class="flex flex-wrap items-center gap-2">
        <Badge v-if="project.projectId === store.activeId" variant="secondary">{{ t('project.active') }}</Badge>
        <Badge variant="outline">{{ project.documentCount }} pages</Badge>
        <span class="text-xs text-muted-foreground">Created {{ relativeTime(project.createdAt) }}</span>
      </div>
    </header>

    <div class="space-y-3">
      <label class="block space-y-1">
        <span class="text-xs font-medium text-muted-foreground">{{ t('project.name') }}</span>
        <Input v-model="name" :disabled="!auth.canEdit" :placeholder="t('project.name')" />
      </label>
      <label class="block space-y-1">
        <span class="text-xs font-medium text-muted-foreground">{{ t('project.description') }}</span>
        <Input v-model="description" :disabled="!auth.canEdit" :placeholder="t('project.optional')" />
      </label>
      <div class="flex flex-wrap gap-2 pt-1">
        <Button v-if="auth.canEdit" :disabled="!dirty || saving || !name.trim()" @click="save">
          {{ saving ? t('project.saving') : t('common.save') }}
        </Button>
        <Button
          v-if="project.projectId !== store.activeId"
          variant="outline"
          @click="store.switchProject(project.projectId)"
        >
          {{ t('project.setAsActive') }}
        </Button>
        <Button
          v-if="auth.canAdminWorkspace"
          variant="ghost"
          class="ml-auto text-destructive"
          @click="remove"
        >
          {{ t('common.delete') }}
        </Button>
      </div>
    </div>
  </div>
</template>
