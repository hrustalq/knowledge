<script setup lang="ts">
/**
 * The MCP tool table, from `reference.generated.json`.
 *
 * Inputs are listed as names with `?` marking the optional ones rather than as
 * full schemas: an agent gets the real schema from the server on connect, and a
 * person reading this needs to know which arguments exist — most importantly
 * that `workspaceId` is required almost everywhere, because stdio has no
 * ambient scope to fall back on.
 */
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { Search } from 'lucide-vue-next'
import { mcpTools } from '@/pages/docs/bundle'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

const query = ref('')

const shown = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return mcpTools
  return mcpTools.filter(
    (tool) => tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle),
  )
})
</script>

<template>
  <div class="not-prose my-6 space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <div class="relative min-w-48 flex-1">
        <Search class="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="query" :placeholder="t('docs.filterTools')" class="h-8 pl-8 text-sm" />
      </div>
      <span class="text-xs text-muted-foreground">{{ t('docs.toolCount', { n: shown.length }) }}</span>
    </div>

    <ul class="space-y-2">
      <li v-for="tool in shown" :key="tool.name" class="rounded-md border p-3">
        <p class="font-mono text-sm font-semibold">{{ tool.name }}</p>
        <p class="mt-1 text-xs text-muted-foreground">{{ tool.description }}</p>
        <p v-if="tool.inputs.length" class="mt-2 flex flex-wrap gap-1">
          <span
            v-for="input in tool.inputs"
            :key="input.name"
            class="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px]"
            :class="input.optional ? 'text-muted-foreground' : 'text-foreground'"
            :title="input.optional ? t('docs.optionalInput') : t('docs.requiredInput')"
          >
            {{ input.name }}<span v-if="input.optional">?</span>
          </span>
        </p>
      </li>
      <li v-if="shown.length === 0" class="rounded-md border py-6 text-center text-xs text-muted-foreground">
        {{ t('docs.noTools') }}
      </li>
    </ul>
  </div>
</template>
