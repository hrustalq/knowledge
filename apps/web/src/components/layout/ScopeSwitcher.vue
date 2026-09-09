<script setup lang="ts">
/**
 * Workspace switcher — the tenant boundary, and the one scope a rail cannot
 * navigate into, because crossing it reloads the app.
 *
 * The project used to sit here as a second dropdown. It moved down into the
 * navigation stack, where picking a project and seeing what is in it are the
 * same gesture instead of two controls doing one job a few pixels apart.
 *
 * Quiet at rest — the value *is* the control — opening into a command-menu
 * popover with a pinned create action. Monograms live in the list, not on the
 * trigger: on the trigger a second coloured tile competes with the brand mark
 * 12px above it, while in the list they do real work telling several
 * workspaces apart at a glance.
 */
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref } from 'vue'
import { ChevronsUpDown } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { useWorkspacesStore } from '@/stores/workspaces'
import { getWorkspaceId } from '@/lib/api'
import { hueOf, initialsOf } from '@/lib/monogram'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'

const { t } = useI18n()

// The dialog itself lives in the sidebar, which is the only place that can
// serve both the workspace row here and the project roster below it.
const emit = defineEmits<{ create: [kind: 'workspace' | 'project', name: string] }>()

const auth = useAuthStore()
const workspaces = useWorkspacesStore()

const activeWs = ref(getWorkspaceId())

onMounted(() => {
  workspaces.ensureLoaded()
})

const workspaceOptions = computed<ComboboxOption[]>(() =>
  workspaces.items.map((w) => ({
    value: w.workspaceId,
    label: w.name,
    meta: `${w.memberCount} ${w.memberCount === 1 ? 'member' : 'members'}`,
  })),
)

const activeWorkspaceName = computed(
  () => workspaces.items.find((w) => w.workspaceId === activeWs.value)?.name ?? t('nav.workspace'),
)

/** Any authenticated principal may create a workspace — they become its admin. */
const showWorkspaceRow = computed(() => workspaces.items.length > 0)
</script>

<template>
  <div v-if="showWorkspaceRow" class="mt-3 px-2">
    <div class="bg-sidebar-accent/60 rounded-lg p-1">
      <Combobox
        :model-value="activeWs"
        :label="t('nav.workspaces')"
        :options="workspaceOptions"
        :create-label="auth.authenticated ? t('nav.newWorkspace') : undefined"
        @update:model-value="workspaces.switchWorkspace($event)"
        @create="emit('create', 'workspace', $event)"
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

    </div>
  </div>
</template>
