<script setup lang="ts">
/**
 * User groups (#76): named sets of workspace members that page and project
 * restrictions grant to.
 *
 * One group is open at a time. Its members are fetched on opening rather than
 * with the list: the list answers "which groups exist", and a workspace with
 * forty groups should not pay for forty rosters to answer it.
 *
 * Candidates for a group come from the workspace roster the page has already
 * loaded — the API refuses anyone outside the workspace, so offering them would
 * only offer an error. A group mirrored from a connector (or provisioned by
 * SCIM) is shown read-only: the API answers 409 to any edit, because the next
 * sync would quietly undo it.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { ChevronRight, Pencil, Plus, Trash2, Users } from 'lucide-vue-next'
import type {
  UserGroupMemberEntry,
  UserGroupSummary,
  WorkspaceMemberEntry,
} from '@knowledge/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { api, fetchApi } from '@/shared/api/queries'
import { Autocomplete, type AutocompleteOption } from '@/shared/ui/autocomplete'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Skeleton } from '@/shared/ui/skeleton'
import { Textarea } from '@/shared/ui/textarea'
import UserChip from '@/widgets/person/UserChip.vue'

const { t } = useI18n()

const props = defineProps<{
  workspaceId: string
  /** The workspace roster — where a group's candidates come from. */
  members: WorkspaceMemberEntry[]
  canManage: boolean
}>()

const groups = ref<UserGroupSummary[]>([])
const loading = ref(false)
const queryClient = useQueryClient()

