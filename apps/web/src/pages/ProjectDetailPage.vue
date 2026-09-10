<script setup lang="ts">
// One project's settings, rendered beside the project rail. Deleting needs
// `admin`, editing `editor` — hidden here, enforced by the API.
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import type { DeleteProjectResponse } from '@knowledge/contracts'
import { apiFetch, relativeTime } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import AvatarPicker from '@/components/people/AvatarPicker.vue'
import DeleteProjectDialog from '@/components/projects/DeleteProjectDialog.vue'
import ProjectAvatar from '@/components/projects/ProjectAvatar.vue'

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

/**
 * A short, opinionated set rather than a full emoji picker.
 *
 * A picker is a searchable grid of two thousand glyphs, and the decision here is
 * "which of these reads as my project at 20px" — a question a dozen legible,
 * domain-shaped options answer faster than a search box. Anything else is still
 * reachable: the field accepts any emoji the API validates.
 */
const EMOJI_CHOICES = ['📘', '🧭', '🛠️', '🚀', '🔐', '📊', '🧩', '⚙️', '🗂️', '💡', '🧪', '🌍']

async function setEmoji(emoji: string | null) {
  const p = project.value
  if (!p) return
  try {
    await apiFetch(`/v1/projects/${p.projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ avatarEmoji: emoji }),
    })
    emit('changed')
  } catch (e) {
    toast.error((e as Error).message)
  }
}

const confirmDelete = ref(false)

/** Candidate destinations: every project in the workspace except this one. */
const siblings = computed(() =>
  store.items.filter((p) => p.projectId !== project.value?.projectId),
)

/**
 * Deleting moved the contents somewhere; the app has to end up somewhere valid
 * too. If the project just removed was the active one, the `kn_proj` cookie now
 * points at an id that no longer resolves, so the scope follows the contents to
 * where they went (or to whatever the roster falls back to).
 */
async function onDeleted(result: DeleteProjectResponse) {
  const p = project.value
  const name = p?.name ?? ''
  toast.success(
    result.movedTo
      ? t('project.deletedMoved', {
          name,
          target: store.items.find((s) => s.projectId === result.movedTo)?.name ?? '',
        })
      : result.mode === 'cascade'
        ? t('project.deletedCascade', { name, n: result.destroyed?.documents ?? 0 })
        : t('project.deleted', { name }),
  )
  const wasActive = p?.projectId === store.activeId
  emit('changed')
  // Re-resolves a stale active id against the new roster on its own, which is
  // what covers a cascade — there is nowhere for the scope to follow.
  await store.fetchList()
  if (wasActive && result.movedTo) await store.switchProject(result.movedTo)
  void router.push('/settings/projects')
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
    <header class="flex items-start gap-3">
      <ProjectAvatar
        :project-id="project.projectId"
        :name="project.name"
        :avatar-url="project.avatarUrl"
        :avatar-emoji="project.avatarEmoji"
        :avatar-color="project.avatarColor"
        size="md"
      />
      <div class="min-w-0 flex-1 space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="font-display truncate text-2xl font-bold tracking-tight">{{ project.name }}</h1>
          <!-- The read side of the same project. This page is the form; the
               overview is where you go to find out what is in it. -->
          <RouterLink
            :to="`/projects/${project.projectId}`"
            class="text-primary text-xs hover:underline"
          >
            {{ t('project.openOverview') }}
          </RouterLink>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Badge v-if="project.projectId === store.activeId" variant="secondary">{{ t('project.active') }}</Badge>
          <Badge variant="outline">{{ t('people.pages', project.documentCount) }}</Badge>
          <span class="text-xs text-muted-foreground">
            {{ t('project.createdAt', { when: relativeTime(project.createdAt) }) }}
          </span>
        </div>
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

      <!-- The face. Separate from the name/description Save because an upload
           has already happened by the time it returns, and an emoji is one
           click — pairing either with a Save button would claim otherwise. -->
      <div v-if="auth.canEdit" class="space-y-2 border-t pt-3">
        <span class="text-xs font-medium text-muted-foreground">{{ t('project.appearance') }}</span>
        <p class="text-xs text-muted-foreground">{{ t('avatar.projectHint') }}</p>
        <AvatarPicker
          :base="`/v1/projects/${project.projectId}`"
          :has-image="project.avatarUrl !== null"
          @changed="emit('changed')"
        />
        <div class="flex flex-wrap items-center gap-1.5">
          <button
            v-for="choice in EMOJI_CHOICES"
            :key="choice"
            type="button"
            class="grid size-8 place-items-center rounded-md border text-base transition-colors hover:bg-muted"
            :class="project.avatarEmoji === choice ? 'border-primary bg-muted' : 'border-transparent'"
            :title="choice"
            @click="setEmoji(choice)"
          >
            {{ choice }}
          </button>
          <Button
            v-if="project.avatarEmoji"
            variant="ghost"
            size="sm"
            class="text-muted-foreground"
            @click="setEmoji(null)"
          >
            {{ t('avatar.emojiClear') }}
          </Button>
        </div>
      </div>
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
          @click="confirmDelete = true"
        >
          {{ t('common.delete') }}
        </Button>
      </div>
    </div>

    <DeleteProjectDialog
      v-if="auth.canAdminWorkspace"
      v-model:open="confirmDelete"
      :project="project"
      :siblings="siblings"
      @deleted="onDeleted"
    />
  </div>
</template>
