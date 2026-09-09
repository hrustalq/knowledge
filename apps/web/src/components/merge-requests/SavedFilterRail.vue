<script setup lang="ts">
/**
 * The merge-request list's filter rail.
 *
 * It is deliberately *not* a second funnel. Filters are still composed in one
 * place — the search bar — and this rail never offers a field to add. What it
 * does is the two things the bar structurally cannot:
 *
 * - It shows the *whole* narrowing. The status lives in the tabs and the title
 *   text lives in the input, so the bar's chips are only part of the answer.
 *   The manifest here is the complete one, which is what makes it the thing
 *   worth saving: what you read is exactly what gets stored.
 * - It remembers. A named view is restored by number (`#7`), which is also the
 *   `?view=` link, so a narrowing outlives the session that built it.
 *
 * Views are private to whoever saved them.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type { Component } from 'vue'
import {
  Bookmark,
  Check,
  CircleDot,
  Link2,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  X,
} from 'lucide-vue-next'
import type { ListSavedFiltersResponse, SavedFilter } from '@knowledge/contracts'
import type { ActiveFilter } from '@/components/ui/filter-bar'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  sameQuery,
  toSavedQuery,
  useMrFilterFields,
  type MrState,
} from './mr-filters'

const { t } = useI18n()

const props = defineProps<{
  state: MrState
  search: string
  filters: ActiveFilter[]
  /** The saved view currently applied, if the narrowing came from one. */
  activeId: number | null
}>()

const emit = defineEmits<{
  'update:state': [MrState]
  'update:search': [string]
  'update:filters': [ActiveFilter[]]
  apply: [SavedFilter]
  clear: []
}>()

const { fieldsByKey, valueLabel } = useMrFilterFields()
const queryClient = useQueryClient()

// --- the applied manifest ---------------------------------------------------
/**
 * Every axis currently narrowing the list, in one list. Status and title text
 * are rows here even though they are not chips — the point of the manifest is
 * that nothing narrowing the list is missing from it.
 */
interface AppliedRow {
  id: string
  icon: Component
  label: string
  value: string
  remove: () => void
}

const appliedRows = computed<AppliedRow[]>(() => {
  const rows: AppliedRow[] = []

  // 'all' is the absence of a status filter, so it is not a row.
  if (props.state !== 'all') {
    rows.push({
      id: 'status',
      icon: CircleDot,
      label: t('filters.status'),
      value: t(`mr.state${props.state[0].toUpperCase()}${props.state.slice(1)}`),
      remove: () => emit('update:state', 'all'),
    })
  }

  if (props.search) {
    rows.push({
      id: 'search',
      icon: Search,
      label: t('filters.title'),
      value: `“${props.search}”`,
      remove: () => emit('update:search', ''),
    })
  }

  for (const filter of props.filters) {
    // A chip mid-build narrows nothing, so it is not part of the narrowing.
    const value = filter.values[0]
    if (!value) continue
    const field = fieldsByKey.value.get(filter.key)
    rows.push({
      id: `chip:${filter.key}`,
      icon: field?.icon ?? CircleDot,
      label: field?.label ?? filter.key,
      value: valueLabel(filter.key, value),
      remove: () => emit('update:filters', props.filters.filter((f) => f.key !== filter.key)),
    })
  }

  return rows
})

const narrowed = computed(() => appliedRows.value.length > 0)

/** The manifest as it would be stored — the same value the save buttons send. */
const liveQuery = computed(() => toSavedQuery(props.state, props.search, props.filters))

// --- saved views ------------------------------------------------------------
const workspaceId = getWorkspaceId()
const listKey = ['/v1/merge-requests/filters', null, { workspaceId }] as const

const savedQuery = useQuery(
  apiQueryOptions('/v1/merge-requests/filters', { query: { workspaceId } }),
)
const saved = computed<SavedFilter[]>(
  () => (savedQuery.data.value as ListSavedFiltersResponse | undefined)?.filters ?? [],
)
const active = computed(() => saved.value.find((f) => f.id === props.activeId) ?? null)

/**
 * An applied view whose narrowing has since been edited. Saying so is the whole
 * reason to compare: a rail that kept the view highlighted after you changed a
 * filter would be claiming to show something it is not.
 */
const modified = computed(() => !!active.value && !sameQuery(active.value.query, liveQuery.value))

const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey })

const createFilter = useApiMutation('post', '/v1/merge-requests/filters')
const patchFilter = useApiMutation('patch', '/v1/merge-requests/filters/{filterId}')
const deleteFilter = useApiMutation('delete', '/v1/merge-requests/filters/{filterId}')

/** Server messages are the useful ones here (duplicate name, lost membership). */
const failed = (err: unknown) => toast.error((err as Error)?.message ?? t('filters.saveFailed'))

// --- naming (inline, not a dialog) -----------------------------------------
// Saving is one field and one button; interrupting the page for it would cost
// more attention than the task is worth.
const naming = ref(false)
const draftName = ref('')
const nameInput = ref<{ $el?: HTMLInputElement } | null>(null)

