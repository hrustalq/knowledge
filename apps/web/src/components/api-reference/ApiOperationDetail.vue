<script setup lang="ts">
/**
 * One operation or channel (#78), drawn as Swagger UI's opblock in the panel
 * ramp: the whole card takes its method's hue — a hairline frame, a faint
 * ground, a stronger header — so a column of operations reads by colour
 * before it reads by word. GET is note-blue, POST tip-green and so on
 * (`methodTone`); the indexing lifecycle's emerald, amber and red stay its own.
 *
 * Closed, the card is one line: the solid method badge, the route, the
 * summary, a lock when it needs credentials. Open, it unfolds in place
 * (Collapse, the app's one way to open a section) into what to send, what
 * comes back, the request with its try-it console, and who links it. The body
 * mounts only while open, so a spec of 300 operations is 300 header rows.
 *
 * Descriptions are the spec author's markdown, so they go through MarkdownView
 * and its sanitizer; nothing here uses `v-html`.
 */
import { computed, ref, toRef, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, Copy, FlaskConical, LockKeyhole, RefreshCw } from 'lucide-vue-next'
import type { ApiOperationInfo } from '@knowledge/contracts'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import { Collapse } from '@/components/ui/collapse'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAuthStore } from '@/stores/auth'
import { operationView, statusTone, type ResponseView } from '@/lib/api-spec'
import { operationDomId } from './use-api-reference'
import { useCopy } from '@/lib/use-copy'
import ApiEndpoint from './ApiEndpoint.vue'
import ApiMediaContent from './ApiMediaContent.vue'
import ApiOperationLinks from './ApiOperationLinks.vue'
import ApiRequestPanel from './ApiRequestPanel.vue'
import ApiTestSuite from './ApiTestSuite.vue'
import ApiTone from './ApiTone.vue'
import { useTestSuite } from './use-test-suite'

const props = withDefaults(
  defineProps<{
    document: Record<string, unknown>
    operation: ApiOperationInfo
    workspaceId: string
    open?: boolean
    /** Read the linked pages: only once the card has been on screen, so a spec of 300 operations is not 300 graph reads. */
    links?: boolean
  }>(),
  { open: true, links: false },
)
const emit = defineEmits<{ toggle: [open: boolean] }>()
const { t, te } = useI18n()
const { state: copyState, copy } = useCopy()
const uid = useId()

const view = computed(() => operationView(props.document, props.operation))
const params = computed(() => {
  const order = ['path', 'query', 'header', 'cookie']
  return [...(view.value?.parameters ?? [])].sort((a, b) => order.indexOf(a.in) - order.indexOf(b.in))
})
const where = (loc: string) => (te(`apiLink.in.${loc}`) ? t(`apiLink.in.${loc}`) : loc)

/** Successful responses with a body start open; the rest wait to be asked. */
const openResponses = ref(new Set((view.value?.responses ?? []).filter((r) => r.status.startsWith('2') && r.contents.length).map((r) => r.status)))
/**
 * Test requests (#468), HTTP only. The suite is read only while the card is
 * open; Generate opens the card so its progress and result are in view.
 */
const auth = useAuthStore()
const canGenerate = computed(() => auth.can('api-test-suites.generate'))
const tests = useTestSuite(() => props.operation.documentId, () => props.operation.entityKey, toRef(props, 'open'))
const specTitle = computed(() => {
  const info = props.document.info as { title?: unknown } | undefined
  return typeof info?.title === 'string' ? info.title : ''
})
function generateTests(regenerate: boolean) {
  if (!props.open) emit('toggle', true)
  void tests.generate(regenerate)
}

function toggleResponse(r: ResponseView) {
  const next = new Set(openResponses.value)
  if (next.has(r.status)) next.delete(r.status)
  else next.add(r.status)
  openResponses.value = next
}
</script>

