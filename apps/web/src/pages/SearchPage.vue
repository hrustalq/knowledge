<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import type { SearchResponse } from '@knowledge/contracts'
import { apiFetch, DEMO_WORKSPACE_ID } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const query = ref('')
const results = ref<SearchResponse['results'] | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

async function run() {
  if (!query.value.trim()) return
  busy.value = true
  error.value = null
  try {
    const res = await apiFetch<SearchResponse>('/v1/search', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: DEMO_WORKSPACE_ID,
        query: query.value,
        mode: 'hybrid',
        limit: 20,
      }),
    })
    results.value = res.results
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-2xl font-semibold">Search</h1>
    <form class="flex gap-2" @submit.prevent="run">
      <Input v-model="query" placeholder="What depends on the identity service?" />
      <Button type="submit" :disabled="busy">{{ busy ? 'Searching…' : 'Search' }}</Button>
    </form>

    <p v-if="error" class="text-destructive">{{ error }}</p>
    <p v-else-if="results && results.length === 0" class="text-muted-foreground">No results.</p>

    <div v-else-if="results" class="space-y-3">
      <Card v-for="r in results" :key="r.chunkId">
        <CardHeader class="pb-2">
          <CardTitle class="flex items-baseline justify-between text-base">
            <RouterLink :to="`/documents/${r.documentId}`" class="hover:underline">{{ r.title }}</RouterLink>
            <span class="text-xs font-normal text-muted-foreground">score {{ r.score }}</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-sm text-muted-foreground">{{ r.snippet }}…</p>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
