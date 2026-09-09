<script setup lang="ts">
/**
 * "Create a scope and jump into it", in stages.
 *
 * Creating a workspace or a project is never the whole job — a workspace with
 * no project cannot hold a page at all, and a project is usually made so that
 * someone else can work in it. So the dialog does not close on success: it
 * reports the result in place and offers the next move as a skippable step.
 *   workspace → create its first project
 *   project   → invite people to the workspace
 *
 * The work happens where the user started it. The loader, the error and the
 * success all render inside the dialog rather than as toasts behind it, and
 * the scope switch — which for a workspace means a full reload — is deferred
 * to the very end, so the follow-up step is not yanked out from under them.
 *
 * Errors return to the form with the typed values intact: the most common one
 * is a name clash, and that is fixed in the field, not on a dead-end screen.
 */
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { Check, Folder, Library, Loader2 } from 'lucide-vue-next'
import { ApiError, getWorkspaceId } from '@/lib/api'
import {
  createProject,
  createWorkspace,
  workspaceHasCandidates,
  type ScopeCreated,
} from '@/lib/scopes'
import { useAuthStore } from '@/stores/auth'
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
import AddMembersStep from './AddMembersStep.vue'
import CreateProjectStep from './CreateProjectStep.vue'

const { t } = useI18n()

const props = defineProps<{ kind: 'workspace' | 'project' | null; initialName?: string }>()
const emit = defineEmits<{ 'update:kind': [null]; created: [ScopeCreated] }>()

const auth = useAuthStore()
const projects = useProjectsStore()
const workspaces = useWorkspacesStore()

/** 'project' and 'members' are the follow-up steps; both are skippable. */
type Stage = 'form' | 'project' | 'members'
const stage = ref<Stage>('form')
/**
 * Submitting is a state of the form, not a stage of its own: swapping the
 * whole form out for a loader would take the footer with it, and buttons that
 * vanish and come back are the thing that makes a dialog feel like it jumped.
 * Only the fields are replaced, and by a block sized to what it replaced.
 */
const busy = ref(false)

const name = ref('')
const description = ref('')
const error = ref<string | null>(null)
/** Set the moment the create succeeds — the flow can no longer be cancelled. */
const result = ref<ScopeCreated | null>(null)
let finishing = false

const open = computed({
  get: () => props.kind !== null,
  set: (v: boolean) => {
    if (v) return
    // Dismissing after the scope exists is a skip, not a cancel: finish the
    // flow so the thing they made is actually switched into.
    if (result.value) void finish()
    else emit('update:kind', null)
  },
})

const isWorkspace = computed(() => props.kind === 'workspace')

// Whatever was typed into the switcher's filter is a naming intent, not a
// throwaway — carry it into the field instead of making them retype it.
watch(
  () => props.kind,
  (kind) => {
    if (!kind) return
    stage.value = 'form'
    busy.value = false
    name.value = props.initialName ?? ''
    description.value = ''
    error.value = null
    result.value = null
    finishing = false
  },
)

const header = computed(() => {
  if (stage.value === 'project') {
    return {
      icon: Check,
      title: `${result.value?.name} created`,
      body: t('nav.firstProjectHint'),
    }
  }
  if (stage.value === 'members') {
    return {
      icon: Check,
      title: `${result.value?.name} created`,
      body: `Invite people to ${workspaceName.value} so they can work in it.`,
    }
  }
  return isWorkspace.value
    ? {
        icon: Library,
        title: t('nav.workspaceOption'),
        body: t('nav.workspaceOptionHint'),
      }
    : {
        icon: Folder,
        title: t('nav.projectOption'),
        body: t('nav.projectOptionHint'),
      }
})

const workspaceName = computed(
  () =>
    workspaces.items.find((w) => w.workspaceId === getWorkspaceId())?.name ?? t('nav.thisWorkspace'),
)

async function submit() {
  const trimmed = name.value.trim()
  if (!trimmed || busy.value) return
  busy.value = true
  error.value = null
  try {
    if (isWorkspace.value) {
      const res = await createWorkspace(trimmed)
      result.value = { kind: 'workspace', id: res.workspaceId, name: res.name }
      // The creator is this workspace's admin, so the project step can post
      // into it even though the app has not switched scope yet.
      stage.value = 'project'
    } else {
      const project = await createProject(getWorkspaceId(), trimmed, description.value.trim() || null)
      result.value = { kind: 'project', id: project.projectId, name: project.name }
      // Two reasons to skip straight out: membership is admin-only, so an
      // editor would be handed a 403 as a reward for creating something; and
      // a workspace everyone already belongs to has nobody left to invite.
      const canInvite =
        auth.canAdminWorkspace && (await workspaceHasCandidates(getWorkspaceId()))
      if (canInvite) stage.value = 'members'
      else await finish()
    }
  } catch (e) {
    error.value =
      e instanceof ApiError && e.status === 403
        ? `You do not have permission to create a ${props.kind} here.`
        : (e as Error).message
  } finally {
    busy.value = false
  }
}

