<script setup lang="ts">
import { computed, onMounted, onServerPrefetch, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { FileText, Plus, Upload } from 'lucide-vue-next'
import { DOCUMENT_CATEGORIES, type DocumentCategory } from '@knowledge/contracts'
import { useAuthStore } from '@/stores/auth'
import { useDocumentsStore } from '@/stores/documents'
import { statusDot, statusVariant } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import DocumentTreeNode from '@/components/knowledge/DocumentTreeNode.vue'

const auth = useAuthStore()
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
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="font-display text-2xl font-bold tracking-tight">Pages</h1>
        <p v-if="store.loaded" class="mt-0.5 text-sm text-muted-foreground">
          {{ store.items.length }} page{{ store.items.length === 1 ? '' : 's' }} in this workspace
        </p>
      </div>
      <div v-if="auth.canEdit" class="flex gap-2">
        <Button variant="outline" as-child>
          <RouterLink to="/upload"><Upload class="size-4" /> Upload</RouterLink>
        </Button>
        <Button as-child>
          <RouterLink to="/create"><Plus class="size-4" /> New page</RouterLink>
        </Button>
      </div>
    </div>

    <!-- Feature 07: category filter chips -->
    <div class="flex flex-wrap gap-1.5">
      <button
        class="rounded-full border px-3 py-1 text-xs transition-colors"
        :class="category === null
          ? 'border-primary bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'"
        @click="category = null"
      >
        all
      </button>
      <button
        v-for="c in DOCUMENT_CATEGORIES"
        :key="c"
        class="rounded-full border px-3 py-1 text-xs transition-colors"
        :class="category === c
          ? 'border-primary bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'"
        @click="category = category === c ? null : c"
      >
        {{ c }}
      </button>
    </div>

    <div v-if="!store.treeLoaded" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-10 w-full" />
    </div>

    <!-- Empty workspace -->
    <div
      v-else-if="store.tree.length === 0"
      class="grid place-items-center rounded-lg border border-dashed bg-card py-16 text-center"
    >
      <FileText class="size-8 text-muted-foreground/50" />
      <p class="mt-3 font-medium">No pages yet</p>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ auth.canEdit ? 'Create the first page for this workspace.' : 'Nothing has been published to this workspace.' }}
      </p>
      <Button v-if="auth.canEdit" class="mt-4" as-child>
        <RouterLink to="/create"><Plus class="size-4" /> New page</RouterLink>
      </Button>
    </div>

    <!-- Flat filtered list (category active) -->
    <div v-else-if="filtered" class="rounded-lg border bg-card p-2">
      <p v-if="filtered.length === 0" class="p-2 text-sm text-muted-foreground">No pages in this category.</p>
      <div
        v-for="doc in filtered"
        :key="doc.documentId"
        class="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60"
      >
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="statusDot(doc.headRevisionStatus)"
          :title="doc.headRevisionStatus ?? 'draft'"
        />
        <RouterLink
          :to="`/documents/${doc.documentId}`"
          class="truncate text-sm font-medium transition-colors hover:text-primary"
        >
          {{ doc.title }}
        </RouterLink>
        <Badge :variant="statusVariant(doc.headRevisionStatus)" class="hidden text-xs sm:inline-flex">
          {{ doc.headRevisionStatus ?? 'draft' }}
        </Badge>
        <span class="ml-auto shrink-0 text-xs text-muted-foreground">
          {{ new Date(doc.createdAt).toLocaleDateString() }}
        </span>
      </div>
    </div>

    <!-- Tree view (feature 08) -->
    <div v-else class="rounded-lg border bg-card p-2">
      <DocumentTreeNode v-for="node in store.tree" :key="node.documentId" :node="node" :depth="0" />
    </div>
  </div>
</template>
