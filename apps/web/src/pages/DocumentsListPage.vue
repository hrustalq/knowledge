<script setup lang="ts">
import { onMounted, onServerPrefetch } from 'vue'
import { RouterLink } from 'vue-router'
import { useDocumentsStore } from '@/stores/documents'
import { statusVariant } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

const store = useDocumentsStore()

onServerPrefetch(() => store.fetchList())
onMounted(() => {
  if (!store.loaded) void store.fetchList()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">Documents</h1>
      <Button as-child>
        <RouterLink to="/upload">Upload document</RouterLink>
      </Button>
    </div>

    <div v-if="!store.loaded" class="space-y-2">
      <Skeleton class="h-10 w-full" v-for="i in 3" :key="i" />
    </div>

    <p v-else-if="store.items.length === 0" class="text-muted-foreground">
      No documents yet — upload the first one.
    </p>

    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Branch</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="doc in store.items" :key="doc.documentId">
          <TableCell>
            <RouterLink :to="`/documents/${doc.documentId}`" class="font-medium hover:underline">
              {{ doc.title }}
            </RouterLink>
          </TableCell>
          <TableCell>{{ doc.defaultBranch }}</TableCell>
          <TableCell>
            <Badge :variant="statusVariant(doc.headRevisionStatus)">
              {{ doc.headRevisionStatus ?? 'draft' }}
            </Badge>
          </TableCell>
          <TableCell class="text-muted-foreground">
            {{ new Date(doc.createdAt).toLocaleString() }}
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
