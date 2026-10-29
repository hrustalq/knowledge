<script setup lang="ts">
/**
 * One page of a published site's nav (issue #204): the app rail's row and
 * branch (TreeRow, TreeBranch) over the reader's own tree state (site-tree).
 * Every title is a plain link, so the server-rendered nav navigates with
 * JavaScript off; only expanding a branch the server did not send needs it.
 */
import { computed, inject } from 'vue'
import type { PublicSiteTreeNode } from '@knowledge/contracts'
import { TreeBranch } from '@/entities/document'
import { TreeRow } from '@/entities/document'
import { TreeWindowKey } from '@/shared/utils/tree-window'
import { SiteTreeKey } from '../model/site-tree'

defineOptions({ name: 'SiteTreeNode' })
const props = defineProps<{ node: PublicSiteTreeNode; depth: number; href: (node: PublicSiteTreeNode) => string }>()

const tree = inject(SiteTreeKey)!
const treeWindow = inject(TreeWindowKey, null)

const open = computed(() => tree.open.has(props.node.documentId))
const kids = computed(() => tree.children.get(props.node.documentId))

/** As in the app: opening travels the window to the children's level, closing lets it back. */
function toggle() {
  if (open.value) treeWindow?.retreat(props.depth)
  else treeWindow?.reveal(props.depth + 1)
  void tree.toggle(props.node)
}
</script>

<template>
  <li>
    <TreeRow
      :title="node.title"
      :href="href(node)"
      :has-children="node.childCount > 0"
      :open="open"
      :loading="tree.loading.has(node.documentId)"
      :active="node.documentId === tree.activeId"
      @toggle="toggle"
    />
    <TreeBranch v-if="node.childCount > 0" :open="open" :child-count="node.childCount" :loaded="!!kids">
      <SiteTreeNode v-for="child in kids ?? []" :key="child.documentId" :node="child" :depth="depth + 1" :href="href" />
    </TreeBranch>
  </li>
</template>