async function startNaming() {
  naming.value = true
  draftName.value = ''
  await nextTick()
  nameInput.value?.$el?.focus()
}

function cancelNaming() {
  naming.value = false
  draftName.value = ''
}

async function saveAsNew() {
  const name = draftName.value.trim()
  if (!name) return
  try {
    const created = (await createFilter.mutateAsync({
      body: { workspaceId, name, query: liveQuery.value },
    })) as SavedFilter
    cancelNaming()
    await invalidate()
    emit('apply', created)
  } catch (err) {
    failed(err)
  }
}

/** Overwrite the applied view with what is on screen now. */
async function updateActive() {
  const current = active.value
  if (!current) return
  try {
    const next = (await patchFilter.mutateAsync({
      path: { filterId: current.id },
      body: { query: liveQuery.value },
    })) as SavedFilter
    await invalidate()
    emit('apply', next)
  } catch (err) {
    failed(err)
  }
}

// --- renaming ---------------------------------------------------------------
const renamingId = ref<number | null>(null)
const renameDraft = ref('')

async function startRename(filter: SavedFilter) {
  renamingId.value = filter.id
  renameDraft.value = filter.name
  await nextTick()
  document.querySelector<HTMLInputElement>('[data-kn-rename-input]')?.select()
}

async function commitRename() {
  const id = renamingId.value
  const name = renameDraft.value.trim()
  if (id === null) return
  if (!name || name === saved.value.find((f) => f.id === id)?.name) {
    renamingId.value = null
    return
  }
  try {
    await patchFilter.mutateAsync({ path: { filterId: id }, body: { name } })
    renamingId.value = null
    await invalidate()
  } catch (err) {
    failed(err)
  }
}

// --- deleting ---------------------------------------------------------------
// A saved view has no undo and no second copy, so the one destructive action
// here asks first.
const pendingDelete = ref<SavedFilter | null>(null)

async function confirmDelete() {
  const filter = pendingDelete.value
  pendingDelete.value = null
  if (!filter) return
  try {
    await deleteFilter.mutateAsync({ path: { filterId: filter.id } })
    await invalidate()
    if (props.activeId === filter.id) emit('clear')
  } catch (err) {
    failed(err)
  }
}

async function copyLink(filter: SavedFilter) {
  const url = `${window.location.origin}${window.location.pathname}?view=${filter.id}`
  try {
    await navigator.clipboard.writeText(url)
    toast.success(t('filters.linkCopied'))
  } catch {
    // Clipboard access can be refused outright; showing the link still lets
    // the person copy it by hand rather than leaving the click unanswered.
    toast(url)
  }
}

// A fresh narrowing after a save should not leave a stale name in the box.
watch(() => props.activeId, cancelNaming)

/**
 * The second line of a saved row, in the same role as a settings link's hint:
 * what you would be switching to. The number leads because it is the address —
 * it is what `?view=` carries and what you quote to find this filter again.
 */
function summaryOf(filter: SavedFilter): string {
  const q = filter.query
  const parts = [`#${filter.id}`]
  if (q.status && q.status !== 'all') {
    parts.push(t(`mr.state${q.status[0].toUpperCase()}${q.status.slice(1)}`))
  }
  const count = (q.chips?.filter((c) => c.values[0]).length ?? 0) + (q.search ? 1 : 0)
  if (count) parts.push(t('filters.nApplied', count))
  return parts.join(' · ')
}
</script>