<template>
  <article
    :id="operationDomId(operation)"
    class="kn-op scroll-mt-28"
    :data-kn-method="view?.protocol === 'http' ? view.method?.toUpperCase() : undefined"
    :data-state="open ? 'open' : 'closed'"
    :data-op="operation.entityKey"
  >
    <template v-if="view">
      <h3 class="kn-op-headrow m-0">
        <button
          type="button"
          class="kn-op-head"
          :aria-expanded="open"
          :aria-controls="`${uid}-body`"
          @click="emit('toggle', !open)"
        >
          <ApiEndpoint :method="view.method" :path="view.path" :protocol="view.protocol" variant="solid" size="lg" class="kn-op-route" />
          <span v-if="view.summary" class="kn-op-summary">{{ view.summary }}</span>
          <span class="kn-op-flags">
            <ApiTone v-if="view.deprecated" tone="warning" size="sm">{{ t('apiRef.deprecated') }}</ApiTone>
            <span v-if="view.security.length" class="kn-op-lock" :title="t('apiRef.needsAuth', { schemes: view.security.join(', ') })">
              <LockKeyhole class="size-3.5" aria-hidden="true" /><span class="sr-only">{{ t('apiRef.needsAuth', { schemes: view.security.join(', ') }) }}</span>
            </span>
            <ChevronDown class="kn-op-chevron" aria-hidden="true" />
          </span>
        </button>
        <!-- A sibling of the toggle, never inside it: a button in a button is invalid and unreachable. -->
        <DropdownMenu v-if="view.protocol === 'http'">
          <DropdownMenuTrigger as-child>
            <button type="button" class="kn-op-iconbtn kn-op-actions" :aria-label="t('apiTests.menu')" :title="t('apiTests.menu')">
              <FlaskConical class="size-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-72">
            <DropdownMenuItem class="items-start gap-2.5" :disabled="!canGenerate || tests.generating.value" @select="generateTests(false)">
              <FlaskConical class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span class="grid gap-0.5">
                <span>{{ t('apiTests.generate') }}</span>
                <span class="text-xs text-muted-foreground">{{ canGenerate ? t('apiTests.generateHint') : t('apiTests.noCapability') }}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              v-if="tests.suite.value"
              class="gap-2.5"
              :disabled="!canGenerate || tests.generating.value"
              @select="generateTests(true)"
            >
              <RefreshCw class="size-4 shrink-0" aria-hidden="true" />
              {{ t('apiTests.regenerate') }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </h3>

      <Collapse :open="open">
        <div :id="`${uid}-body`" class="kn-op-body">
          <div v-if="view.description || view.operationId || view.security.length" class="kn-op-intro">
            <MarkdownView v-if="view.description" :markdown="view.description" />
            <dl class="kn-op-meta">
              <div v-if="view.operationId">
                <dt>{{ t('apiRef.operationId') }}</dt>
                <dd><code>{{ view.operationId }}</code></dd>
              </div>
              <div v-if="view.security.length">
                <dt>{{ t('apiRef.auth') }}</dt>
                <dd><code>{{ view.security.join(', ') }}</code></dd>
              </div>
              <div class="min-w-0">
                <dt>{{ t('apiRef.entityKey') }}</dt>
                <dd class="min-w-0">
                  <code class="truncate">{{ operation.entityKey }}</code>
                  <button
                    type="button"
                    class="kn-op-iconbtn"
                    :aria-label="copyState === 'copied' ? t('apiRef.linked.copied') : t('apiRef.linked.copyKey')"
                    :title="copyState === 'failed' ? t('apiRef.linked.copyFailed') : t('apiRef.linked.copyKey')"
                    @click="copy(operation.entityKey)"
                  >
                    <Check v-if="copyState === 'copied'" class="size-3.5" />
                    <Copy v-else class="size-3.5" />
                  </button>
                </dd>
              </div>
            </dl>
          </div>

          <!-- Parameters: one table, the way Swagger lists them, path first. -->
          <section v-if="params.length" class="kn-op-section">
            <h4 class="kn-op-section-title">{{ t('apiRef.params') }}<span class="kn-op-count">{{ params.length }}</span></h4>
            <div class="kn-op-table" role="table" :aria-label="t('apiRef.params')">
              <div class="kn-op-thead" role="row">
                <span role="columnheader">{{ t('apiRef.col.name') }}</span>
                <span role="columnheader">{{ t('apiRef.col.description') }}</span>
              </div>
              <div v-for="p in params" :key="`${p.in}:${p.name}`" class="kn-op-row" role="row">
                <div role="cell" class="kn-op-name">
                  <p class="flex flex-wrap items-baseline gap-x-1.5">
                    <code class="kn-op-key" :class="p.deprecated && 'line-through opacity-60'">{{ p.name }}</code>
                    <span v-if="p.required" class="kn-op-required">{{ t('apiRef.requiredMark') }}</span>
                  </p>
                  <p class="kn-op-type">{{ p.type }} <span class="kn-op-in">({{ where(p.in) }})</span></p>
                </div>
                <div role="cell" class="kn-op-desc">
                  <p v-if="p.description">{{ p.description }}</p>
                  <p v-else class="text-muted-foreground">—</p>
                  <p v-if="p.enumValues.length" class="mt-1.5 flex flex-wrap gap-1">
                    <code v-for="v in p.enumValues" :key="v" class="kn-op-chip">{{ v }}</code>
                  </p>
                  <p v-if="p.example" class="mt-1.5 text-ui text-muted-foreground">
                    {{ t('apiRef.exampleLabel') }} <code class="kn-op-chip">{{ p.example }}</code>
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section v-if="view.requestBody" class="kn-op-section">
            <h4 class="kn-op-section-title">
              {{ t('apiRef.body') }}
              <span v-if="view.requestBody.required" class="kn-op-required">{{ t('apiRef.requiredMark') }}</span>
            </h4>
            <div class="kn-op-pad space-y-3">
              <MarkdownView v-if="view.requestBody.description" :markdown="view.requestBody.description" />
              <ApiMediaContent :document="document" :contents="view.requestBody.contents" />
            </div>
          </section>

          <section v-if="view.responses.length" class="kn-op-section">
            <h4 class="kn-op-section-title">{{ t('apiRef.responses') }}<span class="kn-op-count">{{ view.responses.length }}</span></h4>
            <div class="kn-op-table" role="table" :aria-label="t('apiRef.responses')">
              <div class="kn-op-thead kn-op-thead--code" role="row">
                <span role="columnheader">{{ t('apiRef.col.code') }}</span>
                <span role="columnheader">{{ t('apiRef.col.description') }}</span>
              </div>
              <div v-for="r in view.responses" :key="r.status" class="kn-op-row kn-op-row--code" role="row">
                <div role="cell"><ApiTone :tone="statusTone(r.status)">{{ r.status }}</ApiTone></div>
                <div role="cell" class="kn-op-desc min-w-0">
                  <button
                    v-if="r.contents.length"
                    type="button"
                    class="kn-op-response-toggle"
                    :aria-expanded="openResponses.has(r.status)"
                    :aria-controls="`${uid}-r-${r.status}`"
                    @click="toggleResponse(r)"
                  >
                    <span class="min-w-0 flex-1 text-start">{{ r.description || t('apiRef.noDescription') }}</span>
                    <span v-if="!openResponses.has(r.status)" class="font-mono text-xs text-muted-foreground">{{ r.contents.map((c) => c.mediaType).join(', ') }}</span>
                    <ChevronDown class="kn-op-chevron size-4" aria-hidden="true" />
                  </button>
                  <p v-else>{{ r.description || t('apiRef.noDescription') }}</p>
                  <Collapse v-if="r.contents.length" :open="openResponses.has(r.status)">
                    <div :id="`${uid}-r-${r.status}`" class="pt-2.5 pb-1">
                      <ApiMediaContent :document="document" :contents="r.contents" />
                    </div>
                  </Collapse>
                </div>
              </div>
            </div>
          </section>

          <section v-if="view.messages.length" class="kn-op-section">
            <h4 class="kn-op-section-title">{{ t('apiRef.messages') }}<span class="kn-op-count">{{ view.messages.length }}</span></h4>
            <div class="kn-op-pad divide-y">
              <div v-for="(m, i) in view.messages" :key="i" class="space-y-2 py-3 first:pt-0 last:pb-0">
                <p class="text-sm font-semibold">{{ m.name ?? t('apiRef.message', { n: i + 1 }) }}</p>
                <p v-if="m.summary" class="text-sm text-muted-foreground">{{ m.summary }}</p>
                <MarkdownView v-if="m.description" :markdown="m.description" />
                <ApiMediaContent :document="document" :contents="[{ mediaType: t('apiRef.payload'), schema: m.payload, example: undefined }]" />
              </div>
            </div>
          </section>

          <ApiRequestPanel
            v-if="view.protocol === 'http'"
            class="kn-op-section"
            :document="document"
            :operation="operation"
            :view="view"
            :workspace-id="workspaceId"
          />

          <ApiTestSuite
            v-if="view.protocol === 'http' && (tests.suite.value || tests.generating.value || tests.failure.value !== null || tests.loadError.value)"
            :operation="operation"
            :spec-title="specTitle"
            :suite="tests.suite.value"
            :generating="tests.generating.value"
            :failure="tests.failure.value"
            :load-error="tests.loadError.value"
            :can-generate="canGenerate"
            @generate="generateTests"
          />

          <ApiOperationLinks
            v-if="links"
            class="kn-op-section"
            :workspace-id="workspaceId"
            :entity-key="operation.entityKey"
            :spec-document-id="operation.documentId"
          />
        </div>
      </Collapse>
    </template>
    <p v-else class="p-4 text-sm text-muted-foreground">{{ t('apiRef.missing') }}</p>
  </article>
</template>

<style>
/* The frame, header wash and badge are the shared opblock rules in
   styles/editor.css (`.kn-op`), which the page's API block also wears. What is
   here is the reference card's own interior — unscoped, because the request
   panel inside the card opens on the same section band. Every class is
   `kn-op-*`, so nothing outside a card can match. */
/* The header row: the toggle and the quick-action menu side by side on the
   header wash, so the menu is a sibling of the toggle and the open-state
   hairline runs under both. */
.kn-op-headrow {
  display: flex;
  align-items: center;
  background: color-mix(in oklab, var(--kn-accent) 10%, var(--card));
}
.kn-op-headrow > .kn-op-head {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
}
.kn-op[data-state='open'] > .kn-op-headrow {
  border-bottom: 1px solid color-mix(in oklab, var(--kn-accent) 30%, var(--border));
}
.kn-op[data-state='open'] > .kn-op-headrow > .kn-op-head {
  border-bottom: 0;
}
.kn-op-actions {
  /* On the header's first line, beside the lock, however far the summary wraps. */
  align-self: flex-start;
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  margin-block-start: 0.6rem;
  margin-inline-end: 0.6rem;
}
.kn-op-actions[data-state='open'] {
  color: var(--foreground);
  background: var(--accent);
}
.kn-op-route {
  flex: 0 1 auto;
}
.kn-op-summary {
  flex: 1 1 12rem;
  min-width: 0;
  overflow: hidden;
  font-size: 0.9rem;
  color: color-mix(in oklab, var(--foreground) 78%, var(--card));
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: start;
}
.kn-op-flags {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.5rem;
  margin-inline-start: auto;
}
.kn-op-lock {
  display: grid;
  place-items: center;
  color: color-mix(in oklab, var(--kn-accent) 60%, var(--foreground));
}
.kn-op-chevron {
  width: 1.1rem;
  height: 1.1rem;
  color: var(--muted-foreground);
  transition: transform var(--collapse-duration) var(--snap-ease);
}
.kn-op[data-state='closed'] .kn-op-head .kn-op-chevron {
  transform: rotate(-90deg);
}
.kn-op-response-toggle[aria-expanded='false'] .kn-op-chevron {
  transform: rotate(-90deg);
}

.kn-op-body {
  padding-bottom: 1.25rem;
}
.kn-op-intro {
  display: grid;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
}
.kn-op-intro:empty {
  display: none;
}
.kn-op-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1.5rem;
  font-size: var(--kn-text-ui);
}
.kn-op-meta > div {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.kn-op-meta dt {
  color: var(--muted-foreground);
  white-space: nowrap;
}
.kn-op-meta dd {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.kn-op-meta code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--kn-text-ui);
  color: var(--foreground);
}
.kn-op-iconbtn {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 6px;
  color: var(--muted-foreground);
  transition: background-color 120ms ease-out, color 120ms ease-out;
}
.kn-op-iconbtn:hover {
  color: var(--foreground);
  background: var(--accent);
}
.kn-op-iconbtn:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}

