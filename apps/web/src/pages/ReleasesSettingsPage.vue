<script setup lang="ts">
/**
 * /settings/releases (#81): the named instants the graph and search can be
 * read as of — "v2.3", "Q3 audit". Not git tags: a tag here is a point on the
 * knowledge base's own timeline, and naming one is how a team says "this is
 * what we said at that release".
 *
 * Viewers read, editors tag, admins remove — the roles of the routes behind
 * it. The form sits above the list because tagging "now" is the common case
 * and should be one field and a button.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Tag, Trash2 } from 'lucide-vue-next'
import { RELEASE_TAG_NAME_PATTERN, type ListReleaseTagsResponse, type ReleaseTagDto } from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage, errorReason } from '@/api/errors'
import { getWorkspaceId } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PageState } from '@/components/layout/page'

const { t } = useI18n()
const auth = useAuthStore()
const projects = useProjectsStore()
const queryClient = useQueryClient()
const workspaceId = getWorkspaceId()

const options = apiQueryOptions('/v1/release-tags', { query: { workspaceId } })
const listQuery = useQuery(options)
/** Newest first to read; the API answers oldest first, the order a timeline wants. */
const tags = computed(() => [...((listQuery.data.value as ListReleaseTagsResponse | undefined)?.tags ?? [])].reverse())

onMounted(() => {
  if (!projects.loaded) void projects.fetchList().catch(() => undefined)
})
const projectName = (id: string | null) => (id ? (projects.items.find((p) => p.projectId === id)?.name ?? id.slice(0, 8)) : null)

/* ------------------------------------------------------------------- create */

const WORKSPACE = '__workspace'
const name = ref('')
const at = ref('') // datetime-local; empty = now
const note = ref('')
const projectId = ref(WORKSPACE)
const saving = ref(false)
const nameError = ref<string | null>(null)
const namePattern = new RegExp(RELEASE_TAG_NAME_PATTERN)
const nameInvalid = computed(() => name.value.length > 0 && !namePattern.test(name.value))

