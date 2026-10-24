<script setup lang="ts">
/**
 * The suite's setup (#483): fixtures bound to the whole suite, run once
 * before the cases, and what the spec suggests binding — the operations that
 * produce a value this one needs, and the fixtures already calling them.
 * Nothing is bound until a person presses Bind; the tester only reorders and
 * explains the suggestions.
 */
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { Loader2, Plus, Sparkles, X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import type { SuiteFixtures } from './use-suite-fixtures'

const props = defineProps<{ fixtures: SuiteFixtures; canBind: boolean; hasSuite: boolean; canGenerate: boolean; generating: boolean }>()
const emit = defineEmits<{ generate: [] }>()
const { t } = useI18n()
const uid = useId()

const bound = computed(() => props.fixtures.bindings.value?.suite ?? [])
const boundIds = computed(() => new Set(bound.value.map((b) => b.fixtureId)))
const suggestions = computed(() => (props.fixtures.candidates.value?.candidates ?? []).filter((c) => !boundIds.value.has(c.documentId)))
/** Producers no visible fixture calls yet: the gap a person fills by writing one. */
const uncovered = computed(() => {
  const res = props.fixtures.candidates.value
  if (!res) return []
  const called = new Set(res.candidates.flatMap((c) => c.producers))
  return [...new Map(res.prerequisites.filter((p) => !called.has(p.producer)).map((p) => [p.producer, p])).values()]
})
const addable = computed(() => props.fixtures.library.value.filter((f) => !boundIds.value.has(f.documentId)))
const picked = ref('')
function add() {
  if (!picked.value) return
  void props.fixtures.bind(picked.value)
  picked.value = ''
}
const opLabel = (p: { producer: string; operation: { method: string | null; path: string } | null }) =>
  p.operation ? `${p.operation.method ?? ''} ${p.operation.path}`.trim() : p.producer
const ranking = computed(() => props.fixtures.ranking.value)
const needsGenerate = computed(() => !props.hasSuite && !props.generating && bound.value.length > 0)
</script>

<template>
  <div class="kn-setup" :aria-busy="fixtures.saving.value">
    <div class="kn-setup-head">
      <h5 class="kn-ts-group-title">
        {{ t('apiTests.setup.title') }}<span v-if="bound.length" class="kn-op-count">{{ bound.length }}</span>
      </h5>
      <p class="kn-setup-hint">{{ t('apiTests.setup.hint') }}</p>
    </div>

    <ul v-if="bound.length" class="kn-ts-list">
      <li v-for="b in bound" :key="b.fixtureId" class="kn-setup-row">
        <RouterLink v-if="b.title" :to="`/documents/${b.fixtureId}`" class="kn-setup-name">{{ b.title }}</RouterLink>
        <span v-else class="kn-setup-name text-muted-foreground">{{ t('apiTests.setup.hidden') }}</span>
        <span v-if="b.archived" class="kn-setup-flag">{{ t('apiTests.setup.archived') }}</span>
        <Button
          v-if="canBind"
          size="icon-sm"
          variant="ghost"
          class="kn-setup-remove"
          :disabled="fixtures.saving.value"
          :aria-label="t('apiTests.setup.unbind', { name: b.title ?? t('apiTests.setup.hidden') })"
          @click="fixtures.unbind(b.fixtureId)"
        >
          <X class="size-3.5" aria-hidden="true" />
        </Button>
      </li>
    </ul>

    <div v-if="needsGenerate" class="kn-ts-status" role="status">
      <span>{{ t('apiTests.setup.regenerate') }}</span>
      <Button v-if="canGenerate" size="sm" variant="outline" @click="emit('generate')">{{ t('apiTests.generate') }}</Button>
    </div>

    <form v-if="canBind && addable.length" class="kn-setup-add" @submit.prevent="add">
      <label :for="`${uid}-add`" class="sr-only">{{ t('apiTests.setup.addLabel') }}</label>
      <select :id="`${uid}-add`" v-model="picked" class="kn-setup-select">
        <option value="" disabled>{{ t('apiTests.setup.addPlaceholder') }}</option>
        <option v-for="f in addable" :key="f.documentId" :value="f.documentId">{{ f.title }}</option>
      </select>
      <Button type="submit" size="sm" variant="outline" :disabled="!picked || fixtures.saving.value">
        <Plus class="size-3.5" aria-hidden="true" />
        {{ t('apiTests.setup.bind') }}
      </Button>
    </form>
    <p v-if="fixtures.error.value" class="kn-ts-status kn-ts-status--error" role="alert">{{ fixtures.error.value }}</p>

    <div v-if="suggestions.length || uncovered.length" class="kn-setup-suggest">
      <div class="kn-setup-suggest-head">
        <h6 class="kn-setup-subtitle">{{ t('apiTests.setup.suggested') }}</h6>
        <Button
          v-if="canBind && suggestions.length > 1"
          size="sm"
          variant="ghost"
          :disabled="ranking === 'pending' || ranking === 'ready'"
          @click="fixtures.rank()"
        >
          <Loader2 v-if="ranking === 'pending'" class="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <Sparkles v-else class="size-3.5" aria-hidden="true" />
          {{ ranking === 'pending' ? t('apiTests.setup.ranking') : ranking === 'ready' ? t('apiTests.setup.ranked') : t('apiTests.setup.rank') }}
        </Button>
      </div>
      <p v-if="ranking === 'failed' || fixtures.rankError.value" class="kn-ts-status kn-ts-status--error" role="alert">
        {{ fixtures.rankError.value || t('apiTests.setup.rankFailed') }}
      </p>
      <ul class="kn-ts-list">
        <li v-for="c in suggestions" :key="c.documentId" class="kn-setup-row kn-setup-row--suggest">
          <div class="min-w-0">
            <RouterLink :to="`/documents/${c.documentId}`" class="kn-setup-name">{{ c.title }}</RouterLink>
            <p class="kn-setup-why">{{ c.reason }}</p>
            <p v-if="c.explanation" class="kn-setup-why kn-setup-why--tester">
              <Sparkles class="kn-setup-why-icon" aria-hidden="true" />
              <span class="sr-only">{{ t('apiTests.setup.testerSays') }}</span>{{ c.explanation }}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            :disabled="!canBind || fixtures.saving.value"
            :title="canBind ? undefined : t('apiTests.noCapability')"
            @click="fixtures.bind(c.documentId)"
          >
            {{ t('apiTests.setup.bind') }}
          </Button>
        </li>
        <li v-for="p in uncovered" :key="p.producer" class="kn-setup-row kn-setup-row--suggest">
          <p class="kn-setup-why min-w-0">
            {{ t('apiTests.setup.uncovered', { op: opLabel(p) }) }}
          </p>
          <Button as-child size="sm" variant="ghost">
            <RouterLink to="/create/fixture">{{ t('apiTests.setup.newFixture') }}</RouterLink>
          </Button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style>
.kn-setup {
  display: grid;
  gap: 0.6rem;
  transition: opacity 150ms ease-out;
}
.kn-setup[aria-busy='true'] {
  opacity: 0.7;
}
.kn-setup-head .kn-ts-group-title {
  margin-bottom: 0.15rem;
}
.kn-setup-hint {
  font-size: var(--kn-text-ui);
  color: var(--muted-foreground);
  max-width: 65ch;
}
.kn-setup-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-height: 2.5rem;
  padding: 0.35rem 0.4rem;
  border-bottom: 1px solid var(--border);
  font-size: var(--kn-text-sm);
}
.kn-setup-row--suggest {
  align-items: flex-start;
  justify-content: space-between;
  padding-block: 0.6rem;
}
.kn-setup-name {
  min-width: 0;
  color: var(--foreground);
  overflow-wrap: anywhere;
  text-underline-offset: 3px;
}
a.kn-setup-name:hover {
  color: var(--primary);
  text-decoration: underline;
}
a.kn-setup-name:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
  border-radius: 4px;
}
.kn-setup-flag {
  font-size: var(--kn-text-xs);
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 0.45rem;
}
.kn-setup-remove {
  margin-inline-start: auto;
}
.kn-setup-add {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.kn-setup-select {
  flex: 1 1 14rem;
  min-width: 0;
  height: 2rem;
  padding: 0 0.5rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--foreground);
  font-size: var(--kn-text-sm);
}
.kn-setup-select:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}
.kn-setup-suggest {
  display: grid;
  gap: 0.35rem;
  margin-top: 0.4rem;
}
.kn-setup-suggest-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.kn-setup-subtitle {
  font-size: var(--kn-text-xs);
  font-weight: 600;
  color: var(--muted-foreground);
}
.kn-setup-why {
  margin-top: 0.15rem;
  font-size: var(--kn-text-xs);
  line-height: 1.5;
  color: var(--muted-foreground);
}
.kn-setup-why--tester {
  display: flex;
  gap: 0.35rem;
  color: color-mix(in oklab, var(--foreground) 80%, var(--card));
}
.kn-setup-why-icon {
  flex: none;
  width: 0.8rem;
  height: 0.8rem;
  margin-top: 0.2rem;
  color: var(--primary);
}
@media (prefers-reduced-motion: reduce) {
  .kn-setup {
    transition: none;
  }
}
</style>
