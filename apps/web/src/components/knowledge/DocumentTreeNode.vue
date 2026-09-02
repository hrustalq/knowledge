<script setup lang="ts">
// Feature 08 (docs/features/08): recursive tree row.
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import type { DocumentTreeNode as TreeNode } from '@knowledge/contracts'
import { Badge } from '@/components/ui/badge'
import { statusVariant } from '@/lib/api'

defineOptions({ name: 'DocumentTreeNode' })
const props = defineProps<{ node: TreeNode; depth: number }>()
const open = ref(props.depth < 2)
</script>

<template>
  <div>
    <div
      class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
      :style="{ paddingLeft: `${depth * 20 + 8}px` }"
    >
      <button
        v-if="node.children.length > 0"
        class="w-4 shrink-0 text-muted-foreground"
        :aria-label="open ? 'Collapse' : 'Expand'"
        @click="open = !open"
      >
        {{ open ? '▾' : '▸' }}
      </button>
      <span v-else class="w-4 shrink-0" />
      <RouterLink :to="`/documents/${node.documentId}`" class="truncate font-medium hover:underline">
        {{ node.title }}
      </RouterLink>
      <Badge variant="outline" class="shrink-0 text-xs">{{ node.category }}</Badge>
      <Badge :variant="statusVariant(node.headRevisionStatus)" class="shrink-0 text-xs">
        {{ node.headRevisionStatus ?? 'draft' }}
      </Badge>
      <span class="ml-auto shrink-0 text-xs text-muted-foreground">
        {{ new Date(node.createdAt).toLocaleDateString() }}
      </span>
    </div>
    <template v-if="open">
      <DocumentTreeNode v-for="child in node.children" :key="child.documentId" :node="child" :depth="depth + 1" />
    </template>
  </div>
</template>
