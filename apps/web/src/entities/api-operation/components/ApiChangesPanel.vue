<script setup lang="ts">
/**
 * A spec diff, classified (#78, phase 6): what a client of the old spec meets
 * in the new one. The merge request's API tab and the revisions compare both
 * draw it, so a reviewer and a historian read the same verdicts.
 *
 * Each changed operation is an opblock in its method's hue — the same `.kn-op`
 * frame the reference wears, so `DELETE /invoices/{id}` looks here as it does
 * on the spec — and its changes are rows inside it, breaking first. Severity
 * is never colour alone: every row carries its glyph and its word. The three
 * counts above double as filters; operations with a breaking change open by
 * default, the rest wait closed below them.
 *
 * Under each operation, the pages that link it: the docs a breaking change
 * makes wrong. Rule labels are this app's; the subject and values are the
 * spec's own text, shown as code and never as markup.
 */
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { ArrowRight, ChevronDown, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-vue-next'
import {
  API_CHANGE_SEVERITIES,
  type ApiAffectedPage,
  type ApiChangeSeverity,
  type ApiSpecChange,
  type ApiSpecDiff,
} from '@knowledge/contracts'
import { Collapse } from '@/shared/ui/collapse'
import ApiEndpoint from './ApiEndpoint.vue'
import ApiTone from './ApiTone.vue'
import type { ApiTone as Tone } from '@/entities/api-operation/model/api-spec'

const props = withDefaults(
  defineProps<{
    diff: ApiSpecDiff
    /** The spec document, for "open in reference" links. */
    documentId: string
    /** Pages linking each operation, by entity key (the merge request knows them; a bare compare does not). */
    affectedPages?: Record<string, ApiAffectedPage[]>
  }>(),
  { affectedPages: () => ({}) },
)
const { t } = useI18n()
const uid = useId()

const SEVERITY: Record<ApiChangeSeverity, { icon: LucideIcon; tone: Tone | null; key: string }> = {
  breaking: { icon: TriangleAlert, tone: 'caution', key: 'breaking' },
  'non-breaking': { icon: CircleCheck, tone: 'tip', key: 'nonBreaking' },
  info: { icon: Info, tone: null, key: 'info' },
}
const countOf = (s: ApiChangeSeverity) =>
  s === 'breaking' ? props.diff.summary.breaking : s === 'non-breaking' ? props.diff.summary.nonBreaking : props.diff.summary.info

/** Severities shown; all of them until a count is pressed. */
const shown = ref<Set<ApiChangeSeverity>>(new Set(API_CHANGE_SEVERITIES))
function toggle(s: ApiChangeSeverity) {
  const next = new Set(shown.value)
  // Pressing the only lit filter brings the others back rather than showing nothing.
  if (next.has(s) && next.size === 1) API_CHANGE_SEVERITIES.forEach((x) => next.add(x))
  else if (next.has(s)) next.delete(s)
  else next.add(s)
  shown.value = next
}

interface Group {
  id: string
  entityKey: string
  method: string | null
  path: string
  protocol: 'http' | 'async'
  /** The operation itself came or went, rather than changed inside. */
  whole: 'added' | 'removed' | null
  changes: ApiSpecChange[]
  counts: Record<ApiChangeSeverity, number>
}

const WHOLE_ADDED = new Set(['operation-added', 'channel-added'])
const WHOLE_REMOVED = new Set(['operation-removed', 'channel-removed'])

/** One card per operation, in the diff's order — which is already breaking first. */
const groups = computed<Group[]>(() => {
  const byId = new Map<string, Group>()
  for (const c of props.diff.changes) {
    const id = `${c.entityKey} ${c.method ?? ''}`
    let g = byId.get(id)
    if (!g) {
      g = {
        id,
        entityKey: c.entityKey,
        method: c.method,
        path: c.path,
        protocol: c.protocol,
        whole: null,
        changes: [],
        counts: { breaking: 0, 'non-breaking': 0, info: 0 },
      }
      byId.set(id, g)
    }
    if (WHOLE_ADDED.has(c.rule)) g.whole = 'added'
    if (WHOLE_REMOVED.has(c.rule)) g.whole = 'removed'
    g.changes.push(c)
    g.counts[c.severity] += 1
  }
  return [...byId.values()]
})

const visible = computed(() =>
  groups.value
    .map((g) => ({ ...g, rows: g.changes.filter((c) => shown.value.has(c.severity)) }))
    .filter((g) => g.rows.length > 0),
)

/** Open by default: anything breaking; everything, when the diff is short. */
const open = ref<Set<string>>(new Set())
watch(
  groups,
  (gs) => {
    open.value = new Set(gs.filter((g) => g.counts.breaking > 0 || gs.length <= 4).map((g) => g.id))
  },
  { immediate: true },
)
function toggleGroup(id: string) {
  const next = new Set(open.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  open.value = next
}

const pagesOf = (key: string) => props.affectedPages[key] ?? []
const ruleLabel = (c: ApiSpecChange) => t(`apiDiff.rule.${c.rule}`)

/** `optional` / `required` are the classifier's words, not the spec's: they are translated. Types and values stay as written. */
const word = (v: string) => (v === 'optional' || v === 'required' ? t(`apiDiff.value.${v}`) : v)

/**
 * The one value a one-sided change carries, when it says more than the
 * subject: an enum value, yes; a removed parameter's own name, or the route a
 * removed operation's header already shows, no.
 */
function lone(c: ApiSpecChange): string | null {
  if (c.before && c.after) return null
  const v = c.before ?? c.after
  if (!v || !c.subject || c.subject.endsWith(v)) return null
  return v
}
</script>

<template>
  <div class="kn-chg">
    <p v-if="diff.changes.length === 0" class="kn-chg-none">
      <CircleCheck class="size-4 shrink-0" aria-hidden="true" />
      <span>{{ t('apiDiff.noChanges') }}</span>
    </p>

    <template v-else>
      <div class="kn-chg-filters" role="group" :aria-label="t('apiDiff.filterLabel')">
        <button
          v-for="s in API_CHANGE_SEVERITIES"
          :key="s"
          type="button"
          class="kn-chg-filter"
          :data-severity="s"
          :aria-pressed="shown.has(s)"
          :disabled="countOf(s) === 0"
          @click="toggle(s)"
        >
          <component :is="SEVERITY[s].icon" class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="tabular-nums">{{ t(`apiDiff.count.${SEVERITY[s].key}`, { n: countOf(s) }, countOf(s)) }}</span>
        </button>
      </div>

      <p v-if="visible.length === 0" class="kn-chg-none">
        <span>{{ t('apiDiff.noneShown') }}</span>
      </p>

      <article
        v-for="g in visible"
        :key="g.id"
        class="kn-op kn-chg-op"
        :data-kn-method="g.protocol === 'http' ? g.method?.toUpperCase() : undefined"
        :data-state="open.has(g.id) ? 'open' : 'closed'"
        :data-whole="g.whole ?? undefined"
      >
        <h3 class="m-0">
          <button
            type="button"
            class="kn-op-head"
            :aria-expanded="open.has(g.id)"
            :aria-controls="`${uid}-${g.id}`"
            @click="toggleGroup(g.id)"
          >
            <ApiEndpoint :method="g.method" :path="g.path" :protocol="g.protocol" variant="solid" class="kn-chg-route" />
            <ApiTone v-if="g.whole === 'removed'" tone="caution" size="sm">{{ t('apiDiff.removed') }}</ApiTone>
            <ApiTone v-else-if="g.whole === 'added'" tone="tip" size="sm">{{ t('apiDiff.added') }}</ApiTone>
            <span class="kn-chg-tally">
              <template v-for="s in API_CHANGE_SEVERITIES" :key="s">
                <span v-if="g.counts[s]" class="kn-chg-tick" :data-severity="s" :title="t(`apiDiff.count.${SEVERITY[s].key}`, { n: g.counts[s] }, g.counts[s])">
                  <component :is="SEVERITY[s].icon" class="size-3.5" aria-hidden="true" />
                  <span class="tabular-nums">{{ g.counts[s] }}</span>
                  <span class="sr-only">{{ t(`apiDiff.severity.${SEVERITY[s].key}`) }}</span>
                </span>
              </template>
              <ChevronDown class="kn-chg-chevron" aria-hidden="true" />
            </span>
          </button>
        </h3>

        <Collapse :open="open.has(g.id)">
          <div :id="`${uid}-${g.id}`">
            <ul class="kn-chg-rows">
              <li v-for="(c, i) in g.rows" :key="i" class="kn-chg-row" :data-severity="c.severity">
                <component :is="SEVERITY[c.severity].icon" class="kn-chg-glyph" aria-hidden="true" />
                <div class="min-w-0">
                  <p class="kn-chg-rule">
                    <span>{{ ruleLabel(c) }}</span>
                    <span class="sr-only">— {{ t(`apiDiff.severity.${SEVERITY[c.severity].key}`) }}</span>
                  </p>
                  <p v-if="c.subject || (c.before && c.after) || lone(c)" class="kn-chg-detail">
                    <code v-if="c.subject" class="kn-chg-subject">{{ c.subject }}</code>
                    <span v-if="c.before && c.after" class="kn-chg-values">
                      <del><span class="sr-only">{{ t('apiDiff.was') }} </span>{{ word(c.before) }}</del>
                      <ArrowRight class="size-3 shrink-0" aria-hidden="true" />
                      <ins><span class="sr-only">{{ t('apiDiff.now') }} </span>{{ word(c.after) }}</ins>
                    </span>
                    <span v-else-if="lone(c)" class="kn-chg-values">
                      <del v-if="c.before">{{ c.before }}</del>
                      <ins v-else>{{ c.after }}</ins>
                    </span>
                  </p>
                </div>
                <span class="kn-chg-severity">{{ t(`apiDiff.severity.${SEVERITY[c.severity].key}`) }}</span>
              </li>
            </ul>

            <div class="kn-chg-foot">
              <div v-if="pagesOf(g.entityKey).length" class="min-w-0">
                <p class="kn-chg-foot-title">
                  {{ g.counts.breaking ? t('apiDiff.affectedPages') : t('apiDiff.linkedPages') }}
                  <span class="kn-api-count">{{ pagesOf(g.entityKey).length }}</span>
                </p>
                <ul class="kn-chg-pages">
                  <li v-for="p in pagesOf(g.entityKey)" :key="`${p.documentId}${p.relationType}`">
                    <RouterLink :to="`/documents/${p.documentId}`" class="kn-chg-page">{{ p.title }}</RouterLink>
                    <span class="kn-chg-rel">{{ p.relationType }}</span>
                  </li>
                </ul>
              </div>
              <RouterLink
                v-if="g.whole !== 'removed'"
                :to="{ path: `/documents/${documentId}`, query: { op: g.entityKey } }"
                class="kn-api-action kn-chg-open"
              >
                {{ t('apiDiff.openInReference') }}
                <ArrowRight class="size-3.5" aria-hidden="true" />
              </RouterLink>
            </div>
          </div>
        </Collapse>
      </article>
    </template>
  </div>
</template>

<style scoped>
.kn-chg {
  display: grid;
  gap: 0.75rem;
}
.kn-chg-none {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.85rem 1rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: var(--kn-text-sm);
  color: var(--muted-foreground);
}
.kn-chg-none svg {
  color: color-mix(in oklab, var(--kn-panel-tip) 75%, var(--foreground));
}

/* The three counts: a segmented strip whose segments filter. Pressed is lit in
   the severity's hue; released steps down to an outline, so "showing" never
   relies on the hue alone. */
.kn-chg-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.kn-chg-filter {
  --sev: var(--muted-foreground);
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  height: 1.9rem;
  padding-inline: 0.65rem;
  border: 1px solid color-mix(in oklab, var(--sev) 35%, var(--border));
  border-radius: 999px;
  background: transparent;
  font-size: var(--kn-text-ui);
  font-weight: 500;
  color: var(--muted-foreground);
  cursor: pointer;
  transition: background-color 120ms ease-out, color 120ms ease-out, border-color 120ms ease-out;
}
.kn-chg-filter[aria-pressed='true'] {
  background: color-mix(in oklab, var(--sev) 12%, transparent);
  color: color-mix(in oklab, var(--sev) 70%, var(--foreground));
}
.kn-chg-filter:hover:not(:disabled) {
  border-color: color-mix(in oklab, var(--sev) 60%, var(--border));
}
.kn-chg-filter:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}
.kn-chg-filter:disabled {
  opacity: 0.55;
  cursor: default;
}
:is(.kn-chg-filter, .kn-chg-row, .kn-chg-tick)[data-severity='breaking'] { --sev: var(--kn-panel-caution); }
:is(.kn-chg-filter, .kn-chg-row, .kn-chg-tick)[data-severity='non-breaking'] { --sev: var(--kn-panel-tip); }

/* The header: the reference card's band, its route and a tally on the right. */
.kn-chg-route {
  flex: 0 1 auto;
}
.kn-chg-op[data-whole='removed'] .kn-chg-route :deep(code) {
  text-decoration: line-through;
  text-decoration-color: color-mix(in oklab, var(--kn-panel-caution) 70%, transparent);
  text-decoration-thickness: 1.5px;
}
.kn-chg-tally {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.7rem;
  margin-inline-start: auto;
}
.kn-chg-tick {
  --sev: var(--muted-foreground);
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: var(--kn-text-ui);
  font-weight: 600;
  color: color-mix(in oklab, var(--sev) 72%, var(--foreground));
}
.kn-chg-chevron {
  width: 1.1rem;
  height: 1.1rem;
  color: var(--muted-foreground);
  transition: transform var(--collapse-duration) var(--snap-ease);
}
.kn-chg-op[data-state='closed'] .kn-chg-chevron {
  transform: rotate(-90deg);
}

/* One change per row: glyph, what changed, the severity in words at the end. */
.kn-chg-rows {
  margin: 0;
  padding: 0;
  list-style: none;
}
.kn-chg-row {
  --sev: var(--muted-foreground);
  display: grid;
  grid-template-columns: 1rem minmax(0, 1fr) auto;
  align-items: start;
  column-gap: 0.7rem;
  padding: 0.65rem 1rem 0.65rem 0.9rem;
}
.kn-chg-row + .kn-chg-row {
  border-top: 1px solid color-mix(in oklab, var(--kn-accent) 18%, var(--border));
}
.kn-chg-glyph {
  width: 1rem;
  height: 1rem;
  margin-top: 0.15rem;
  color: color-mix(in oklab, var(--sev) 75%, var(--foreground));
}
.kn-chg-rule {
  margin: 0;
  font-size: var(--kn-text-sm);
  font-weight: 500;
  line-height: 1.45;
  color: var(--foreground);
}
.kn-chg-detail {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 0.65rem;
  margin: 0.2rem 0 0;
  font-size: var(--kn-text-ui);
}
.kn-chg-subject {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--kn-text-ui);
  font-weight: 600;
  color: var(--foreground);
  overflow-wrap: anywhere;
}
.kn-chg-values {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--kn-text-xs);
  color: color-mix(in oklab, var(--foreground) 78%, var(--card));
}
.kn-chg-values del {
  text-decoration: line-through;
  text-decoration-color: color-mix(in oklab, var(--foreground) 45%, transparent);
  color: color-mix(in oklab, var(--foreground) 65%, var(--card));
}
.kn-chg-values ins {
  text-decoration: none;
  color: var(--foreground);
}
.kn-chg-values svg {
  color: var(--muted-foreground);
}
.kn-chg-severity {
  margin-top: 0.1rem;
  font-size: var(--kn-text-xs);
  font-weight: 600;
  white-space: nowrap;
  color: color-mix(in oklab, var(--sev) 72%, var(--foreground));
}