async function load() {
  if (!props.workspaceId) return
  loading.value = true
  try {
    // Fresh, as is a group's member list: the writes below patch the lists in
    // place, not the cache, so a cached copy would be the pre-edit one.
    groups.value = (
      await fetchApi(
        queryClient,
        '/v1/groups',
        { query: { workspaceId: props.workspaceId } },
        { fresh: true },
      )
    ).groups
  } catch (e) {
    groups.value = []
    toast.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

/** Editable here only when the caller manages the workspace and the API owns the group. */
function editable(group: UserGroupSummary): boolean {
  return props.canManage && group.source === 'manual'
}

function replace(next: UserGroupSummary) {
  groups.value = groups.value
    .map((g) => (g.groupId === next.groupId ? next : g))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/* ------------------------------------------------------------ open group */

const openId = ref<string | null>(null)
const groupMembers = ref<UserGroupMemberEntry[]>([])
const loadingMembers = ref(false)
const toAdd = ref<string[]>([])

const openGroup = computed(() => groups.value.find((g) => g.groupId === openId.value) ?? null)

// Fetched once mounted, not during SSR: the list is per-viewer and cheap.
onMounted(load)
// A group of the previous workspace is not a group of this one.
watch(
  () => props.workspaceId,
  () => {
    openId.value = null
    void load()
  },
)

async function toggle(group: UserGroupSummary) {
  toAdd.value = []
  if (openId.value === group.groupId) {
    openId.value = null
    return
  }
  openId.value = group.groupId
  groupMembers.value = []
  loadingMembers.value = true
  try {
    groupMembers.value = (
      await fetchApi(
        queryClient,
        '/v1/groups/{id}/members',
        { path: { id: group.groupId } },
        { fresh: true },
      )
    ).members
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    loadingMembers.value = false
  }
}

const candidates = computed<AutocompleteOption[]>(() => {
  const inGroup = new Set(groupMembers.value.map((m) => m.userId))
  return props.members
    .filter((m) => !inGroup.has(m.userId))
    .map((m) => ({ value: m.userId, label: `${m.displayName} · ${m.email}`, meta: t(`role.${m.role}`) }))
})

async function changeMembers(group: UserGroupSummary, change: { add?: string[]; remove?: string[] }) {
  try {
    const res = await api.put('/v1/groups/{id}/members', {
      path: { id: group.groupId },
      body: change,
    })
    groupMembers.value = res.members
    replace({ ...group, memberCount: res.members.length })
    toAdd.value = []
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/* ----------------------------------------------------- create and rename */

const formOpen = ref(false)
/** null while creating; the group being edited otherwise. */
const editing = ref<UserGroupSummary | null>(null)
const formName = ref('')
const formDescription = ref('')

function startCreate() {
  editing.value = null
  formName.value = ''
  formDescription.value = ''
  formOpen.value = true
}

function startEdit(group: UserGroupSummary) {
  editing.value = group
  formName.value = group.name
  formDescription.value = group.description ?? ''
  formOpen.value = true
}

async function submitForm() {
  const name = formName.value.trim()
  if (!name) return
  try {
    if (editing.value) {
      const updated = await api.patch('/v1/groups/{id}', {
        path: { id: editing.value.groupId },
        body: { name, description: formDescription.value },
      })
      replace(updated)
      toast.success(t('access.groups.updated', { name: updated.name }))
    } else {
      const created = await api.post('/v1/groups', {
        body: { workspaceId: props.workspaceId, name, description: formDescription.value },
      })
      groups.value = [...groups.value, created].sort((a, b) => a.name.localeCompare(b.name))
      toast.success(t('access.groups.created', { name: created.name }))
    }
    formOpen.value = false
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/* ---------------------------------------------------------------- delete */

const deleting = ref<UserGroupSummary | null>(null)

async function confirmDelete() {
  const group = deleting.value
  if (!group) return
  try {
    await api.delete('/v1/groups/{id}', { path: { id: group.groupId } })
    groups.value = groups.value.filter((g) => g.groupId !== group.groupId)
    if (openId.value === group.groupId) openId.value = null
    toast.success(t('access.groups.deleted', { name: group.name }))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    deleting.value = null
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <p class="text-muted-foreground max-w-[46rem] text-sm">{{ t('access.groups.hint') }}</p>
      <Button v-if="canManage" size="sm" @click="startCreate">
        <Plus class="size-3.5" /> {{ t('access.groups.new') }}
      </Button>
    </div>

    <div v-if="loading" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-14 w-full" />
    </div>
    <p v-else-if="groups.length === 0" class="text-muted-foreground py-10 text-center text-sm">
      {{ canManage ? t('access.groups.emptyManage') : t('access.groups.empty') }}
    </p>

    <div v-else class="divide-y rounded-xl border bg-card">
      <section v-for="group in groups" :key="group.groupId">
        <div class="flex items-center gap-3 px-4 py-3">
          <button
            type="button"
            class="focus-visible:ring-ring flex min-w-0 flex-1 items-start gap-2 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
            :aria-expanded="openId === group.groupId"
            @click="toggle(group)"
          >
            <ChevronRight
              class="text-muted-foreground mt-1 size-3.5 shrink-0 transition-transform"
              :class="openId === group.groupId ? 'rotate-90' : ''"
            />
            <span class="min-w-0">
              <span class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span class="font-medium">{{ group.name }}</span>
                <span class="text-muted-foreground text-xs tabular-nums">
                  {{ t('count.members', { n: group.memberCount }, group.memberCount) }}
                </span>
                <Badge v-if="group.source !== 'manual'" variant="outline">
                  {{ t(`access.groups.source.${group.source}`) }}
                </Badge>
              </span>
              <span v-if="group.description" class="text-muted-foreground block text-sm">
                {{ group.description }}
              </span>
            </span>
          </button>
          <template v-if="editable(group)">
            <Button
              size="icon-sm"
              variant="ghost"
              :aria-label="t('access.groups.editFor', { name: group.name })"
              @click="startEdit(group)"
            >
              <Pencil class="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              :aria-label="t('access.groups.deleteFor', { name: group.name })"
              @click="deleting = group"
            >
              <Trash2 class="size-3.5" />
            </Button>
          </template>
        </div>

        <div v-if="openId === group.groupId" class="space-y-3 border-t bg-muted/30 px-4 py-3 pl-9">
          <p v-if="group.source !== 'manual'" class="text-muted-foreground text-xs">
            {{ t('access.groups.readOnlySource') }}
          </p>

          <div v-if="loadingMembers" class="space-y-1.5">
            <Skeleton v-for="i in 2" :key="i" class="h-6 w-48" />
          </div>
          <p v-else-if="groupMembers.length === 0" class="text-muted-foreground text-sm">
            {{ t('access.groups.noMembers') }}
          </p>
          <ul v-else class="flex flex-wrap gap-x-4 gap-y-1.5">
            <li v-for="member in groupMembers" :key="member.userId" class="flex items-center gap-1.5">
              <UserChip :user-id="member.userId" :name="member.displayName" size="sm" />
              <Badge v-if="member.role === 'guest'" variant="outline">{{ t('role.guest') }}</Badge>
              <Button
                v-if="editable(group)"
                size="icon-sm"
                variant="ghost"
                class="size-6"
                :aria-label="t('access.groups.removeMember', { name: member.displayName })"
                @click="changeMembers(group, { remove: [member.userId] })"
              >
                <Trash2 class="size-3" />
              </Button>
            </li>
          </ul>

          <form
            v-if="editable(group) && openGroup"
            class="flex flex-wrap items-end gap-2"
            @submit.prevent="changeMembers(group, { add: toAdd })"
          >
            <div class="min-w-64 flex-1">
              <Autocomplete
                v-model="toAdd"
                :label="t('access.groups.addPeople')"
                :placeholder="t('access.searchUsers')"
                :options="candidates"
                :empty-hint="t('access.groups.everyoneIn')"
                multiple
              />
            </div>
            <Button type="submit" size="sm" :disabled="toAdd.length === 0">
              <Users class="size-3.5" /> {{ t('common.add') }}
            </Button>
          </form>
        </div>
      </section>
    </div>

    <Dialog v-model:open="formOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ editing ? t('access.groups.editTitle') : t('access.groups.new') }}</DialogTitle>
          <DialogDescription>{{ t('access.groups.formHint') }}</DialogDescription>
        </DialogHeader>
        <form id="group-form" class="space-y-3" @submit.prevent="submitForm">
          <div class="space-y-1.5">
            <Label for="group-name">{{ t('access.groups.name') }}</Label>
            <Input id="group-name" v-model="formName" maxlength="80" required />
          </div>
          <div class="space-y-1.5">
            <Label for="group-description">{{ t('access.groups.description') }}</Label>
            <Textarea id="group-description" v-model="formDescription" maxlength="500" rows="3" />
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" @click="formOpen = false">{{ t('common.cancel') }}</Button>
          <Button type="submit" form="group-form" :disabled="!formName.trim()">
            {{ editing ? t('common.save') : t('access.groups.create') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog :open="deleting !== null" @update:open="(v: boolean) => { if (!v) deleting = null }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('access.groups.deleteTitle', { name: deleting?.name ?? '' }) }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t('access.groups.deleteBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="confirmDelete">{{ t('common.delete') }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
