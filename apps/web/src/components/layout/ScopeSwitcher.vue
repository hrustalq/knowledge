<script setup lang="ts">
/**
 * Workspace › Project switcher.
 *
 * These are not two peer dropdowns: the domain is a containment path
 * (Workspace > Project > Document), so the project reads as a child of the
 * workspace, drawn with the same elbow-and-rail grammar the page tree below
 * uses for its own nesting. Both rows are quiet at rest — the value *is* the
 * control — and open into a command-menu popover with a pinned create action.
 *
 * Workspace monograms live in the list, not on the trigger: on the trigger a
 * second coloured tile competes with the brand mark 12px above it, while in
 * the list they do real work telling several workspaces apart at a glance.
 */
import { computed, onMounted, ref } from 'vue'
import { ChevronsUpDown } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useWorkspacesStore } from '@/stores/workspaces'
import { getWorkspaceId } from '@/lib/api'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import SwitcherCreateDialog from './SwitcherCreateDialog.vue'

const auth = useAuthStore()
const projects = useProjectsStore()
const workspaces = useWorkspacesStore()

const activeWs = ref(getWorkspaceId())
const creating = ref<'workspace' | 'project' | null>(null)
const seedName = ref('')

onMounted(() => {
  workspaces.ensureLoaded()
  void projects.fetchList().catch(() => {
    /* no project access — the row stays hidden */
  })
})

const workspaceOptions = computed<ComboboxOption[]>(() =>
  workspaces.items.map((w) => ({
    value: w.workspaceId,
    label: w.name,
    meta: `${w.memberCount} ${w.memberCount === 1 ? 'member' : 'members'}`,
  })),
)

const projectOptions = computed<ComboboxOption[]>(() =>
  projects.items.map((p) => ({
    value: p.projectId,
    label: p.name,
    meta: `${p.documentCount} ${p.documentCount === 1 ? 'page' : 'pages'}`,
  })),
)

const activeWorkspaceName = computed(
  () => workspaces.items.find((w) => w.workspaceId === activeWs.value)?.name ?? 'Workspace',
)

/** Any authenticated principal may create a workspace — they become its admin. */
const showWorkspaceRow = computed(() => workspaces.items.length > 0)
/** Hidden entirely without project access; shown empty when there is nothing yet but you may add. */
const showProjectRow = computed(() => projects.loaded && (projects.items.length > 0 || auth.canEdit))

function openCreate(kind: 'workspace' | 'project', query: string) {
  seedName.value = query
  creating.value = kind
}

function hueOf(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/)
  return (
    ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() ||
    name.slice(0, 2).toUpperCase()
  )
}
</script>

<template>
  <div v-if="showWorkspaceRow || showProjectRow" class="mt-3 px-2">
    <div class="bg-sidebar-accent/60 rounded-lg p-1">
      <!-- Workspace: the tenant boundary, so it leads. -->
      <Combobox
        v-if="showWorkspaceRow"
        :model-value="activeWs"
        label="Workspaces"
        :options="workspaceOptions"
        :create-label="auth.authenticated ? 'New workspace' : undefined"
        @update:model-value="workspaces.switchWorkspace($event)"
        @create="openCreate('workspace', $event)"
      >
        <template #trigger="{ open }">
          <span
            class="hover:bg-sidebar-accent group-focus-visible/trigger:ring-ring/50 flex h-8 items-center gap-1.5 rounded-md px-2 transition-colors group-focus-visible/trigger:ring-3"
            :class="open ? 'bg-sidebar-accent' : ''"
          >
            <span class="min-w-0 flex-1 truncate text-[13px] font-medium">
              {{ activeWorkspaceName }}
            </span>
            <ChevronsUpDown class="text-muted-foreground size-3.5 shrink-0" />
          </span>
        </template>

        <template #option="{ option }">
          <span
            class="grid size-5 shrink-0 place-items-center rounded-[6px] text-[9px] font-semibold text-white"
            :style="{ backgroundColor: `hsl(${hueOf(option.value)} 55% 45%)` }"
            aria-hidden="true"
          >{{ initialsOf(option.label) }}</span>
          <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
        </template>
      </Combobox>

      <!-- Project: nested under the workspace, drawn with the tree's own elbow. -->
      <div v-if="showProjectRow" class="relative">
        <span aria-hidden="true" class="bg-sidebar-border absolute top-0 left-[13px] h-1/2 w-px" />
        <span aria-hidden="true" class="bg-sidebar-border absolute top-1/2 left-[13px] h-px w-2" />

        <!--
          `:model-value` rather than `v-model`: v-model would write activeId
          before the handler runs, and switchProject early-returns when the id
          already matches — the switch would silently no-op.
        -->
        <Combobox
          :model-value="projects.activeId"
          label="Projects"
          :options="projectOptions"
          :create-label="auth.canEdit ? 'New project' : undefined"
          @update:model-value="projects.switchProject($event)"
          @create="openCreate('project', $event)"
        >
          <template #trigger="{ open }">
            <span
              class="hover:bg-sidebar-accent group-focus-visible/trigger:ring-ring/50 ml-[23px] flex h-7 items-center gap-1.5 rounded-md px-2 transition-colors group-focus-visible/trigger:ring-3"
              :class="open ? 'bg-sidebar-accent' : ''"
            >
              <span
                class="min-w-0 flex-1 truncate text-xs"
                :class="projects.activeName ? 'text-sidebar-foreground/85' : 'text-muted-foreground italic'"
              >
                {{ projects.activeName ?? 'No project' }}
              </span>
              <ChevronsUpDown class="text-muted-foreground size-3 shrink-0" />
            </span>
          </template>
        </Combobox>
      </div>
    </div>

    <SwitcherCreateDialog
      :kind="creating"
      :initial-name="seedName"
      @update:kind="creating = $event"
    />
  </div>
</template>
