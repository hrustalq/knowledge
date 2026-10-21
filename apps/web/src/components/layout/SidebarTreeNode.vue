<script setup lang="ts">
// Navigation tree node — the page tree drawn as a graph: indent rails,
// live indexing-status dots, active-trail auto-expansion. The row and the
// branch are drawn by TreeRow / TreeBranch, which the public site reader
// shares; this wrapper adds the stores, DnD, the row menu and RouterLink.
import { computed, inject, ref, watch, watchPostEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { Lock } from 'lucide-vue-next'
import TreeBranch from '@/components/tree/TreeBranch.vue'
import TreeRow from '@/components/tree/TreeRow.vue'
import type { DocumentTreeNode as TreeNode } from '@knowledge/contracts'
import { statusDot } from '@/lib/api'
import { labelFor } from '@/lib/labels'
import { useTreeDndRow } from '@/components/knowledge/tree-dnd'
import { useAuthStore } from '@/stores/auth'
import { useDocumentsStore } from '@/stores/documents'
import { useSidebarStore } from '@/stores/sidebar'
import TreeRowMenu from '@/components/knowledge/TreeRowMenu.vue'
import { TREE_INDENT, TreeWindowKey } from '@/lib/tree-window'
import { VERIFICATION_MARK_CLASS, needsAttention, verificationDotClass } from '@/components/verification/verification-ui'

defineOptions({ name: 'SidebarTreeNode' })
const { t } = useI18n()
const props = defineProps<{ node: TreeNode; depth: number; activeId: string | null }>()

/** The lifecycle dot's name: colour alone is not a state a screen reader can read. */
const statusLabel = computed(() => labelFor(t, 'revisionStatus', props.node.headRevisionStatus ?? 'draft'))

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

/** See DocumentTreeNode: a mark only for a state that asks for a look. */
const attention = computed(() => needsAttention(props.node.verification))
const archived = computed(() => !!props.node.archivedAt)

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
 *
 * After the render, not in setup: the server draws these rows when it
 * prefetched the tree (#279), and a fetch started in setup marks the row
 * `loading` before its first draw — on the server a render that does not wait
 * for the answer, on the client a first render that no longer matches it.
 */
watchPostEffect(() => {
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
    <TreeRow
      :ref="dnd.setEl"
      :title="node.title"
      :href="`/documents/${node.documentId}`"
      :has-children="hasChildren"
      :open="open"
      :loading="loading"
      :active="isActive"
      :class="[
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
      @toggle="toggle"
    >
      <template #leaf>
        <span
          class="size-1.5 rounded-full"
          :class="statusDot(node.headRevisionStatus)"
          role="img"
          :aria-label="statusLabel"
          :title="statusLabel"
        />
      </template>
      <template #link="link">
        <RouterLink
          :to="`/documents/${node.documentId}`"
          :class="[link.cls, archived ? 'line-through decoration-current/40 opacity-70' : '']"
          :aria-current="link.current"
          :title="archived ? `${node.title} · ${t('verification.archived.badge')}` : node.title"
          draggable="false"
        >
          {{ node.title }}
        </RouterLink>
      </template>
      <!-- Restricted (#76): this page, an ancestor or the project is not open
           to the whole workspace. A glyph rather than a word, for the width. -->
      <span
        v-if="node.restricted"
        class="grid shrink-0 place-items-center text-muted-foreground/70"
        role="img"
        :aria-label="t('access.lockedLabel')"
        :title="t('access.lockedLabel')"
      >
        <Lock class="size-3" aria-hidden="true" />
      </span>
      <!-- At 256px there is no room for a word; the dot carries the state and
           the title on the link carries the reason. -->
      <span
        v-if="attention && !archived"
        :class="[VERIFICATION_MARK_CLASS, verificationDotClass(node.verification)]"
        role="img"
        :aria-label="t(`verification.state.${node.verification}`)"
        :title="t(`verification.state.${node.verification}`)"
      />
      <!-- The status dot yields its slot to the menu on hover rather than
           sitting beside it: at 256px a second permanent affordance is the
           difference between a readable title and an ellipsis. It stays
           yielded while the menu is open, when the row has neither. -->
      <TreeRowMenu
        v-if="auth.canEdit"
        :document-id="node.documentId"
        :title="node.title"
        :disabled="dnd.isLocked.value"
        :restricted="node.restricted"
        class="hidden group-focus-within:grid group-hover:grid"
      />
      <span
        v-if="hasChildren"
        class="size-1.5 shrink-0 rounded-full"
        :class="[statusDot(node.headRevisionStatus), auth.canEdit ? 'group-focus-within:hidden group-hover:hidden group-has-[[data-state=open]]:hidden' : '']"
        role="img"
        :aria-label="statusLabel"
        :title="statusLabel"
      />
    </TreeRow>
    <TreeBranch v-if="hasChildren" :open="open" :child-count="node.childCount" :loaded="node.children.length > 0">
      <SidebarTreeNode
        v-for="child in node.children"
        :key="child.documentId"
        :node="child"
        :depth="depth + 1"
        :active-id="activeId"
      />
    </TreeBranch>
  </li>
</template>
