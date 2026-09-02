<script setup lang="ts">
import { computed, onMounted, onServerPrefetch, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { DOCUMENT_CATEGORIES, type DocumentCategory } from '@knowledge/contracts'
import { useDocumentsStore } from '@/stores/documents'
import { statusVariant } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import DocumentTreeNode from '@/components/knowledge/DocumentTreeNode.vue'

const store = useDocumentsStore()
const category = ref<DocumentCategory | null>(null)

onServerPrefetch(() => Promise.all([store.fetchTree(), store.fetchList()]))
onMounted(() => {
  if (!store.treeLoaded) void store.fetchTree()
  if (!store.loaded) void store.fetchList()
})

/** With a category filter active, show a flat filtered list; otherwise the tree (feature 08). */
const filtered = computed(() =>
  category.value ? store.items.filter((d) => d.category === category.value) : null,
)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">Documents</h1>
      <div class="flex gap-2">
        <Button variant="outline" as-child>
          <RouterLink to="/upload">Upload</RouterLink>
        </Button>
        <Button as-child>
          <RouterLink to="/create">New document</RouterLink>
        </Button>
      </div>
    </div>

    <!-- Feature 07: category filter chips -->
    <div class="flex flex-wrap gap-1.5">
      <button
        class="rounded-full border px-3 py-1 text-xs"
        :class="category === null ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'"
        @click="category = null"
      >
        all
      </button>
      <button
        v-for="c in DOCUMENT_CATEGORIES"
        :key="c"
        class="rounded-full border px-3 py-1 text-xs"
        :class="category === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'"
        @click="category = category === c ? null : c"
      >
        {{ c }}
      </button>
    </div>

    <div v-if="!store.treeLoaded" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-10 w-full" />
    </div>

    <p v-else-if="store.tree.length === 0" class="text-muted-foreground">
      No documents yet — create the first one.
    </p>

    <!-- Flat filtered list (category active) -->
    <div v-else-if="filtered" class="rounded-lg border p-2">
      <p v-if="filtered.length === 0" class="p-2 text-sm text-muted-foreground">No documents in this category.</p>
      <div
        v-for="doc in filtered"
        :key="doc.documentId"
        class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
      >
        <RouterLink :to="`/documents/${doc.documentId}`" class="truncate font-medium hover:underline">
          {{ doc.title }}
        </RouterLink>
        <Badge variant="outline" class="text-xs">{{ doc.category }}</Badge>
        <Badge :variant="statusVariant(doc.headRevisionStatus)" class="text-xs">
          {{ doc.headRevisionStatus ?? 'draft' }}
        </Badge>
        <span class="ml-auto text-xs text-muted-foreground">{{ new Date(doc.createdAt).toLocaleDateString() }}</span>
      </div>
    </div>

    <!-- Tree view (feature 08) -->
    <div v-else class="rounded-lg border p-2">
      <DocumentTreeNode v-for="node in store.tree" :key="node.documentId" :node="node" :depth="0" />
    </div>
  </div>
</template>
