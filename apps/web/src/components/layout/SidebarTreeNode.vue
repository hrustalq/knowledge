<script setup lang="ts">
// Navigation tree node — the page tree drawn as a graph: indent rails,
// live indexing-status dots, active-trail auto-expansion.
import { computed, inject, ref, watch, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { ChevronRight, Loader2 } from 'lucide-vue-next'
import { Collapse } from '@/components/ui/collapse'
import type { DocumentTreeNode as TreeNode } from '@knowledge/contracts'
import { statusDot } from '@/lib/api'
import { useTreeDndRow } from '@/components/knowledge/tree-dnd'
import { useAuthStore } from '@/stores/auth'
import { useDocumentsStore } from '@/stores/documents'
import { TREE_INDENT, useSidebarStore } from '@/stores/sidebar'
import TreeRowMenu from '@/components/knowledge/TreeRowMenu.vue'
import { TreeWindowKey } from './tree-window'

defineOptions({ name: 'SidebarTreeNode' })
const { t } = useI18n()
const props = defineProps<{ node: TreeNode; depth: number; activeId: string | null }>()

const store = useDocumentsStore()
const sidebar = useSidebarStore()
const auth = useAuthStore()

/**
 * `childCount` rather than `children.length`: the tree loads a level at a time,
 * so an unexpanded branch has no children yet and would otherwise draw itself
 * as a leaf — the one thing a lazy tree must never do.
 */
const hasChildren = computed(() => props.node.childCount > 0)
const loading = computed(() => store.expanding.includes(props.node.documentId))

const contains = (n: TreeNode): boolean =>
  n.documentId === props.activeId || n.children.some(contains)

/**
 * Restored from the remembered set the rail shares with the pages index, which
 * the row then keeps up to date — including its initial state, so the set is
 * complete rather than only holding branches someone has clicked. Depth is what
 * the store falls back to when nothing has been remembered yet.
 */
const open = ref(sidebar.isNodeOpen(props.node.documentId, props.depth) || contains(props.node))
watch(open, (v) => sidebar.setNodeOpen(props.node.documentId, v), { immediate: true })
// Both trees can be on screen at once, and one memory has to mean one state:
// a branch opened in the rail opens on the index without waiting for a remount.
watch(
  () => sidebar.isNodeOpen(props.node.documentId, props.depth),
  (v) => {
    open.value = v
  },
)

watch(
  () => props.activeId,
  () => {
    // Auto-expansion along the active trail deliberately says nothing to the
    // window: every ancestor of the target runs this, and the pane already
    // knows the one depth that matters from the route. The pane has already
    // materialized the trail, so the children are here to open onto.
    if (contains(props.node)) open.value = true
  },
)
const isActive = computed(() => props.node.documentId === props.activeId)

const treeWindow = inject(TreeWindowKey, null)

/**
 * Opening a node is a request to read its children, so the window travels to
 * their level rather than to this one — otherwise the row you just revealed is
 * the first one squeezed.
 *
 * The row opens immediately and the effect below asks for the children, so the
 * disclosure never waits on a network round-trip to acknowledge the click.
 */
function toggle() {
  open.value = !open.value
  if (open.value) treeWindow?.reveal(props.depth + 1)
  else treeWindow?.retreat(props.depth)
}

/**
 * An open row and its children are one fact, not two: whenever this row is open
 * and its children are not in the tree, they are fetched — on first open, along
 * the active trail, and again if anything replaces the tree underneath us (a
 * refetch, a scope change, a live invalidation). Fetching once from setup meant
 * a row that outlived its children stayed open over empty placeholders until
 * someone collapsed and reopened it.
 */
watchEffect(() => {
  if (open.value && hasChildren.value && props.node.children.length === 0) {
    void store.fetchChildren(props.node.documentId)
  }
})

const dnd = useTreeDndRow({
  id: props.node.documentId,
  title: () => props.node.title,
  parentId: () => props.node.parentId,
  depth: () => props.depth,
  hasChildren: () => hasChildren.value,
  open,
  indent: TREE_INDENT,
})
/**
 * Space on the focused page title grabs it.
 *
 * The title link is the row's existing tab stop, so the gesture costs no new
 * ones — a tree that added a second focusable element per row would double the
 * length of every tab traversal of the rail to serve one gesture.
 */
</script>

<template>
  <li class="kn-tree-row" :class="{ 'kn-drop-before': dnd.dropBefore.value, 'kn-drop-after': dnd.dropAfter.value }">
    <div
      :ref="dnd.setEl"
      data-tree-row
      class="group relative flex items-center gap-1 rounded-md pr-1 text-sm transition-[background-color,color,opacity]"
      :class="[
        isActive
          ? 'bg-primary/10 font-medium text-primary'
          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground',
        dnd.isSource.value ? 'opacity-40' : '',
        // A locked subtree is still readable and still navigable — only the
        // grip is withdrawn. Greying it out entirely would read as an error.
        dnd.isLocked.value ? 'opacity-60' : '',
        dnd.dropInside.value ? 'bg-primary/10 ring-primary/40 ring-1' : '',
      ]"
      :style="{ '--kn-drop-inset': `${dnd.indicatorInset.value}px` }"
      :aria-grabbed="dnd.isSource.value || undefined"
      @pointerdown="dnd.onPointerdown"
      @keydown="(e: KeyboardEvent) => dnd.onKeydown(e, auth.canEdit)"
    >
      <button
        v-if="hasChildren"
        data-no-drag
        class="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-sidebar-accent"
        :aria-label="open ? t('tree.collapse') : t('tree.expand')"
        :aria-expanded="open"
        @click.prevent="toggle"
      >
        <Loader2 v-if="loading" class="size-3.5 animate-spin" />
        <ChevronRight v-else class="size-3.5 transition-transform" :class="open ? 'rotate-90' : ''" />
      </button>
      <span v-else class="grid size-5 shrink-0 place-items-center">
        <span
          class="size-1.5 rounded-full"
          :class="statusDot(node.headRevisionStatus)"
          :title="node.headRevisionStatus ?? 'draft'"
        />
      </span>
      <RouterLink
        :to="`/documents/${node.documentId}`"
        class="min-w-0 flex-1 truncate py-1.5"
        :title="node.title"
        draggable="false"
      >
        {{ node.title }}
      </RouterLink>
      <!-- The status dot yields its slot to the menu on hover rather than
           sitting beside it: at 256px a second permanent affordance is the
           difference between a readable title and an ellipsis. -->
      <TreeRowMenu
        v-if="auth.canEdit"
        :document-id="node.documentId"
        :title="node.title"
        :disabled="dnd.isLocked.value"
        class="hidden group-focus-within:grid group-hover:grid"
      />
      <span
        v-if="hasChildren"
        class="size-1.5 shrink-0 rounded-full"
        :class="[statusDot(node.headRevisionStatus), auth.canEdit ? 'group-focus-within:hidden group-hover:hidden' : '']"
        :title="node.headRevisionStatus ?? 'draft'"
      />
    </div>
    <!-- The branch grows out of its parent row rather than appearing beneath
         it: on a rail this dense, a subtree arriving in one frame shifts every
         row below it and you lose the page you were aiming at. -->
    <Collapse v-if="hasChildren" :open="open">
      <ul class="ml-[13px] border-l border-sidebar-border pl-2">
        <SidebarTreeNode
          v-for="child in node.children"
          :key="child.documentId"
          :node="child"
          :depth="depth + 1"
          :active-id="activeId"
        />
        <!-- Placeholder rows sized to the real ones, so the branch does not
             open onto nothing and then jolt when the children land. -->
        <li v-if="!node.children.length" class="space-y-1 py-1 pl-1">
          <div v-for="i in Math.min(node.childCount, 3)" :key="i" class="h-4 w-full animate-pulse rounded bg-sidebar-accent" />
        </li>
      </ul>
    </Collapse>
  </li>
</template>
