<script setup lang="ts">
/**
 * "Create a workspace and jump into it", in stages.
 *
 * A workspace with no project cannot hold a page at all, so the dialog does
 * not close on success: it reports the result in place and offers the first
 * project as a skippable step — a quick blank one, or the blueprint wizard
 * (`/projects/new`, #716) once the app has switched into the new workspace.
 * A project on its own is always the wizard; this dialog no longer makes one.
 *
 * The work happens where the user started it. The loader, the error and the
 * success all render inside the dialog rather than as toasts behind it, and
 * the workspace switch — a full reload — is deferred to the very end, so the
 * follow-up step is not yanked out from under them.
 *
 * Errors return to the form with the typed values intact: the most common one
 * is a name clash, and that is fixed in the field, not on a dead-end screen.
 */
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { Check, Library, Loader2 } from 'lucide-vue-next'
import { isApiRequestError } from '@/shared/api/queries'
import { createWorkspace, type ScopeCreated } from '@/modules/projects/model/scopes'
import { useWorkspacesStore } from '@/stores/workspaces'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import CreateProjectStep from './CreateProjectStep.vue'

const { t } = useI18n()

const props = defineProps<{ kind: 'workspace' | null; initialName?: string }>()
const emit = defineEmits<{ 'update:kind': [null]; created: [ScopeCreated] }>()

const workspaces = useWorkspacesStore()

type Stage = 'form' | 'project'
const stage = ref<Stage>('form')
/**
 * Submitting is a state of the form, not a stage of its own: swapping the
 * whole form out for a loader would take the footer with it, and buttons that
 * vanish and come back are the thing that makes a dialog feel like it jumped.
 * Only the fields are replaced, and by a block sized to what it replaced.
 */
const busy = ref(false)

const name = ref('')
const error = ref<string | null>(null)
/** Set the moment the create succeeds — the flow can no longer be cancelled. */
const result = ref<ScopeCreated | null>(null)
let finishing = false

const open = computed({
  get: () => props.kind !== null,
  set: (v: boolean) => {
    if (v) return
    // Dismissing after the workspace exists is a skip, not a cancel: finish the
    // flow so the thing they made is actually switched into.
    if (result.value) finish()
    else emit('update:kind', null)
  },
})

// Whatever was typed into the switcher's filter is a naming intent, not a
// throwaway — carry it into the field instead of making them retype it.
watch(
  () => props.kind,
  (kind) => {
    if (!kind) return
    stage.value = 'form'
    busy.value = false
    name.value = props.initialName ?? ''
    error.value = null
    result.value = null
    finishing = false
  },
  // The rail mounts the dialog on its first open (#279).
  { immediate: true },
)

const header = computed(() =>
  stage.value === 'project'
    ? { icon: Check, title: `${result.value?.name} created`, body: t('nav.firstProjectHint') }
    : { icon: Library, title: t('nav.workspaceOption'), body: t('nav.workspaceOptionHint') },
)

async function submit() {
  const trimmed = name.value.trim()
  if (!trimmed || busy.value) return
  busy.value = true
  error.value = null
  try {
    const res = await createWorkspace(trimmed)
    result.value = { kind: 'workspace', id: res.workspaceId, name: res.name }
    // The creator is this workspace's admin, so the project step can post
    // into it even though the app has not switched scope yet.
    stage.value = 'project'
  } catch (e) {
    error.value = isApiRequestError(e) && e.status === 403 ? t('nav.noWorkspacePermission') : (e as Error).message
  } finally {
    busy.value = false
  }
}

/**
 * Switch into the new workspace and close. The switch reloads the app (the
 * page tree, query cache and live subscription are all keyed on it), so it has
 * to be the last thing that happens. `to` is where the reload lands — the
 * wizard, when they chose to start the first project from a blueprint.
 */
function finish(to?: string) {
  if (finishing) return
  finishing = true
  const created = result.value
  emit('update:kind', null)
  if (!created) return
  emit('created', created)
  workspaces.switchWorkspace(created.id, to)
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <!-- Header and body swap as one keyed unit: `mode="out-in"` freezes the
           element on its way out, so a header living outside the transition
           would announce the next stage over the previous stage's content. -->
      <Transition name="stage" mode="out-in">
        <div :key="stage" class="grid gap-5">
          <DialogHeader>
            <div class="flex items-start gap-3">
              <span class="bg-primary/15 text-primary mt-px grid size-9 shrink-0 place-items-center rounded-lg">
                <component :is="header.icon" class="size-4.5" />
              </span>
              <div class="min-w-0">
                <DialogTitle>{{ header.title }}</DialogTitle>
                <DialogDescription class="mt-1.5">{{ header.body }}</DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <form v-if="stage === 'form'" class="space-y-4" @submit.prevent="submit">
            <!-- Sized to the field it stands in for, so the footer below does
                 not shift while the request is in flight. -->
            <div
              v-if="busy"
              class="text-muted-foreground flex min-h-19 flex-col items-center justify-center gap-2.5 text-sm"
              role="status"
            >
              <Loader2 class="text-primary size-5 animate-spin" />
              <p>{{ t('common.creatingNamed', { name: name.trim() }) }}</p>
            </div>

            <template v-else>
              <div class="space-y-1.5">
                <label
                  for="switcher-create-name"
                  class="text-muted-foreground block text-caption font-semibold tracking-wider uppercase"
                >
                  {{ t('nav.name') }}
                </label>
                <Input
                  id="switcher-create-name"
                  v-model="name"
                  :placeholder="t('nav.workspaceNamePlaceholder')"
                  :aria-invalid="error !== null || undefined"
                  autocomplete="off"
                  required
                />
              </div>

              <p v-if="error" role="alert" class="text-destructive text-xs">{{ error }}</p>
            </template>

            <DialogFooter class="pt-2">
              <Button type="button" variant="ghost" :disabled="busy" @click="open = false">
                {{ t('common.cancel') }}
              </Button>
              <Button type="submit" :disabled="busy || !name.trim()">
                {{ busy ? t('nav.creating') : t('nav.createWorkspace') }}
              </Button>
            </DialogFooter>
          </form>

          <CreateProjectStep
            v-else
            :workspace-id="result?.id ?? ''"
            :workspace-name="result?.name"
            @created="finish()"
            @skip="finish()"
            @wizard="finish('/projects/new')"
          />
        </div>
      </Transition>
    </DialogContent>
  </Dialog>
</template>