async function create() {
  if (!name.value || nameInvalid.value) return
  saving.value = true
  nameError.value = null
  try {
    await api.post('/v1/release-tags', {
      body: {
        workspaceId,
        name: name.value,
        ...(at.value ? { at: new Date(at.value).toISOString() } : {}),
        ...(note.value.trim() ? { note: note.value.trim() } : {}),
        ...(projectId.value !== WORKSPACE ? { projectId: projectId.value } : {}),
      },
    })
    toast.success(t('releaseTags.created', { name: name.value }))
    name.value = ''
    at.value = ''
    note.value = ''
    await queryClient.invalidateQueries({ queryKey: options.queryKey })
  } catch (e) {
    // A taken name is a field error, said beside the field rather than in a toast.
    if (errorReason(e) === 'release-tag-duplicate') nameError.value = t('releaseTags.duplicate', { name: name.value })
    else toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}

/* ------------------------------------------------------------------- delete */

const removing = ref<ReleaseTagDto | null>(null)
async function remove() {
  const tag = removing.value
  if (!tag) return
  try {
    await api.delete('/v1/release-tags/{id}', { path: { id: tag.id } })
    toast.success(t('releaseTags.deleted', { name: tag.name }))
    await queryClient.invalidateQueries({ queryKey: options.queryKey })
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    removing.value = null
  }
}
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-6">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('releaseTags.title') }}</h1>
      <p class="mt-0.5 max-w-2xl text-sm text-muted-foreground">{{ t('releaseTags.subtitle') }}</p>
    </div>

    <form v-if="auth.canEdit" class="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,14rem)_minmax(0,1fr)]" @submit.prevent="create">
      <div class="space-y-1.5">
        <Label for="tag-name">{{ t('releaseTags.name') }}</Label>
        <Input
          id="tag-name"
          v-model="name"
          maxlength="64"
          :placeholder="t('releaseTags.namePlaceholder')"
          autocomplete="off"
          :aria-invalid="nameInvalid || !!nameError"
          aria-describedby="tag-name-help"
          @input="nameError = null"
        />
        <p id="tag-name-help" class="text-xs" :class="nameInvalid || nameError ? 'text-destructive' : 'text-muted-foreground'">
          {{ nameError ?? (nameInvalid ? t('releaseTags.badName') : t('releaseTags.nameHelp')) }}
        </p>
      </div>
      <div class="space-y-1.5">
        <Label for="tag-at">{{ t('releaseTags.at') }}</Label>
        <Input id="tag-at" v-model="at" type="datetime-local" />
        <p class="text-xs text-muted-foreground">{{ t('releaseTags.atHelp') }}</p>
      </div>
      <div class="space-y-1.5">
        <Label for="tag-note">{{ t('releaseTags.note') }}</Label>
        <Input id="tag-note" v-model="note" maxlength="500" :placeholder="t('releaseTags.notePlaceholder')" />
      </div>
      <div class="flex flex-wrap items-end gap-3 sm:col-span-3">
        <div class="min-w-48 space-y-1.5">
          <Label for="tag-scope">{{ t('releaseTags.scope') }}</Label>
          <Select v-model="projectId">
            <SelectTrigger id="tag-scope" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem :value="WORKSPACE">{{ t('releaseTags.wholeWorkspace') }}</SelectItem>
              <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" class="ml-auto" :disabled="!name || nameInvalid || saving">
          {{ saving ? t('releaseTags.creating') : t('releaseTags.create') }}
        </Button>
      </div>
    </form>

    <PageState v-if="listQuery.isPending.value" state="loading" :rows="3" row-class="h-12" />
    <PageState v-else-if="listQuery.isError.value" state="error" :error="listQuery.error.value" />
    <PageState
      v-else-if="!tags.length"
      state="empty"
      :icon="Tag"
      :title="t('releaseTags.emptyTitle')"
      :description="t('releaseTags.empty')"
    />

    <div v-else class="overflow-x-auto rounded-md border">
      <table class="w-full text-sm">
        <thead class="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th class="px-3 py-2 font-medium">{{ t('releaseTags.name') }}</th>
            <th class="px-3 py-2 font-medium">{{ t('releaseTags.at') }}</th>
            <th class="px-3 py-2 font-medium">{{ t('releaseTags.scope') }}</th>
            <th class="px-3 py-2 font-medium">{{ t('releaseTags.note') }}</th>
            <th class="px-3 py-2" />
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="tag in tags" :key="tag.id" class="align-top">
            <td class="px-3 py-2">
              <!-- The tag is a way into the past: open the graph there. -->
              <RouterLink :to="`/documents?asOf=${encodeURIComponent(`tag:${tag.name}`)}`" class="font-mono text-ui hover:underline">
                {{ tag.name }}
              </RouterLink>
            </td>
            <td class="px-3 py-2 whitespace-nowrap" :title="formatDateTime(tag.at)">
              {{ formatDateTime(tag.at) }}
              <span class="block text-xs text-muted-foreground">{{ formatRelative(tag.at) }}</span>
            </td>
            <td class="px-3 py-2 text-muted-foreground">{{ projectName(tag.projectId) ?? t('releaseTags.wholeWorkspace') }}</td>
            <td class="max-w-80 px-3 py-2 text-muted-foreground">{{ tag.note }}</td>
            <td class="px-3 py-2 text-right">
              <Button
                v-if="auth.canAdminWorkspace"
                size="icon"
                variant="ghost"
                class="size-8 text-muted-foreground hover:text-destructive"
                :aria-label="t('releaseTags.delete', { name: tag.name })"
                @click="removing = tag"
              >
                <Trash2 class="size-4" />
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <AlertDialog :open="!!removing" @update:open="(open: boolean) => { if (!open) removing = null }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('releaseTags.deleteTitle', { name: removing?.name ?? '' }) }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t('releaseTags.deleteBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" @click="remove">
            {{ t('releaseTags.deleteConfirm') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
