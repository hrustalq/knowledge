<script setup lang="ts">
/**
 * Who may open one page or project (#76, phase 2).
 *
 * Restricting a node hides it and everything under it from anyone not granted;
 * a child can only narrow what a restricted parent already closed; the
 * workspace role stays the ceiling; workspace admins always see and manage
 * everything. Those rules live in the API — this dialog reads the node's
 * answer (`GET …/access`) and sends back the whole new state (`PUT`), so the
 * browser never decides who is in.
 *
 * Grants are edited locally and saved together, because the PUT replaces them
 * as a whole: an add, a level change and the switch are one decision, and
 * sending them one at a time would pass through states nobody chose (a page
 * restricted to nobody, for one request).
 *
 * Candidates come from the workspace roster and its groups, fetched when the
 * dialog opens — never during SSR. A caller who may not read the roster (a
 * guest handed `manage`) gets an empty picker rather than an error: they can
 * still change levels and remove grants.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Lock, LockOpen, Trash2, UserPlus, Users } from 'lucide-vue-next'
import {
  ACCESS_LEVELS,
  type AccessGrantEntry,
  type AccessLevel,
  type AccessResourceType,
  type ListUserGroupsResponse,
  type ListWorkspaceMembersResponse,
  type ResourceAccessResponse,
  type UserGroupSummary,
  type WorkspaceMemberEntry,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { errorMessage, errorReason } from '@/api/errors'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { Autocomplete, type AutocompleteOption } from '@/components/ui/autocomplete'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { PageTabs, panelId, tabId } from '@/components/layout/page'
import UserChip from '@/components/people/UserChip.vue'
import EffectiveAccess from './EffectiveAccess.vue'

const props = defineProps<{
  resourceType: AccessResourceType
  resourceId: string
  /** The page's title or the project's name, for the header. */
  title: string
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [ResourceAccessResponse] }>()

const { t } = useI18n()
const auth = useAuthStore()

const access = ref<ResourceAccessResponse | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)

/** The edit in progress; seeded from `access` and sent whole on save. */
const restricted = ref(false)
const grants = ref<AccessGrantEntry[]>([])
const saving = ref(false)
/** Bumped on each save, so an open "Who can see this" re-reads the saved state. */
const savedCount = ref(0)

type Tab = 'access-settings' | 'access-people'
const tab = ref<Tab>('access-settings')

const members = ref<WorkspaceMemberEntry[]>([])
const groups = ref<UserGroupSummary[]>([])
const toAdd = ref<string[]>([])

function seed(res: ResourceAccessResponse) {
  access.value = res
  restricted.value = res.restricted
  grants.value = res.grants.map((g) => ({ ...g }))
  toAdd.value = []
}

async function load() {
  loading.value = true
  loadError.value = null
  access.value = null
  try {
    const res = (
      props.resourceType === 'project'
        ? await api.get('/v1/projects/{id}/access', { path: { id: props.resourceId } })
        : await api.get('/v1/documents/{id}/access', { path: { id: props.resourceId } })
    ) as ResourceAccessResponse
    seed(res)
    if (res.canManage) void loadCandidates()
  } catch (e) {
    loadError.value = errorMessage(e, t)
  } finally {
    loading.value = false
  }
}

async function loadCandidates() {
  const ws = getWorkspaceId()
  const [m, g] = await Promise.allSettled([
    apiFetch<ListWorkspaceMembersResponse>(`/v1/workspaces/${ws}/members`),
    apiFetch<ListUserGroupsResponse>(`/v1/groups?workspaceId=${ws}`),
  ])
  members.value = m.status === 'fulfilled' ? m.value.members : []
  groups.value = g.status === 'fulfilled' ? g.value.groups : []
}

// Each opening starts from the server's answer: last time's unsaved edit is
// not this time's.
watch(open, (isOpen) => {
  if (!isOpen) return
  tab.value = 'access-settings'
  void load()
})

/* ------------------------------------------------------------ editing */