/* A section opens on Swagger's band: the title on a step of the card's hue,
   bleeding to the frame, hairlines above and below. */
.kn-op-section + .kn-op-section {
  margin-top: 1.5rem;
}
.kn-op-section-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 0.75rem;
  padding: 0.55rem 1.25rem;
  border-block: 1px solid color-mix(in oklab, var(--kn-accent) 22%, var(--border));
  background: color-mix(in oklab, var(--kn-accent) 6%, var(--card));
  font-family: var(--font-display), ui-sans-serif, system-ui, sans-serif;
  font-size: 0.92rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--foreground);
}
/* Straight under the header, the header's own rule is the band's top edge. */
.kn-op-body > .kn-op-section:first-child .kn-op-section-title {
  border-top: 0;
}
.kn-op-count {
  display: grid;
  place-items: center;
  height: 1.15rem;
  min-width: 1.15rem;
  padding-inline: 0.3rem;
  border-radius: 999px;
  background: color-mix(in oklab, var(--kn-accent) 16%, transparent);
  font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
  font-size: var(--kn-text-micro);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: color-mix(in oklab, var(--kn-accent) 65%, var(--foreground));
}
.kn-op-pad {
  padding-inline: 1.25rem;
}

/* Name | Description, as Swagger's parameter table: the name column holds the
   name, its type and where it travels; the description column the prose. */
