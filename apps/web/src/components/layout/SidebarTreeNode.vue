<script setup lang="ts">
// Navigation tree node — the page tree drawn as a graph: indent rails,
// live indexing-status dots, active-trail auto-expansion.
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ChevronRight } from 'lucide-vue-next'
import type { DocumentTreeNode as TreeNode } from '@knowledge/contracts'
import { statusDot } from '@/lib/api'

defineOptions({ name: 'SidebarTreeNode' })
const props = defineProps<{ node: TreeNode; depth: number; activeId: string | null }>()

const contains = (n: TreeNode): boolean =>
  n.documentId === props.activeId || n.children.some(contains)

const open = ref(props.depth < 1 || contains(props.node))
watch(
  () => props.activeId,
  () => {
    if (contains(props.node)) open.value = true
  },
)
const isActive = computed(() => props.node.documentId === props.activeId)
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
        v-if="node.children.length > 0"
        class="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-sidebar-accent"
        :aria-label="open ? 'Collapse' : 'Expand'"
        :aria-expanded="open"
        @click.prevent="open = !open"
      >
        <ChevronRight class="size-3.5 transition-transform" :class="open ? 'rotate-90' : ''" />
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
        v-if="node.children.length > 0"
        class="size-1.5 shrink-0 rounded-full"
        :class="statusDot(node.headRevisionStatus)"
        :title="node.headRevisionStatus ?? 'draft'"
      />
    </div>
    <ul v-if="open && node.children.length > 0" class="ml-[13px] border-l border-sidebar-border pl-2">
      <SidebarTreeNode
        v-for="child in node.children"
        :key="child.documentId"
        :node="child"
        :depth="depth + 1"
        :active-id="activeId"
      />
    </ul>
  </li>
</template>
