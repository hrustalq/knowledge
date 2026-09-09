<script setup lang="ts">
// Feature 08 (docs/features/08): recursive tree row for the Pages index.
import { useI18n } from 'vue-i18n'
import { formatDate } from '@/lib/format'
import { labelFor } from '@/lib/labels'
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ChevronRight, FileText } from 'lucide-vue-next'
import { Collapse } from '@/components/ui/collapse'
import type { DocumentTreeNode as TreeNode } from '@knowledge/contracts'
import { Badge } from '@/components/ui/badge'
import { statusDot } from '@/lib/api'

const { t } = useI18n()

defineOptions({ name: 'DocumentTreeNode' })
const props = defineProps<{ node: TreeNode; depth: number }>()
const open = ref(props.depth < 2)
</script>

<template>
  <div>
    <div
      class="group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60"
      :style="{ paddingLeft: `${depth * 24 + 8}px` }"
    >
      <button
        v-if="node.children.length > 0"
        class="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted"
        :aria-label="open ? t('tree.collapse') : t('tree.expand')"
        :aria-expanded="open"
        @click="open = !open"
      >
        <ChevronRight class="size-3.5 transition-transform" :class="open ? 'rotate-90' : ''" />
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
      >
        {{ node.title }}
      </RouterLink>
      <Badge variant="outline" class="hidden shrink-0 text-xs sm:inline-flex">{{ labelFor(t, 'category', node.category) }}</Badge>
      <span class="ml-auto shrink-0 text-xs text-muted-foreground">
        {{ formatDate(node.createdAt) }}
      </span>
    </div>
    <Collapse v-if="node.children.length > 0" :open="open">
      <div>
        <DocumentTreeNode
          v-for="child in node.children"
          :key="child.documentId"
          :node="child"
          :depth="depth + 1"
        />
      </div>
    </Collapse>
  </div>
</template>
