<script setup lang="ts">
/**
 * A spec's operations as its table of contents (#78): the body of the
 * Operations widget in the page rail, and — below `lg`, where the rail falls
 * under the content — a disclosure above the operations. A row scrolls to its
 * operation's card; the row being read carries the active trail, fed by the
 * content's scroll-spy, the same way "On this page" tracks headings.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown } from 'lucide-vue-next'
import type { ApiOperationInfo } from '@knowledge/contracts'
import { methodTone, operationRowKey } from '@/entities/api-operation/model/api-spec'
import ApiTone from './ApiTone.vue'
import type { ApiReferenceState } from '../model/use-api-reference'

const props = defineProps<{ state: ApiReferenceState; inline?: boolean }>()
const { t } = useI18n()

const activeKey = computed(() => props.state.active.value)
const tagLabel = (tag: string | null) =>
  tag ?? t(props.state.spec.value?.kind === 'asyncapi' ? 'apiRef.untaggedChannels' : 'apiRef.untagged')
const activeOp = computed(() => props.state.operations.value.find((o) => operationRowKey(o) === activeKey.value) ?? null)

function go(o: ApiOperationInfo, event: Event) {
  ;(event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')
  props.state.scrollTo(o)
}
</script>

<template>
  <details v-if="inline" class="group rounded-xl border bg-card">
    <summary class="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
      <span class="font-medium">{{ t('apiRef.nav') }}</span>
      <span class="min-w-0 flex-1 truncate font-mono text-ui text-muted-foreground">
        {{ activeOp ? `${activeOp.method ?? ''} ${activeOp.path}` : t('apiRef.operationCount', { n: state.operations.value.length }, state.operations.value.length) }}
      </span>
      <ChevronDown class="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
    </summary>
    <div class="max-h-[60vh] overflow-y-auto border-t px-2 py-2">
      <template v-for="g in state.groups.value" :key="g.tag ?? ''">
        <p class="px-2 pt-2 pb-1 text-ui font-medium">{{ tagLabel(g.tag) }}</p>
        <button
          v-for="o in g.operations"
          :key="operationRowKey(o)"
          type="button"
          class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-ui hover:bg-accent"
          :aria-current="activeKey === operationRowKey(o) ? 'location' : undefined"
          @click="go(o, $event)"
        >
          <ApiTone :tone="methodTone(o.method)" size="sm">{{ o.method ?? t('apiRef.channel') }}</ApiTone>
          <span class="min-w-0 truncate font-mono" :class="o.deprecated && 'line-through opacity-60'">{{ o.path }}</span>
        </button>
      </template>
    </div>
  </details>

  <nav v-else :aria-label="t('apiRef.nav')" class="max-h-[26rem] space-y-3 overflow-y-auto text-sm lg:max-h-[32rem]">
    <section v-for="g in state.groups.value" :key="g.tag ?? ''">
      <p class="mb-1.5 text-ui font-semibold">{{ tagLabel(g.tag) }}</p>
      <ul class="border-l">
        <li v-for="o in g.operations" :key="operationRowKey(o)">
          <button
            type="button"
            class="-ml-px flex w-full items-center gap-2.5 rounded-r-md border-l-2 py-1.5 pr-1.5 pl-2.5 text-left transition-colors duration-150"
            :class="
              activeKey === operationRowKey(o)
                ? 'border-primary bg-primary/8 text-foreground'
                : 'border-transparent text-[color-mix(in_oklab,var(--foreground)_78%,var(--card))] hover:bg-accent hover:text-foreground'
            "
            :aria-current="activeKey === operationRowKey(o) ? 'location' : undefined"
            :title="o.summary ?? undefined"
            @click="go(o, $event)"
          >
            <ApiTone :tone="methodTone(o.method)" size="sm">{{ o.method ?? t('apiRef.channel') }}</ApiTone>
            <span class="min-w-0 truncate font-mono text-ui" :class="o.deprecated && 'line-through opacity-60'">{{ o.path }}</span>
          </button>
        </li>
      </ul>
    </section>
  </nav>
</template>
