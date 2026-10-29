<script setup lang="ts">
/**
 * The rail's navigation stack. Two panes, one column of travel.
 *
 * Both panes are absolutely positioned inside a clipped box so they can
 * overlap while they cross, and only one is ever mounted at rest — which is
 * also what keeps the offscreen pane's links out of the tab order. The pane
 * on its way out is marked inert for the few hundred milliseconds both exist.
 *
 * The stack is the only thing that moves. The brand, the workspace switcher
 * and the primary nav above it are the frame, and holding still is their job.
 */
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'
import { useSidebarNavStore } from '@/stores/sidebar-nav'
import SidebarPagesPane from './SidebarPagesPane.vue'
import SidebarProjectsPane from './SidebarProjectsPane.vue'

defineEmits<{ create: [] }>()

const documents = useDocumentsStore()
const projects = useProjectsStore()
const nav = useSidebarNavStore()
const route = useRoute()
const router = useRouter()

onMounted(() => {
  if (!projects.loaded) {
    void projects.fetchList().catch(() => {
      /* no project access — the roster stays empty and the pane says so */
    })
  }
  // Fetched even while the roster is showing: the tree is one request and it
  // wants to be there the instant the push lands, not a spinner behind it.
  if (!documents.treeLoaded) void documents.fetchTree()
})

async function open(projectId: string) {
  // Re-entering the project you are already scoped to is pure navigation —
  // no refetch, no route change, just the push.
  if (projectId === projects.activeId) {
    nav.openPages()
    return
  }

  // A document you are *reading* belongs to the scope you just left, so its
  // route no longer makes sense; a document you are *editing* holds unsaved
  // work, and nothing about a scope switch is worth throwing that away.
  const leavingStaleDoc = route.path.startsWith('/documents/') && !route.path.endsWith('/edit')

  await projects.switchProject(projectId)
  if (leavingStaleDoc) void router.push('/documents')
}

/** Both panes coexist mid-transition; the departing one must not take focus. */
function markInert(el: Element) {
  ;(el as HTMLElement).inert = true
}
</script>

<template>
  <!-- The direction rides on the container, not on the transition's name:
       a leaving element keeps the hooks it was rendered with, so a name bound
       to the direction hands the departing pane the previous direction's
       classes. See the pane block in style.css. -->
  <div class="relative mt-4 min-h-0 flex-1 overflow-hidden" :data-pane-dir="nav.direction">
    <Transition name="pane" @leave="markInert">
      <SidebarPagesPane v-if="nav.pane === 'pages'" key="pages" @back="nav.back()" />
      <SidebarProjectsPane
        v-else
        key="projects"
        @open="open"
        @create="$emit('create')"
      />
    </Transition>
  </div>
</template>