/* The docs this operation is written into, and the way back to the spec. */
.kn-chg-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 0.75rem 1rem;
  padding: 0.75rem 1rem 0.85rem 2.6rem;
  border-top: 1px solid color-mix(in oklab, var(--kn-accent) 22%, var(--border));
  background: color-mix(in oklab, var(--kn-accent) 4%, var(--card));
}
.kn-chg-foot:not(:has(> div)) {
  padding-block: 0.4rem;
}
.kn-chg-foot-title {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0 0 0.35rem;
  font-size: var(--kn-text-ui);
  font-weight: 600;
  color: var(--foreground);
}
.kn-chg-pages {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 1.1rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.kn-chg-pages li {
  display: inline-flex;
  align-items: baseline;
  gap: 0.4rem;
  min-width: 0;
}
.kn-chg-page {
  font-size: var(--kn-text-sm);
  color: var(--primary);
  text-underline-offset: 2px;
  overflow-wrap: anywhere;
}
.kn-chg-page:hover {
  text-decoration: underline;
}
.kn-chg-rel {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--kn-text-caption);
  letter-spacing: 0.02em;
  color: var(--muted-foreground);
}
.kn-chg-open {
  margin-inline-start: auto;
}

@container kn-op (max-width: 30rem) {
  .kn-chg-row {
    grid-template-columns: 1rem minmax(0, 1fr);
  }
  .kn-chg-severity {
    grid-column: 2;
  }
  .kn-chg-foot {
    padding-inline-start: 1rem;
  }
}
@media (prefers-reduced-motion: reduce) {
  .kn-chg-filter,
  .kn-chg-chevron {
    transition: none;
  }
}
</style>
