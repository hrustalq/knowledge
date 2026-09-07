<script setup lang="ts">
/**
 * "Create a scope and jump into it" — the form behind the switcher's footer
 * action. One component for both kinds because it is one interaction: the
 * field set differs, the create-then-switch outcome does not.
 *
 * Errors render inline rather than as a toast: the toast would land behind
 * the modal, and the user needs the message next to the field they must fix.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { Library, Folder } from 'lucide-vue-next'
import type { CreateProjectResponse, CreateWorkspaceResponse } from '@knowledge/contracts'
import { ApiError, apiFetch, getWorkspaceId } from '@/lib/api'
import { useProjectsStore } from '@/stores/projects'
import { useWorkspacesStore } from '@/stores/workspaces'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const props = defineProps<{ kind: 'workspace' | 'project' | null; initialName?: string }>()
const emit = defineEmits<{ 'update:kind': [null] }>()

const projects = useProjectsStore()
const workspaces = useWorkspacesStore()

const name = ref('')
const description = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)

const open = computed({
  get: () => props.kind !== null,
  set: (v: boolean) => {
    if (!v) emit('update:kind', null)
  },
})

const isWorkspace = computed(() => props.kind === 'workspace')

// Whatever was typed into the switcher's filter is a naming intent, not a
// throwaway — carry it into the field instead of making them retype it.
watch(
  () => props.kind,
  (kind) => {
    if (!kind) return
    name.value = props.initialName ?? ''
    description.value = ''
    error.value = null
    submitting.value = false
  },
)

async function submit() {
  const trimmed = name.value.trim()
  if (!trimmed || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    if (isWorkspace.value) {
      const res = await apiFetch<CreateWorkspaceResponse>('/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: trimmed }),
      })
      // Full reload into the new scope — the page tree, query cache and live
      // subscription are all keyed on it (same reason switchWorkspace does).
      workspaces.switchWorkspace(res.workspaceId)
    } else {
      const res = await apiFetch<CreateProjectResponse>('/v1/projects', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: getWorkspaceId(),
          name: trimmed,
          description: description.value.trim() || null,
        }),
      })
      projects.switchProject(res.project.projectId)
    }
    // Both paths navigate away; if navigation is blocked the dialog stays
    // usable rather than silently spinning.
    void nextTick(() => {
      submitting.value = false
    })
  } catch (e) {
    error.value =
      e instanceof ApiError && e.status === 403
        ? `You do not have permission to create a ${props.kind} here.`
        : (e as Error).message
    submitting.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <DialogHeader>
        <div class="flex items-start gap-3">
          <span
            class="bg-primary/15 text-primary mt-px grid size-9 shrink-0 place-items-center rounded-lg"
          >
            <component :is="isWorkspace ? Library : Folder" class="size-4.5" />
          </span>
          <div class="min-w-0">
            <DialogTitle>{{ isWorkspace ? 'New workspace' : 'New project' }}</DialogTitle>
            <DialogDescription class="mt-1.5">
              {{
                isWorkspace
                  ? 'Its own tenant — separate members, pages and graph.'
                  : 'Groups pages inside this workspace. Every page belongs to exactly one.'
              }}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <form class="space-y-4" @submit.prevent="submit">
        <div class="space-y-1.5">
          <label
            for="switcher-create-name"
            class="text-muted-foreground block text-[11px] font-semibold tracking-wider uppercase"
          >
            Name
          </label>
          <Input
            id="switcher-create-name"
            v-model="name"
            :placeholder="isWorkspace ? 'Acme Engineering' : 'Platform docs'"
            :aria-invalid="error !== null || undefined"
            autocomplete="off"
            required
          />
        </div>

        <div v-if="!isWorkspace" class="space-y-1.5">
          <label
            for="switcher-create-description"
            class="text-muted-foreground block text-[11px] font-semibold tracking-wider uppercase"
          >
            Description <span class="font-normal normal-case">— optional</span>
          </label>
          <Input
            id="switcher-create-description"
            v-model="description"
            placeholder="What lives in here?"
            autocomplete="off"
          />
        </div>

        <p v-if="error" role="alert" class="text-destructive text-xs">{{ error }}</p>

        <DialogFooter>
          <Button type="button" variant="ghost" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="submitting || !name.trim()">
            {{ submitting ? 'Creating…' : isWorkspace ? 'Create workspace' : 'Create project' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
