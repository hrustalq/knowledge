<script setup lang="ts">
/**
 * "Something not working?" under a wizard step (#1225): symptom → fix, the
 * step's own items and then the chosen client's. Static text, a native
 * disclosure — it works before any script and costs no model call.
 */
import { LifeBuoy } from 'lucide-vue-next'
import { codeSpans } from '../../model/code-spans'

defineProps<{ title: string; items: { q: string; a: string }[] }>()
</script>

<template>
  <details v-if="items.length" class="group min-w-0 rounded-lg border">
    <summary
      class="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3.5 py-2.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
    >
      <LifeBuoy class="size-3.5 shrink-0" aria-hidden="true" />
      {{ title }}
    </summary>
    <dl class="grid gap-3 border-t px-3.5 py-3">
      <div v-for="item in items" :key="item.q" class="min-w-0">
        <dt class="text-xs font-medium">{{ item.q }}</dt>
        <dd class="kn-measure mt-0.5 text-xs leading-relaxed text-muted-foreground">
          <template v-for="(span, i) in codeSpans(item.a)" :key="i">
            <code v-if="span.code" class="font-mono">{{ span.text }}</code>
            <template v-else>{{ span.text }}</template>
          </template>
        </dd>
      </div>
    </dl>
  </details>
</template>
