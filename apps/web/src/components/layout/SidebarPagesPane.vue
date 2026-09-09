<script setup lang="ts">
/**
 * Level 1 of the rail's stack: the page tree of the project you pushed into.
 *
 * The project's name takes the eyebrow slot the roster's "Projects" label
 * occupied, at the same baseline, weight and colour — so during the push one
 * label slides out and its replacement slides in along a single line, and the
 * stack reads as one surface moving rather than two panels swapping.
 *
 * The whole title is the back target (a 256px rail has no room for a separate
 * back button *and* a location), with the chevron leaning left on hover to
 * name the direction, mirroring the roster's right-leaning row chevrons.
 */
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ChevronLeft, FileUp, Plus } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'
import { Skeleton } from '@/components/ui/skeleton'
import SidebarTreeNode from './SidebarTreeNode.vue'

const { t } = useI18n()

defineEmits<{ back: [] }>()

const auth = useAuthStore()
const projects = useProjectsStore()
const store = useDocumentsStore()
const route = useRoute()

// No active project means the API is answering workspace-wide, so the title
// tells the truth about what is listed rather than naming a project we are
// not scoped to.
const title = computed(() => projects.activeName ?? t('nav.allPages'))

const activeDocId = computed(() =>
  route.path.startsWith('/documents/') ? ((route.params.id as string) ?? null) : null,
)
</script>

<template>
  <!-- Opaque, and lifted: the left-edge shadow only escapes the stack's
       overflow clip while this pane is off its resting position, so the lift
       appears for exactly as long as the pane is in motion. -->
  <div class="bg-sidebar absolute inset-0 z-10 flex flex-col shadow-[-8px_0_16px_-10px_rgba(0,0,0,0.55)]">
    <!-- The chevron hangs into the rail's 16px gutter (-ml-3.5 exactly cancels
         its width plus the gap) so the title starts on the same x as the
         roster's "Projects" label: during the push one eyebrow slides out and
         its replacement slides in along a single unbroken line. -->
    <div class="flex h-7 shrink-0 items-center gap-1 px-4 pl-7">
      <button
        type="button"
        class="group/back hover:bg-sidebar-accent -ml-3.5 flex h-6 min-w-0 items-center gap-0.5 rounded-md pr-1.5 transition-colors"
        :aria-label="t('nav.backToProjects')"
        :title="t('nav.backToProjects')"
        @click="$emit('back')"
      >
        <ChevronLeft
          class="text-muted-foreground size-3 shrink-0 transition-transform group-hover/back:-translate-x-0.5"
        />
        <h2
          class="text-muted-foreground group-hover/back:text-sidebar-foreground truncate text-[11px] font-semibold tracking-wider uppercase transition-colors"
          :title="title"
        >
          {{ title }}
        </h2>
      </button>

      <div v-if="auth.canEdit" class="ml-auto flex shrink-0 gap-0.5">
        <RouterLink
          to="/upload"
          :title="t('nav.importDocument')"
          class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground grid size-6 place-items-center rounded transition-colors"
        >
          <FileUp class="size-3.5" />
        </RouterLink>
        <RouterLink
          to="/create"
          :title="t('nav.newPage')"
          class="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground grid size-6 place-items-center rounded transition-colors"
        >
          <Plus class="size-4" />
        </RouterLink>
      </div>
    </div>

    <div class="sidebar-scroll mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      <div v-if="!store.treeLoaded" class="space-y-1.5 px-1 pt-1">
        <Skeleton v-for="i in 6" :key="i" class="h-7 w-full" />
      </div>
      <p v-else-if="store.tree.length === 0" class="text-muted-foreground px-2.5 pt-1 text-xs">
        No pages yet<template v-if="auth.canEdit">
          —
          <RouterLink to="/create" class="text-primary hover:underline">{{ t('nav.createFirstPage') }}</RouterLink></template>.
      </p>
      <ul v-else class="space-y-px">
        <SidebarTreeNode
          v-for="node in store.tree"
          :key="node.documentId"
          :node="node"
          :depth="0"
          :active-id="activeDocId"
        />
      </ul>
    </div>
  </div>
</template>