const keyOf = (g: { subjectType: string; subjectId: string }) => `${g.subjectType}:${g.subjectId}`

const candidates = computed<AutocompleteOption[]>(() => {
  const taken = new Set(grants.value.map(keyOf))
  const people = members.value
    .filter((m) => !m.disabled && !taken.has(`user:${m.userId}`))
    .map((m) => ({ value: `user:${m.userId}`, label: `${m.displayName} · ${m.email}`, meta: t(`role.${m.role}`) }))
  const teams = groups.value
    .filter((g) => !taken.has(`group:${g.groupId}`))
    .map((g) => ({
      value: `group:${g.groupId}`,
      label: g.name,
      meta: t('count.members', { n: g.memberCount }, g.memberCount),
    }))
  return [...teams, ...people]
})

function addSelected() {
  const next = [...grants.value]
  for (const value of toAdd.value) {
    const [type, id] = value.split(':') as ['user' | 'group', string]
    if (type === 'group') {
      const g = groups.value.find((x) => x.groupId === id)
      if (!g) continue
      next.push({ subjectType: 'group', subjectId: id, level: 'view', name: g.name, email: null, avatarUrl: null, memberCount: g.memberCount })
    } else {
      const m = members.value.find((x) => x.userId === id)
      if (!m) continue
      next.push({ subjectType: 'user', subjectId: id, level: 'view', name: m.displayName, email: m.email, avatarUrl: m.avatarUrl, memberCount: null })
    }
  }
  grants.value = next
  toAdd.value = []
}

function setLevel(grant: AccessGrantEntry, level: AccessLevel) {
  grants.value = grants.value.map((g) => (keyOf(g) === keyOf(grant) ? { ...g, level } : g))
}

function remove(grant: AccessGrantEntry) {
  grants.value = grants.value.filter((g) => keyOf(g) !== keyOf(grant))
}

/**
 * Turning the restriction on with nobody holding `manage` would leave a
 * non-admin outside the page they just closed — the API refuses that with a
 * 409. Offer the obvious fix up front: the person flipping the switch, as a
 * manager. Admins are let through by the API regardless, so they are not
 * added to a list they do not need to be on.
 */
function onRestrictedChange(value: boolean | 'indeterminate') {
  restricted.value = value === true
  if (!restricted.value || auth.canAdminWorkspace) return
  const me = auth.me
  if (!me || grants.value.some((g) => g.level === 'manage')) return
  const mine = grants.value.find((g) => g.subjectType === 'user' && g.subjectId === me.userId)
  if (mine) {
    setLevel(mine, 'manage')
    return
  }
  grants.value = [
    { subjectType: 'user', subjectId: me.userId, level: 'manage', name: me.displayName, email: me.email, avatarUrl: me.avatarUrl, memberCount: null },
    ...grants.value,
  ]
}

const dirty = computed(() => {
  const a = access.value
  if (!a) return false
  if (a.restricted !== restricted.value) return true
  if (a.grants.length !== grants.value.length) return true
  const before = new Map(a.grants.map((g) => [keyOf(g), g.level]))
  return grants.value.some((g) => before.get(keyOf(g)) !== g.level)
})

async function save() {
  if (!access.value || saving.value) return
  saving.value = true
  const body = {
    restricted: restricted.value,
    grants: grants.value.map(({ subjectType, subjectId, level }) => ({ subjectType, subjectId, level })),
  }
  try {
    const res = (
      props.resourceType === 'project'
        ? await api.put('/v1/projects/{id}/access', { path: { id: props.resourceId }, body })
        : await api.put('/v1/documents/{id}/access', { path: { id: props.resourceId }, body })
    ) as ResourceAccessResponse
    seed(res)
    savedCount.value += 1
    toast.success(t('access.page.saved'))
    emit('saved', res)
  } catch (e) {
    // The server names who would be locked out and why; the hint says what to do.
    if (errorReason(e) === 'access.selfLockout') {
      toast.error(errorMessage(e, t), { description: t('access.page.selfLockoutHint') })
    } else {
      toast.error(errorMessage(e, t))
    }
  } finally {
    saving.value = false
  }
}