.kn-op-table {
  padding-inline: 1.25rem;
  font-size: var(--kn-text-sm);
}
.kn-op-thead,
.kn-op-row {
  display: grid;
  grid-template-columns: minmax(9rem, 13rem) minmax(0, 1fr);
  column-gap: 1.5rem;
}
.kn-op-thead--code,
.kn-op-row--code {
  grid-template-columns: 4.5rem minmax(0, 1fr);
}
.kn-op-thead {
  padding-bottom: 0.4rem;
  font-size: var(--kn-text-xs);
  font-weight: 500;
  color: var(--muted-foreground);
}
.kn-op-row {
  padding-block: 0.75rem;
  border-top: 1px solid var(--border);
}
.kn-op-key {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--kn-text-sm);
  font-weight: 600;
  overflow-wrap: anywhere;
}
.kn-op-required {
  font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
  font-size: var(--kn-text-caption);
  font-weight: 600;
  letter-spacing: 0;
  color: color-mix(in oklab, var(--kn-panel-caution) 75%, var(--foreground));
}
.kn-op-type {
  margin-top: 0.15rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--kn-text-xs);
  color: color-mix(in oklab, var(--foreground) 72%, var(--card));
  overflow-wrap: anywhere;
}
.kn-op-in {
  font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
  font-style: italic;
  color: var(--muted-foreground);
}
.kn-op-desc {
  line-height: 1.55;
  color: color-mix(in oklab, var(--foreground) 88%, var(--card));
}
.kn-op-chip {
  padding: 0.05rem 0.4rem;
  border-radius: 4px;
  background: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--kn-text-xs);
  color: var(--foreground);
}
.kn-op-response-toggle {
  display: flex;
  width: calc(100% + 0.8rem);
  align-items: center;
  gap: 0.6rem;
  margin: -0.2rem -0.4rem;
  padding: 0.2rem 0.4rem;
  border-radius: 6px;
  transition: background-color 120ms ease-out;
}
.kn-op-response-toggle:hover {
  background: color-mix(in oklab, var(--kn-accent) 7%, transparent);
}
.kn-op-response-toggle:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 0;
}

@container kn-op (max-width: 34rem) {
  .kn-op-thead {
    display: none;
  }
  .kn-op-thead + .kn-op-row {
    border-top: 0;
  }
  .kn-op-row:not(.kn-op-row--code) {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 0.35rem;
  }
  .kn-op-summary {
    flex-basis: 100%;
    order: 3;
    white-space: normal;
  }
  .kn-op-table,
  .kn-op-pad,
  .kn-op-section-title,
  .kn-op-intro {
    padding-inline: 1rem;
  }
}
@media (prefers-reduced-motion: reduce) {
  .kn-op-chevron {
    transition: none;
  }
}
</style>
