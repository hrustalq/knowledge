<script setup lang="ts">
// Navigation tree node — the page tree drawn as a graph: indent rails,
// live indexing-status dots, active-trail auto-expansion.
import { computed, inject, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { ChevronRight, Loader2 } from 'lucide-vue-next'
import { Collapse } from '@/components/ui/collapse'
import type { DocumentTreeNode as TreeNode } from '@knowledge/contracts'
import { statusDot } from '@/lib/api'
import { useDocumentsStore } from '@/stores/documents'
import { TreeWindowKey } from './tree-window'

defineOptions({ name: 'SidebarTreeNode' })
const { t } = useI18n()
const props = defineProps<{ node: TreeNode; depth: number; activeId: string | null }>()

const store = useDocumentsStore()

/**
 * `childCount` rather than `children.length`: the tree loads a level at a time,
 * so an unexpanded branch has no children yet and would otherwise draw itself
 * as a leaf — the one thing a lazy tree must never do.
 */
const hasChildren = computed(() => props.node.childCount > 0)
const loading = computed(() => store.expanding.includes(props.node.documentId))

const contains = (n: TreeNode): boolean =>
  n.documentId === props.activeId || n.children.some(contains)

const open = ref(props.depth < 1 || contains(props.node))
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
 * It is also literally a request: the children are fetched on first open. The
 * row opens immediately either way, so the disclosure never waits on a network
 * round-trip to acknowledge the click.
 */
function toggle() {
  open.value = !open.value
  if (open.value) {
    void store.fetchChildren(props.node.documentId)
    treeWindow?.reveal(props.depth + 1)
  } else {
    treeWindow?.retreat(props.depth)
  }
}

// A branch that opens itself along the active trail still has to load.
if (open.value && hasChildren.value) void store.fetchChildren(props.node.documentId)
</script>

<template>
  <li>
    <div
      class="group flex items-center gap-1 rounded-md pr-2 text-sm transition-colors"
      :class="isActive
        ? 'bg-primary/10 font-medium text-primary'
        : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground'"
    >
      <button
        v-if="hasChildren"
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
      >
        {{ node.title }}
      </RouterLink>
      <span
        v-if="hasChildren"
        class="size-1.5 shrink-0 rounded-full"
        :class="statusDot(node.headRevisionStatus)"
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