<template>
  <div class="py-2">
    <!-- Applied ---------------------------------------------------------- -->
    <div class="flex items-center gap-2 px-3 pb-1 pt-2">
      <h2 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {{ t('filters.applied') }}
      </h2>
      <!-- Clear belongs to what it clears, not beside the save controls: a
           shared row cost both labels their width once Russian ran long. -->
      <button
        v-if="narrowed"
        type="button"
        class="ml-auto rounded px-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        @click="emit('clear')"
      >
        {{ t('common.clear') }}
      </button>
    </div>

    <p v-if="!narrowed" class="px-3 pb-2 text-xs leading-relaxed text-muted-foreground">
      {{ t('filters.appliedEmpty') }}
    </p>

    <ul v-else>
      <li
        v-for="row in appliedRows"
        :key="row.id"
        class="flex items-center text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
      >
        <span class="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-sm">
          <component :is="row.icon" class="size-4 shrink-0 text-muted-foreground" />
          <span class="min-w-0">
            <span class="block truncate text-[11px] text-muted-foreground">{{ row.label }}</span>
            <span class="block truncate" :title="row.value">{{ row.value }}</span>
          </span>
        </span>
        <!-- Always drawn, not hover-revealed: a control that appears only under
             a pointer is unreachable by touch and invisible to anyone scanning
             what they can undo. -->
        <button
          type="button"
          class="mr-1.5 shrink-0 rounded p-1 text-muted-foreground/70 transition-colors hover:bg-background hover:text-foreground"
          :aria-label="t('filters.removeNamed', { name: row.label })"
          @click="row.remove()"
        >
          <X class="size-3.5" />
        </button>
      </li>
    </ul>

    <!-- Naming happens where the manifest is, so the thing being named is still
         on screen while you name it. -->
    <div v-if="narrowed" class="px-3 py-2">
      <div v-if="naming" class="space-y-1.5">
        <Input
          ref="nameInput"
          v-model="draftName"
          :placeholder="t('filters.namePlaceholder')"
          :aria-label="t('filters.nameLabel')"
          class="h-8 bg-background text-sm"
          @keydown.enter.prevent="saveAsNew"
          @keydown.esc="cancelNaming"
        />
        <div class="flex gap-1.5">
          <Button
            size="sm"
            class="flex-1"
            :disabled="!draftName.trim() || createFilter.isPending.value"
            @click="saveAsNew"
          >
            {{ t('common.save') }}
          </Button>
          <Button size="sm" variant="ghost" @click="cancelNaming">{{ t('common.cancel') }}</Button>
        </div>
      </div>

      <!-- An edited filter offers the two honest answers: change what it means,
           or keep it and start another. Both take the full width — the rail is
           14rem and Cyrillic runs a fifth longer, so a shared row truncated
           whichever label went second. -->
      <div v-else class="flex flex-col gap-1.5">
        <Button
          v-if="modified"
          size="sm"
          variant="outline"
          class="justify-start"
          :disabled="patchFilter.isPending.value"
          @click="updateActive"
        >
          <Check class="size-3.5" />
          {{ t('filters.updateView') }}
        </Button>
        <Button
          size="sm"
          :variant="modified ? 'ghost' : 'outline'"
          class="justify-start"
          @click="startNaming"
        >
          <Bookmark class="size-3.5" />
          {{ modified ? t('filters.saveAsNew') : t('filters.saveView') }}
        </Button>
      </div>
    </div>

    <!-- Saved ------------------------------------------------------------ -->
    <h2 class="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {{ t('filters.savedViews') }}
    </h2>

    <p v-if="savedQuery.isPending.value" class="px-3 pb-2 text-xs text-muted-foreground">
      {{ t('common.loading') }}
    </p>

    <p v-else-if="!saved.length" class="px-3 pb-2 text-xs leading-relaxed text-muted-foreground">
      {{ t('filters.savedEmpty') }}
    </p>

    <ul v-else>
      <li v-for="filter in saved" :key="filter.id">
        <!-- Renaming replaces the row rather than opening over it: the list
             keeps its shape, and the name is edited where it is read. -->
        <div v-if="renamingId === filter.id" class="px-3 py-1.5">
          <Input
            v-model="renameDraft"
            data-kn-rename-input
            class="h-8 bg-background text-sm"
            :aria-label="t('filters.nameLabel')"
            @keydown.enter.prevent="commitRename"
            @keydown.esc="renamingId = null"
            @blur="commitRename"
          />
        </div>

        <div
          v-else
          class="flex items-center transition-colors"
          :class="
            filter.id === activeId
              ? 'bg-primary/10 font-medium text-primary'
              : 'text-foreground/80 hover:bg-accent hover:text-foreground'
          "
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left text-sm"
            :aria-current="filter.id === activeId ? 'true' : undefined"
            @click="emit('apply', filter)"
          >
            <Bookmark class="size-4 shrink-0" />
            <span class="min-w-0">
              <span class="block truncate" :title="filter.name">{{ filter.name }}</span>
              <span class="block truncate text-[11px] font-normal text-muted-foreground">
                {{ summaryOf(filter)
                }}<template v-if="filter.id === activeId && modified">
                  · {{ t('filters.edited') }}
                </template>
              </span>
            </span>
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button
                variant="ghost"
                size="icon-xs"
                class="mr-1.5 shrink-0 text-muted-foreground"
                :aria-label="t('filters.viewActions', { name: filter.name })"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-48">
              <DropdownMenuItem @click="startRename(filter)">
                <Pencil class="size-3.5" />
                {{ t('filters.rename') }}
              </DropdownMenuItem>
              <DropdownMenuItem @click="copyLink(filter)">
                <Link2 class="size-3.5" />
                {{ t('filters.copyLink') }}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" @click="pendingDelete = filter">
                <Trash2 class="size-3.5" />
                {{ t('common.delete') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </li>
    </ul>

    <AlertDialog
      :open="!!pendingDelete"
      @update:open="(open: boolean) => !open && (pendingDelete = null)"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {{ t('filters.deleteTitle', { name: pendingDelete?.name ?? '' }) }}
          </AlertDialogTitle>
          <AlertDialogDescription>{{ t('filters.deleteBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
          <AlertDialogAction
            class="bg-destructive text-white hover:bg-destructive/90"
            @click="confirmDelete"
          >
            {{ t('common.delete') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
