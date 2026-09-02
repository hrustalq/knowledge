<script setup lang="ts">
// Feature 02 (docs/features/02): reusable search widget with filters.
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import { DOCUMENT_CATEGORIES, type DocumentCategory, type SearchRequest, type SearchResponse } from '@knowledge/contracts'
import { apiFetch, DEMO_WORKSPACE_ID } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const query = ref('')
const mode = ref<'hybrid' | 'semantic' | 'keyword'>('hybrid')
const categories = ref<Set<DocumentCategory>>(new Set())
const expand = ref(true)
const depth = ref(1)
const limit = ref(20)

const response = ref<SearchResponse | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

function toggleCategory(c: DocumentCategory) {
  const next = new Set(categories.value)
  if (next.has(c)) next.delete(c)
  else next.add(c)
  categories.value = next
}

async function run() {
  if (!query.value.trim()) return
  busy.value = true
  error.value = null
  try {
    const body: SearchRequest = {
      workspaceId: DEMO_WORKSPACE_ID,
      query: query.value,
      mode: mode.value,
      limit: limit.value,
      ...(expand.value && mode.value === 'hybrid' ? { expandGraph: { depth: depth.value } } : {}),
      ...(categories.value.size > 0 ? { filters: { categories: [...categories.value] } } : {}),
    }
    response.value = await apiFetch<SearchResponse>('/v1/search', { method: 'POST', body: JSON.stringify(body) })
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <form class="flex gap-2" @submit.prevent="run">
      <Input v-model="query" placeholder="What depends on the identity service?" />
      <Button type="submit" :disabled="busy">{{ busy ? 'Searching…' : 'Search' }}</Button>
    </form>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <label class="flex items-center gap-1.5">
        <span class="text-muted-foreground">Mode</span>
        <select v-model="mode" class="rounded-md border bg-background px-2 py-1">
          <option value="hybrid">hybrid</option>
          <option value="semantic">semantic</option>
          <option value="keyword">keyword</option>
        </select>
      </label>
      <label class="flex items-center gap-1.5" :class="mode !== 'hybrid' ? 'opacity-50' : ''">
        <input v-model="expand" type="checkbox" :disabled="mode !== 'hybrid'" />
        <span class="text-muted-foreground">Graph expansion</span>
        <select v-model.number="depth" class="rounded-md border bg-background px-1.5 py-1" :disabled="!expand || mode !== 'hybrid'">
          <option :value="1">1</option>
          <option :value="2">2</option>
          <option :value="3">3</option>
        </select>
      </label>
      <label class="flex items-center gap-1.5">
        <span class="text-muted-foreground">Limit</span>
        <select v-model.number="limit" class="rounded-md border bg-background px-1.5 py-1">
          <option :value="10">10</option>
          <option :value="20">20</option>
          <option :value="50">50</option>
        </select>
      </label>
    </div>

    <div class="flex flex-wrap gap-1.5">
      <button
        v-for="c in DOCUMENT_CATEGORIES"
        :key="c"
        type="button"
        class="rounded-full border px-3 py-1 text-xs"
        :class="categories.has(c) ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'"
        @click="toggleCategory(c)"
      >
        {{ c }}
      </button>
    </div>

    <p v-if="error" class="text-destructive">{{ error }}</p>
    <p v-else-if="response && response.results.length === 0" class="text-muted-foreground">No results.</p>

    <div v-else-if="response" class="space-y-3">
      <Card v-for="r in response.results" :key="r.chunkId">
        <CardHeader class="pb-2">
          <CardTitle class="flex items-baseline justify-between text-base">
            <RouterLink :to="`/documents/${r.documentId}`" class="hover:underline">{{ r.title }}</RouterLink>
            <span class="text-xs font-normal text-muted-foreground">score {{ r.score }}</span>
          </CardTitle>
        </CardHeader>
        <CardContent class="space-y-2">
          <p class="text-sm text-muted-foreground">{{ r.snippet }}…</p>
          <div v-if="r.entities?.length" class="flex flex-wrap gap-1">
            <Badge v-for="e in r.entities" :key="e.key" variant="secondary" class="text-xs">{{ e.name }}</Badge>
          </div>
        </CardContent>
      </Card>

      <template v-if="response.related?.length">
        <h2 class="pt-2 text-sm font-medium text-muted-foreground">Related via graph</h2>
        <Card v-for="r in response.related" :key="r.documentId">
          <CardContent class="flex flex-wrap items-baseline gap-2 pt-4 text-sm">
            <RouterLink :to="`/documents/${r.documentId}`" class="font-medium hover:underline">{{ r.title }}</RouterLink>
            <span class="text-xs text-muted-foreground">distance {{ r.distance }}</span>
            <span class="text-xs text-muted-foreground">
              via {{ r.via.map((v) => `${v.relationType} ${v.entityKey}`).join(', ') }}
            </span>
          </CardContent>
        </Card>
      </template>
    </div>
  </div>
</template>
