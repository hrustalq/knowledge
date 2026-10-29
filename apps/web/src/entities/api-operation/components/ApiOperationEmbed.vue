<script setup lang="ts">
/**
 * The spec's side of an API block linked to an operation (#78): what to send
 * and what comes back, read live from the spec's head, so the page can never
 * drift from the contract it mirrors. Compact on purpose — the full card, with
 * schemas, samples and try-it, is one link away (the block's header links it).
 *
 * It sits inside the block's own frame and speaks its grammar — one disclosure
 * row per section, with a count, like the hand-written sections — so a linked
 * block and a written one read alike. An operation no spec defines any more says so in
 * place, with its key, instead of quietly vanishing from the page.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { AlertTriangle } from 'lucide-vue-next'
import type { ApiSpecDocumentResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { operationView, statusTone, typeLabel } from '@/entities/api-operation/model/api-spec'
import ApiDisclosure from './ApiDisclosure.vue'
import ApiTone from './ApiTone.vue'
import { useOperation } from '../model/use-operation'

const props = defineProps<{ workspaceId: string; entityKey: string }>()
const { t, te } = useI18n()

const { operation, missing, isError } = useOperation(() => props.workspaceId, () => props.entityKey)
const spec = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/api-specs/{id}', { path: { id: operation.value?.documentId ?? '' } }),
    enabled: Boolean(operation.value),
    staleTime: 60_000,
  })),
)
const doc = computed(() => (spec.data.value as ApiSpecDocumentResponse | undefined)?.document ?? null)
const view = computed(() => (doc.value && operation.value ? operationView(doc.value, operation.value) : null))
const inLabel = (where: string) => (te(`apiLink.in.${where}`) ? t(`apiLink.in.${where}`) : where)
</script>

<template>
  <section class="kn-api-live" contenteditable="false" :aria-label="t('apiLink.live.label')">
    <p v-if="missing || isError" class="kn-api-live-row flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
      <AlertTriangle class="mt-1 size-3.5 shrink-0 text-[color-mix(in_oklab,var(--kn-panel-warning)_75%,var(--foreground))]" />
      <span class="min-w-0">
        {{ isError ? t('apiLink.live.failed') : t('apiLink.live.gone') }}
        <code class="font-mono text-ui text-foreground [overflow-wrap:anywhere]">{{ entityKey }}</code>
      </span>
    </p>

    <div v-else-if="!view" class="kn-api-live-row space-y-2" aria-busy="true">
      <div class="h-3 w-2/5 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
      <div class="h-3 w-3/5 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
    </div>

    <template v-else>
      <p v-if="view.summary || view.deprecated" class="kn-api-live-row flex flex-wrap items-baseline gap-x-2 text-sm leading-relaxed text-[color-mix(in_oklab,var(--foreground)_80%,var(--card))]">
        <span class="sr-only">{{ t('apiLink.live.spec') }}:</span>
        <span v-if="view.summary">{{ view.summary }}</span>
        <ApiTone v-if="view.deprecated" tone="warning" size="sm">{{ t('apiRef.deprecated') }}</ApiTone>
      </p>

      <ApiDisclosure v-if="view.parameters.length" :label="t('apiRef.params')" :count="view.parameters.length">
        <dl class="kn-api-kv">
          <div v-for="p in view.parameters" :key="`${p.in}${p.name}`">
            <dt :class="p.deprecated && 'line-through opacity-60'">{{ p.name }}</dt>
            <dd>
              <span class="font-mono">{{ p.type }}</span>
              <span class="kn-api-dim italic">{{ inLabel(p.in) }}</span>
              <span v-if="p.required" class="kn-api-req">{{ t('apiRef.required').toLowerCase() }}</span>
              <span v-if="p.description" class="kn-api-note">{{ p.description }}</span>
            </dd>
          </div>
        </dl>
      </ApiDisclosure>

      <ApiDisclosure v-if="view.requestBody" :label="t('apiRef.body')" :count="view.requestBody.contents.length > 1 ? view.requestBody.contents.length : null">
        <dl class="kn-api-kv">
          <div v-for="c in view.requestBody.contents" :key="c.mediaType">
            <dt>{{ typeLabel(doc, c.schema) }}</dt>
            <dd>
              <span class="kn-api-dim font-mono">{{ c.mediaType }}</span>
              <span v-if="view.requestBody.required" class="kn-api-req">{{ t('apiRef.required').toLowerCase() }}</span>
            </dd>
          </div>
        </dl>
      </ApiDisclosure>

      <ApiDisclosure v-if="view.responses.length" :label="t('apiRef.responses')" :count="view.responses.length">
        <ul class="kn-api-kv">
          <li v-for="r in view.responses" :key="r.status" class="items-center">
            <ApiTone :tone="statusTone(r.status)">{{ r.status }}</ApiTone>
            <span class="min-w-0 flex-1 leading-snug">{{ r.description }}</span>
          </li>
        </ul>
      </ApiDisclosure>

      <ApiDisclosure v-if="view.messages.length" :label="t('apiRef.messages')" :count="view.messages.length">
        <dl class="kn-api-kv">
          <div v-for="(m, i) in view.messages" :key="i">
            <dt>{{ m.name ?? t('apiRef.message', { n: i + 1 }) }}</dt>
            <dd><span class="kn-api-dim font-mono">{{ typeLabel(doc, m.payload) }}</span></dd>
          </div>
        </dl>
      </ApiDisclosure>
    </template>
  </section>
</template>
