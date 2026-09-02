<script setup lang="ts">
// Feature 05 (docs/features/05): revision DAG + inline compare.
import { onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type {
  CompareResponse,
  ListBranchesResponse,
  ListRevisionsResponse,
  RevisionNode,
} from '@knowledge/contracts'
import { apiFetch, statusVariant } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const props = defineProps<{ documentId: string }>()

const revisions = ref<RevisionNode[] | null>(null)
const branches = ref<ListBranchesResponse['branches']>([])
const branchFilter = ref<string>('')
const from = ref<string>('')
const to = ref<string>('')
const compare = ref<CompareResponse | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

async function load() {
  const params = branchFilter.value ? `?branch=${encodeURIComponent(branchFilter.value)}` : ''
  const [revs, brs] = await Promise.all([
    apiFetch<ListRevisionsResponse>(`/v1/documents/${props.documentId}/revisions${params}`),
    apiFetch<ListBranchesResponse>(`/v1/documents/${props.documentId}/branches`),
  ])
  revisions.value = [...revs.revisions].reverse() // newest first
  branches.value = brs.branches
}

async function runCompare() {
  if (!from.value || !to.value || from.value === to.value) return
  busy.value = true
  error.value = null
  try {
    compare.value = await apiFetch<CompareResponse>(
      `/v1/documents/${props.documentId}/compare?from=${from.value}&to=${to.value}&mode=merge-base`,
    )
  } catch (e) {
    error.value = (e as Error).message
    compare.value = null
  } finally {
    busy.value = false
  }
}

onMounted(() => void load())
watch(branchFilter, () => void load())
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-3">
      <select v-model="branchFilter" class="rounded-md border bg-background px-2 py-1.5 text-sm">
        <option value="">all branches</option>
        <option v-for="b in branches" :key="b.branchId" :value="b.name">{{ b.name }}</option>
      </select>
      <Button size="sm" :disabled="!from || !to || from === to || busy" @click="runCompare">
        {{ busy ? 'Comparing…' : 'Compare selected' }}
      </Button>
      <span class="text-xs text-muted-foreground">pick “from” and “to” below</span>
    </div>

    <div v-if="!revisions" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-10 w-full" />
    </div>

    <div v-else class="overflow-x-auto rounded-lg border">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b text-left text-xs text-muted-foreground">
            <th class="px-2 py-2">from</th>
            <th class="px-2 py-2">to</th>
            <th class="px-3 py-2">#</th>
            <th class="px-3 py-2">Revision</th>
            <th class="px-3 py-2">Branch</th>
            <th class="px-3 py-2">Status</th>
            <th class="px-3 py-2">Message</th>
            <th class="px-3 py-2">Parents</th>
            <th class="px-3 py-2">Created</th>
            <th class="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in revisions" :key="r.revisionId" class="border-b last:border-0 hover:bg-muted/40">
            <td class="px-2 py-2"><input v-if="r.contentHash" v-model="from" type="radio" name="from" :value="r.revisionId" /></td>
            <td class="px-2 py-2"><input v-if="r.contentHash" v-model="to" type="radio" name="to" :value="r.revisionId" /></td>
            <td class="px-3 py-2">{{ r.revisionNumber }}</td>
            <td class="px-3 py-2 font-mono text-xs">{{ r.revisionId.slice(0, 8) }}</td>
            <td class="px-3 py-2">{{ r.branch ?? '—' }}</td>
            <td class="px-3 py-2"><Badge :variant="statusVariant(r.status)">{{ r.status }}</Badge></td>
            <td class="max-w-48 truncate px-3 py-2 text-muted-foreground">{{ r.message ?? '—' }}</td>
            <td class="px-3 py-2 font-mono text-xs text-muted-foreground">
              {{ r.parentRevisionIds.map((p) => p.slice(0, 8)).join(', ') || '—' }}
            </td>
            <td class="px-3 py-2 text-xs text-muted-foreground">{{ new Date(r.createdAt).toLocaleString() }}</td>
            <td class="px-3 py-2">
              <RouterLink
                v-if="r.contentHash"
                :to="`/documents/${documentId}?tab=content&revision=${r.revisionId}`"
                class="text-xs hover:underline"
              >
                view
              </RouterLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="error" class="text-sm text-destructive">{{ error }}</p>

    <Card v-if="compare">
      <CardHeader>
        <CardTitle class="text-base">
          Compare {{ compare.from.revisionId.slice(0, 8) }} → {{ compare.to.revisionId.slice(0, 8) }}
          <span class="ml-2 text-xs font-normal text-muted-foreground">
            +{{ compare.summary.additions }} / −{{ compare.summary.deletions }}
            <template v-if="compare.mergeBaseRevisionId"> · merge base {{ compare.mergeBaseRevisionId.slice(0, 8) }}</template>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent class="space-y-4">
        <div v-if="compare.structural && compare.structural.changes.length" class="rounded-md border p-3 text-sm">
          <p class="mb-1 text-xs font-medium text-muted-foreground">Structural ({{ compare.structural.source }})</p>
          <p v-for="(c, i) in compare.structural.changes" :key="i" class="font-mono text-xs">
            <span :class="c.kind === 'added' ? 'text-green-600' : c.kind === 'removed' ? 'text-red-600' : 'text-amber-600'">{{ c.kind }}</span>
            {{ c.path || '(root)' }}
          </p>
        </div>
        <p v-if="compare.hunks.length === 0" class="text-sm text-muted-foreground">No line changes.</p>
        <div v-for="(hunk, hi) in compare.hunks" :key="hi" class="overflow-x-auto rounded-md border font-mono text-xs">
          <p class="bg-muted px-3 py-1 text-muted-foreground">
            @@ -{{ hunk.oldStart }},{{ hunk.oldLines }} +{{ hunk.newStart }},{{ hunk.newLines }} @@
          </p>
          <pre
            v-for="(line, li) in hunk.lines"
            :key="li"
            class="whitespace-pre-wrap px-3"
            :class="line.kind === 'added' ? 'bg-green-500/10 text-green-700 dark:text-green-400' : line.kind === 'deleted' ? 'bg-red-500/10 text-red-700 dark:text-red-400' : ''"
          >{{ line.kind === 'added' ? '+' : line.kind === 'deleted' ? '-' : ' ' }}{{ line.text }}</pre>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