/* ----------------------------------------------------------- reading */

const tabs = computed(() => [
  { key: 'access-settings' as const, label: t('access.page.tabSettings') },
  { key: 'access-people' as const, label: t('access.page.tabPeople') },
])

const heading = computed(() =>
  props.resourceType === 'project'
    ? t('access.page.titleProject', { title: props.title })
    : t('access.page.title', { title: props.title }),
)
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle class="truncate">{{ heading }}</DialogTitle>
        <DialogDescription>
          {{ resourceType === 'project' ? t('access.page.introProject') : t('access.page.intro') }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="loading" class="space-y-2">
        <Skeleton class="h-14 w-full" />
        <Skeleton v-for="i in 2" :key="i" class="h-9 w-full" />
      </div>
      <p v-else-if="loadError" class="text-destructive text-sm">{{ loadError }}</p>

      <template v-else-if="access">
        <PageTabs v-if="access.canManage" v-model="tab" :tabs="tabs" :label="t('access.page.tabsLabel')" />

        <div
          v-show="tab === 'access-settings' || !access.canManage"
          :id="panelId('access-settings')"
          role="tabpanel"
          :aria-labelledby="access.canManage ? tabId('access-settings') : undefined"
          class="max-h-[60vh] space-y-4 overflow-y-auto pr-1 text-sm"
        >
          <!-- What is already closed above this node. Read-only here: it is
               changed on the node that set it. -->
          <section v-if="access.inherited.length" class="space-y-1.5">
            <h3 class="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              {{ t('access.page.inheritedTitle') }}
            </h3>
            <ul class="space-y-1">
              <li
                v-for="node in access.inherited"
                :key="node.resourceId"
                class="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5"
              >
                <Lock class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                <!-- A null title is an ancestor the caller may not open: it is
                     named by what it is, never by a guess at what it says. -->
                <span v-if="node.title === null" class="text-muted-foreground min-w-0 flex-1 truncate italic">
                  {{ t('access.page.hiddenAncestor') }}
                </span>
                <span v-else class="min-w-0 flex-1 truncate">
                  {{ node.resourceType === 'project' ? t('access.page.restrictedByProject') : t('access.page.restrictedByPage') }}
                  <span class="font-medium">{{ node.title }}</span>
                </span>
                <span class="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {{ t('access.page.grantCount', { n: node.grantCount }, node.grantCount) }}
                </span>
              </li>
            </ul>
            <p class="text-muted-foreground text-xs">{{ t('access.page.narrowOnly') }}</p>
          </section>

          <!-- A manager edits; everyone else is told where they stand. -->
          <template v-if="access.canManage">
            <Label
              for="kn-access-restricted"
              class="has-[[data-state=checked]]:border-primary flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal"
            >
              <Checkbox
                id="kn-access-restricted"
                :model-value="restricted"
                class="mt-0.5"
                @update:model-value="onRestrictedChange"
              />
              <span class="min-w-0 space-y-0.5">
                <span class="flex items-center gap-1.5 font-medium">
                  <Lock v-if="restricted" class="size-3.5" aria-hidden="true" />
                  <LockOpen v-else class="size-3.5" aria-hidden="true" />
                  {{ resourceType === 'project' ? t('access.page.restrictProject') : t('access.page.restrict') }}
                </span>
                <span class="text-muted-foreground block text-xs">
                  {{ restricted ? t('access.page.restrictedHint') : t('access.page.openHint') }}
                </span>
              </span>
            </Label>

            <section class="space-y-2">
              <h3 class="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                {{ t('access.page.grantsTitle') }}
              </h3>
              <p v-if="grants.length === 0" class="text-muted-foreground text-xs">
                {{ restricted ? t('access.page.noGrantsRestricted') : t('access.page.noGrants') }}
              </p>
              <ul v-else class="divide-y rounded-md border">
                <li v-for="grant in grants" :key="keyOf(grant)" class="flex items-center gap-2 px-2.5 py-1.5">
                  <div class="flex min-w-0 flex-1 items-center gap-2">
                    <UserChip
                      v-if="grant.subjectType === 'user'"
                      :user-id="grant.subjectId"
                      :name="grant.name ?? t('access.page.goneSubject')"
                      size="sm"
                    />
                    <template v-else>
                      <span class="bg-muted grid size-5 shrink-0 place-items-center rounded-full">
                        <Users class="size-3" aria-hidden="true" />
                      </span>
                      <span class="truncate font-medium">{{ grant.name ?? t('access.page.goneSubject') }}</span>
                      <span v-if="grant.memberCount !== null" class="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {{ t('count.members', { n: grant.memberCount }, grant.memberCount) }}
                      </span>
                    </template>
                  </div>
                  <Select
                    :model-value="grant.level"
                    @update:model-value="(v) => setLevel(grant, v as AccessLevel)"
                  >
                    <SelectTrigger
                      class="h-7 w-28 shrink-0 text-xs"
                      :aria-label="t('access.page.levelFor', { name: grant.name ?? '' })"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="level in ACCESS_LEVELS" :key="level" :value="level">
                        {{ t(`access.level.${level}`) }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    :aria-label="t('access.page.removeGrant', { name: grant.name ?? '' })"
                    @click="remove(grant)"
                  >
                    <Trash2 class="size-3.5" />
                  </Button>
                </li>
              </ul>

              <form class="flex flex-wrap items-end gap-2" @submit.prevent="addSelected">
                <div class="min-w-56 flex-1">
                  <Autocomplete
                    v-model="toAdd"
                    :label="t('access.page.addLabel')"
                    :placeholder="t('access.page.addPlaceholder')"
                    :options="candidates"
                    :empty-hint="t('access.page.addEmpty')"
                    multiple
                  />
                </div>
                <Button type="submit" size="sm" variant="outline" :disabled="toAdd.length === 0">
                  <UserPlus class="size-3.5" /> {{ t('common.add') }}
                </Button>
              </form>
              <p class="text-muted-foreground text-xs">{{ t('access.page.ceilingHint') }}</p>
            </section>
          </template>

          <section v-else class="space-y-2">
            <p class="flex items-center gap-2">
              <Lock v-if="access.restricted" class="size-3.5 shrink-0" aria-hidden="true" />
              <LockOpen v-else class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
              {{
                access.restricted
                  ? t('access.page.isRestricted')
                  : access.inherited.length
                    ? t('access.page.isInheritedOnly')
                    : t('access.page.isOpen')
              }}
            </p>
            <p class="flex items-center gap-2">
              <span class="text-muted-foreground">{{ t('access.page.yourLevel') }}</span>
              <Badge variant="outline">{{ t(`access.level.${access.level}`) }}</Badge>
            </p>
            <p class="text-muted-foreground text-xs">{{ t('access.page.askManager') }}</p>
          </section>
        </div>

        <div
          v-if="access.canManage && tab === 'access-people'"
          :id="panelId('access-people')"
          role="tabpanel"
          :aria-labelledby="tabId('access-people')"
          class="max-h-[60vh] overflow-y-auto pr-1"
        >
          <!-- Reflects what is saved, not the edit in progress. -->
          <p v-if="dirty" class="mb-2 text-xs text-amber-700 dark:text-amber-400">{{ t('access.page.unsavedNote') }}</p>
          <EffectiveAccess :key="savedCount" :resource-type="resourceType" :resource-id="resourceId" />
        </div>
      </template>

      <DialogFooter>
        <Button variant="ghost" @click="open = false">
          {{ access?.canManage ? t('common.cancel') : t('common.close') }}
        </Button>
        <Button v-if="access?.canManage" :disabled="!dirty || saving" @click="save">
          {{ saving ? t('common.saving') : t('common.save') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
