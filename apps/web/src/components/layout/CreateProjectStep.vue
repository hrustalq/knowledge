<script setup lang="ts">
/**
 * "Add a project" as a step rather than a destination — for every place where
 * creating one is the obvious next move but not the thing the user asked for.
 *
 * It always names the workspace it is creating into, because the one caller
 * that matters most (a workspace that was created seconds ago) has not been
 * switched into yet: without the name, "Create" would look like it targets the
 * workspace still on screen behind the dialog.
 */
import { nextTick, onMounted, ref } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import type { ProjectSummary } from '@knowledge/contracts'
import { ApiError } from '@/lib/api'
import { createProject } from '@/lib/scopes'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DialogFooter } from '@/components/ui/dialog'

const props = defineProps<{ workspaceId: string; workspaceName?: string | null }>()
const emit = defineEmits<{ created: [ProjectSummary]; skip: [] }>()

const name = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)
// The step mounts after the dialog already placed initial focus, so it has to
// claim the field itself.
onMounted(() => {
  void nextTick(() => document.getElementById('create-project-step-name')?.focus())
})

async function submit() {
  const trimmed = name.value.trim()
  if (!trimmed || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    emit('created', await createProject(props.workspaceId, trimmed))
  } catch (e) {
    error.value =
      e instanceof ApiError && e.status === 403
        ? 'You do not have permission to create a project here.'
        : (e as Error).message
    submitting.value = false
  }
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="submit">
    <div class="space-y-1.5">
      <label
        for="create-project-step-name"
        class="text-muted-foreground block text-[11px] font-semibold tracking-wider uppercase"
      >
        Project name
      </label>
      <Input
        id="create-project-step-name"
        v-model="name"
        placeholder="Platform docs"
        :aria-invalid="error !== null || undefined"
        :disabled="submitting"
        autocomplete="off"
      />
      <p class="text-muted-foreground text-xs">
        Goes into {{ workspaceName ?? 'the new workspace' }}. You can add more later.
      </p>
    </div>

    <p v-if="error" role="alert" class="text-destructive text-xs">{{ error }}</p>

    <DialogFooter class="pt-2">
      <Button type="button" variant="ghost" :disabled="submitting" @click="emit('skip')">
        Skip for now
      </Button>
      <Button type="submit" :disabled="submitting || !name.trim()">
        <Loader2 v-if="submitting" class="size-4 animate-spin" />
        {{ submitting ? 'Creating…' : 'Create project' }}
      </Button>
    </DialogFooter>
  </form>
</template>