function onProjectCreated() {
  // Nothing to switch here: setActiveWorkspace clears the remembered project,
  // and on the other side of the reload the roster resolves the only project
  // there is — the one just made — as active.
  void finish()
}

/**
 * Apply the scope switch and close. A workspace switch reloads the app (the
 * page tree, query cache and live subscription are all keyed on it), so it has
 * to be the last thing that happens.
 */
async function finish() {
  if (finishing) return
  finishing = true
  const created = result.value
  emit('update:kind', null)
  if (!created) return

  if (created.kind === 'project') {
    // Best-effort, in that order: the roster first, because switching to an id
    // the store has never seen would leave the rail titled after a project it
    // cannot name. Neither is allowed to throw — the project already exists on
    // the server, and a refetch that fails on the way out must not cost the
    // user the scope switch as well. The live event heals a stale roster.
    await projects.fetchList().catch((e) => console.error('post-create roster refresh failed', e))
    await projects.switchProject(created.id).catch((e) => console.error('post-create switch failed', e))
    emit('created', created)
  } else {
    emit('created', created)
    workspaces.switchWorkspace(created.id)
  }
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
              <span
                class="bg-primary/15 text-primary mt-px grid size-9 shrink-0 place-items-center rounded-lg"
              >
                <component :is="header.icon" class="size-4.5" />
              </span>
              <div class="min-w-0">
                <DialogTitle>{{ header.title }}</DialogTitle>
                <!-- The workspace name is held together explicitly: balanced
                     wrapping still put the break inside "Demo Workspace",
                     and a proper noun split across two lines reads as two
                     different things. -->
                <DialogDescription class="mt-1.5">
                  <template v-if="stage === 'members'">
                    <i18n-t keypath="access.inviteTo" tag="span" scope="global">
                      <template #workspace><span class="whitespace-nowrap">{{ workspaceName }}</span></template>
                    </i18n-t>
                  </template>
                  <template v-else>{{ header.body }}</template>
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <form v-if="stage === 'form'" class="space-y-4" @submit.prevent="submit">
            <!-- Sized to the fields it stands in for, so the footer below does
                 not shift while the request is in flight. -->
            <div
              v-if="busy"
              class="text-muted-foreground flex flex-col items-center justify-center gap-2.5 text-sm"
              :class="isWorkspace ? 'min-h-19' : 'min-h-37'"
              role="status"
            >
              <Loader2 class="text-primary size-5 animate-spin" />
              <p>Creating “{{ name.trim() }}”…</p>
            </div>

            <template v-else>
              <div class="space-y-1.5">
                <label
                  for="switcher-create-name"
                  class="text-muted-foreground block text-[11px] font-semibold tracking-wider uppercase"
                >
                  {{ t('nav.name') }}
                </label>
                <Input
                  id="switcher-create-name"
                  v-model="name"
                  :placeholder="isWorkspace ? t('nav.workspaceNamePlaceholder') : t('nav.projectNamePlaceholder')"
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
                  {{ t('nav.description') }}
                  <span class="font-normal normal-case">{{ t('nav.optionalSuffix') }}</span>
                </label>
                <Input
                  id="switcher-create-description"
                  v-model="description"
                  :placeholder="t('nav.scopeDescriptionPlaceholder')"
                  autocomplete="off"
                />
              </div>

              <p v-if="error" role="alert" class="text-destructive text-xs">{{ error }}</p>
            </template>

            <DialogFooter class="pt-2">
              <Button type="button" variant="ghost" :disabled="busy" @click="open = false">
                {{ t('common.cancel') }}
              </Button>
              <Button type="submit" :disabled="busy || !name.trim()">
                {{ busy ? t('nav.creating') : isWorkspace ? t('nav.createWorkspace') : t('nav.createProject') }}
              </Button>
            </DialogFooter>
          </form>

          <CreateProjectStep
            v-else-if="stage === 'project'"
            :workspace-id="result?.id ?? ''"
            :workspace-name="result?.name"
            @created="onProjectCreated"
            @skip="finish()"
          />

          <AddMembersStep
            v-else
            :workspace-id="getWorkspaceId()"
            :workspace-name="workspaceName"
            @done="finish()"
          />
        </div>
      </Transition>
    </DialogContent>
  </Dialog>
</template>
