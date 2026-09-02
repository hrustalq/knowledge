<script setup lang="ts">
// Generative UI: dispatches an AssistantUiBlock (produced by the assistant's
// render_component tool) to the SAME existing components used elsewhere in
// the product — GraphView/ActivityFeed/SearchWidget on document pages — so
// a chat reply can show the real interactive view instead of describing it
// in prose. No bespoke chat-only widget logic lives here, only a label +
// existing Card chrome around whichever component the backend picked.
import type { AssistantUiBlock } from '@knowledge/contracts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import GraphView from '@/components/knowledge/GraphView.vue'
import ActivityFeed from '@/components/knowledge/ActivityFeed.vue'
import SearchWidget from '@/components/knowledge/SearchWidget.vue'

const props = defineProps<{ block: AssistantUiBlock }>()

const TITLES: Record<AssistantUiBlock['component'], string> = {
  graph: 'Dependency graph',
  activity: 'Activity',
  search: 'Search',
}
</script>

<template>
  <Card class="overflow-hidden">
    <CardHeader class="pb-2">
      <CardTitle class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {{ TITLES[props.block.component] }}
      </CardTitle>
    </CardHeader>
    <CardContent>
      <GraphView v-if="props.block.component === 'graph'" :document-id="(props.block.props.documentId as string)" />
      <ActivityFeed
        v-else-if="props.block.component === 'activity'"
        :document-id="(props.block.props.documentId as string | undefined)"
      />
      <SearchWidget
        v-else-if="props.block.component === 'search'"
        :initial-query="(props.block.props.initialQuery as string | undefined)"
      />
    </CardContent>
  </Card>
</template>
