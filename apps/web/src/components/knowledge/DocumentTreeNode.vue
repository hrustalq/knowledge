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
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ChevronRight, FileText, Loader2 } from 'lucide-vue-next'
import { Collapse } from '@/components/ui/collapse'
import type { DocumentTreeNode as TreeNode } from '@knowledge/contracts'
import { Badge } from '@/components/ui/badge'
import { statusDot } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { labelFor } from '@/lib/labels'
import { useDocumentsStore } from '@/stores/documents'

const { t } = useI18n()
defineOptions({ name: 'DocumentTreeNode' })
const props = defineProps<{ node: TreeNode; depth: number }>()

const store = useDocumentsStore()

/** `childCount`, not `children.length` — an unexpanded branch has neither yet. */
const hasChildren = computed(() => props.node.childCount > 0)
const loading = computed(() => store.expanding.includes(props.node.documentId))

// The first two levels start open, as before. They still have to be fetched.
const open = ref(props.depth < 2)
if (open.value && hasChildren.value) void store.fetchChildren(props.node.documentId)

function toggle() {
  open.value = !open.value
  if (open.value) void store.fetchChildren(props.node.documentId)
}
</script>

<template>
  <div>
    <div
      class="group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60"
      :style="{ paddingLeft: `${depth * 24 + 8}px` }"
    >
      <button
        v-if="hasChildren"
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
