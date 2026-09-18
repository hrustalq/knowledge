<script setup lang="ts">
/**
 * Feature 08: recursive tree row for the Pages index.
 *
 * Loads its children the first time it is opened, like the sidebar's row does.
 * The two are separate components because they sit in different materials — a
 * dense navigation rail and a content-width index — but the loading behaviour
 * is the same one, and it lives in the store so it cannot diverge.
 */
import { useI18n } from 'vue-i18n'
import { computed, ref, watch, watchEffect } from 'vue'
import { RouterLink } from 'vue-router'
import { ChevronRight, FileText, Loader2 } from 'lucide-vue-next'
import { Collapse } from '@/components/ui/collapse'
import type { DocumentTreeNode as TreeNode } from '@knowledge/contracts'
import { Badge } from '@/components/ui/badge'
import { statusDot } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { labelFor } from '@/lib/labels'
import { useTreeDndRow } from '@/components/knowledge/tree-dnd'
import { useAuthStore } from '@/stores/auth'
import { useDocumentsStore } from '@/stores/documents'
import { useSidebarStore } from '@/stores/sidebar'
import TreeRowMenu from './TreeRowMenu.vue'

const { t } = useI18n()
defineOptions({ name: 'DocumentTreeNode' })
const props = defineProps<{ node: TreeNode; depth: number }>()

const store = useDocumentsStore()
const sidebar = useSidebarStore()
const auth = useAuthStore()

/** `childCount`, not `children.length` — an unexpanded branch has neither yet. */
const hasChildren = computed(() => props.node.childCount > 0)
const loading = computed(() => store.expanding.includes(props.node.documentId))

/**
 * The same remembered set as the rail's tree, so the two cannot show one page
 * as open and closed at once — which is also why the cold-start default is the
 * store's and not this surface's own (it used to open two levels here).
 */
const open = ref(sidebar.isNodeOpen(props.node.documentId, props.depth))
watch(open, (v) => sidebar.setNodeOpen(props.node.documentId, v), { immediate: true })
// Both trees can be on screen at once, and one memory has to mean one state:
// a branch opened in the rail opens on the index without waiting for a remount.
watch(
  () => sidebar.isNodeOpen(props.node.documentId, props.depth),
  (v) => {
    open.value = v
  },
)

// Open and childless is a request for children, whenever it happens to be true
// — see the sidebar row, which carries the same effect for the same reason.
watchEffect(() => {
  if (open.value && hasChildren.value && props.node.children.length === 0) {
    void store.fetchChildren(props.node.documentId)
  }
})

function toggle() {
  open.value = !open.value
}

/** One level of the index tree indents by 24px; the drop line follows it. */
const INDEX_INDENT = 24
const dnd = useTreeDndRow({
  id: props.node.documentId,
  title: () => props.node.title,
  parentId: () => props.node.parentId,
  depth: () => props.depth,
  hasChildren: () => hasChildren.value,
  open,
  indent: INDEX_INDENT,
})
</script>

<template>
  <div class="kn-tree-row" :class="{ 'kn-drop-before': dnd.dropBefore.value, 'kn-drop-after': dnd.dropAfter.value }">
    <div
      :ref="dnd.setEl"
      data-tree-row
      class="group relative flex items-center gap-2 rounded-md px-2 py-1.5 transition-[background-color,color,opacity] hover:bg-muted/60"
      :class="[
        dnd.isSource.value ? 'opacity-40' : '',
        dnd.isLocked.value ? 'opacity-60' : '',
        dnd.dropInside.value ? 'bg-primary/10 ring-primary/40 ring-1' : '',
      ]"
      :style="{ paddingLeft: `${depth * 24 + 8}px`, '--kn-drop-inset': `${depth * 24 + 8 + dnd.indicatorInset.value}px` }"
      :aria-grabbed="dnd.isSource.value || undefined"
      @pointerdown="dnd.onPointerdown"
      @keydown="(e: KeyboardEvent) => dnd.onKeydown(e, auth.canEdit)"
    >
      <button
        v-if="hasChildren"
        data-no-drag
        class="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted"
        :aria-label="open ? t('tree.collapse') : t('tree.expand')"
        :aria-expanded="open"
        @click="toggle"
      >
        <Loader2 v-if="loading" class="size-3.5 animate-spin" />
        <ChevronRight v-else class="size-3.5 transition-transform" :class="open ? 'rotate-90' : ''" />
      </button>
      <span v-else class="grid size-5 shrink-0 place-items-center text-muted-foreground/60">
        <FileText class="size-3.5" />
      </span>
      <span
        class="size-1.5 shrink-0 rounded-full"
        :class="statusDot(node.headRevisionStatus)"
        :title="node.headRevisionStatus ?? 'draft'"
      />
      <RouterLink
        :to="`/documents/${node.documentId}`"
        class="truncate text-sm font-medium transition-colors hover:text-primary"
        draggable="false"
      >
        {{ node.title }}
      </RouterLink>
      <Badge variant="outline" class="hidden shrink-0 text-xs sm:inline-flex">
        {{ labelFor(t, 'category', node.category) }}
      </Badge>
      <!-- The count is the one fact that makes an unopened branch worth
           opening, and it is already on the row. -->
      <span v-if="hasChildren" class="shrink-0 text-xs tabular-nums text-muted-foreground">
        {{ node.childCount }}
      </span>
      <span class="ml-auto shrink-0 text-xs text-muted-foreground">{{ formatDate(node.createdAt) }}</span>
      <TreeRowMenu
        v-if="auth.canEdit"
        :document-id="node.documentId"
        :title="node.title"
        :disabled="dnd.isLocked.value"
        class="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      />
    </div>

    <Collapse v-if="hasChildren" :open="open">
      <div>
        <DocumentTreeNode
          v-for="child in node.children"
          :key="child.documentId"
          :node="child"
          :depth="depth + 1"
        />
        <!-- Placeholders sized to the rows that are coming, so an opened branch
             does not show an empty gap and then jolt. -->
        <div
          v-if="!node.children.length"
          class="space-y-1.5 py-1.5"
          :style="{ paddingLeft: `${(depth + 1) * 24 + 8}px` }"
        >
          <div
            v-for="i in Math.min(node.childCount, 4)"
            :key="i"
            class="h-4 w-2/3 animate-pulse rounded bg-muted"
          />
        </div>
      </div>
    </Collapse>
  </div>
</template>
