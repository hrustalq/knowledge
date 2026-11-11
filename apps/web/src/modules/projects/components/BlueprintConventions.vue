<script setup lang="ts">
/**
 * The Conventions step (#716): what the project starts knowing besides its
 * pages — a styleguide, its own templates, glossary terms.
 *
 * A styleguide is trusted prompt text and the scaffold refuses it from anyone
 * but a workspace admin (`POST /v1/projects/scaffold`), so an editor sees the
 * rules a blueprint carries, is told they will be skipped, and cannot add any.
 * Terms and templates are editor-level, as their own routes are.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, AlertTriangle, Lightbulb, Plus, X } from 'lucide-vue-next'
import {
  STYLE_RULE_SEVERITIES,
  STYLE_RULE_TEXT_MAX,
  type BlueprintConventions,
  type BlueprintGlossaryTerm,
  type StyleRuleSeverity,
} from '@knowledge/contracts'
import { Button } from '@knowledge/ui/button'
import { Input } from '@knowledge/ui/input'
import { Textarea } from '@knowledge/ui/textarea'
import { Checkbox } from '@knowledge/ui/checkbox'
import { cloneJson } from '@/modules/projects/model/blueprint-tree'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@knowledge/ui/select'

const props = defineProps<{
  conventions: BlueprintConventions
  canAdmin: boolean
  /** Terms a derived blueprint's source project offers (same workspace only), unchecked until picked. */
  offer?: { from: string; terms: BlueprintGlossaryTerm[] } | null
}>()
const emit = defineEmits<{ 'update:conventions': [BlueprintConventions] }>()

const { t } = useI18n()

const SEVERITY = {
  error: { icon: AlertCircle, tone: 'text-panel-caution', label: 'mr.severityError' },
  warning: { icon: AlertTriangle, tone: 'text-panel-warning', label: 'mr.severityWarning' },
  suggestion: { icon: Lightbulb, tone: 'text-panel-note', label: 'mr.severitySuggestion' },
} as const

const rules = computed(() => props.conventions.styleguide?.rules ?? [])
const terms = computed(() => props.conventions.glossary ?? [])
const templates = computed(() => props.conventions.templates ?? [])

function update(patch: (c: BlueprintConventions) => void) {
  const next = cloneJson(props.conventions)
  patch(next)
  // An empty section is no section: the scaffold would write an empty styleguide.
  if (!next.styleguide?.rules.length) delete next.styleguide
  if (!next.glossary?.length) delete next.glossary
  if (!next.templates?.length) delete next.templates
  emit('update:conventions', next)
}

/* ---- styleguide ---- */
const ruleText = ref('')
const ruleSeverity = ref<StyleRuleSeverity>('warning')
function addRule() {
  const text = ruleText.value.trim()
  if (!text) return
  update((c) => {
    const taken = new Set(c.styleguide?.rules.map((r) => r.id))
    let n = taken.size + 1
    while (taken.has(`rule-${n}`)) n++
    ;(c.styleguide ??= { rules: [] }).rules.push({ id: `rule-${n}`, text, severity: ruleSeverity.value, enabled: true })
  })
  ruleText.value = ''
}

/* ---- glossary ---- */
const key = (g: { term: string }) => g.term.trim().toLowerCase()
const picked = computed(() => new Set(terms.value.map(key)))
function toggleOffered(g: BlueprintGlossaryTerm, on: boolean) {
  update((c) => {
    c.glossary = (c.glossary ?? []).filter((x) => key(x) !== key(g))
    if (on) c.glossary.push(cloneJson(g))
  })
}
const offered = computed(() => props.offer?.terms ?? [])
const offeredKeys = computed(() => new Set(offered.value.map(key)))
/** The list above the add form: what was typed here, not what was ticked from the offer. */
const ownTerms = computed(() => terms.value.map((g, i) => ({ g, i })).filter(({ g }) => !offeredKeys.value.has(key(g))))

const term = ref('')
const definition = ref('')
// An offered term counts too: ticking it is how that one is added.
const termTaken = computed(() => {
  const k = key({ term: term.value })
  return picked.value.has(k) || offeredKeys.value.has(k)
})
function addTerm() {
  if (!term.value.trim() || !definition.value.trim() || termTaken.value) return
  update((c) => (c.glossary ??= []).push({ term: term.value.trim(), definition: definition.value.trim() }))
  term.value = definition.value = ''
  document.getElementById('kn-scaffold-term')?.focus()
}
</script>

<template>
  <!-- At the header's gutter like every step, and two columns once a wide
       screen has room: the styleguide and the glossary are read side by side. -->
  <div class="w-full space-y-8 px-4 py-6 lg:px-6">
    <div>
      <h2 class="text-lg font-semibold">{{ t('scaffold.conventions.title') }}</h2>
      <p class="kn-measure text-muted-foreground mt-1 text-sm leading-relaxed">{{ t('scaffold.conventions.body') }}</p>
    </div>

    <div class="grid items-start gap-x-10 gap-y-8 xl:grid-cols-2">

    <!-- Styleguide -->
    <section class="space-y-3" aria-labelledby="kn-scaffold-sg">
      <div>
        <h3 id="kn-scaffold-sg" class="text-sm font-medium">{{ t('scaffold.conventions.styleguide') }}</h3>
        <p class="text-muted-foreground mt-0.5 text-xs leading-snug">{{ t('scaffold.conventions.styleguideHint') }}</p>
      </div>
      <p v-if="!canAdmin" class="kn-callout-warning rounded-lg px-3 py-2 text-xs leading-snug">
        {{ rules.length ? t('scaffold.conventions.styleguideSkipped') : t('scaffold.conventions.styleguideAdminOnly') }}
      </p>
      <ol v-if="rules.length" class="divide-y rounded-lg border" :class="!canAdmin && 'opacity-60'">
        <li v-for="(rule, i) in rules" :key="rule.id" class="flex items-start gap-3 px-3 py-2.5">
          <component :is="SEVERITY[rule.severity].icon" class="mt-0.5 size-3.5 shrink-0" :class="SEVERITY[rule.severity].tone" />
          <span class="min-w-0 flex-1 text-ui leading-snug wrap-break-word">{{ rule.text }}</span>
          <button
            v-if="canAdmin"
            type="button"
            class="text-muted-foreground hover:text-foreground -m-1 grid size-6 shrink-0 place-items-center rounded"
            :aria-label="t('scaffold.conventions.removeRule', { n: i + 1 })"
            @click="update((c) => c.styleguide!.rules.splice(i, 1))"
          >
            <X class="size-3.5" />
          </button>
        </li>
      </ol>
      <form v-if="canAdmin" class="flex flex-wrap items-start gap-2" @submit.prevent="addRule">
        <Textarea
          v-model="ruleText"
          rows="1"
          class="min-h-9 min-w-0 flex-1 basis-64"
          :maxlength="STYLE_RULE_TEXT_MAX"
          :placeholder="t('ai.styleguide.rulePlaceholder')"
          :aria-label="t('scaffold.conventions.newRule')"
          @keydown.enter.exact.prevent="addRule"
        />
        <Select v-model="ruleSeverity">
          <SelectTrigger class="h-9 w-36 text-xs" :aria-label="t('ai.styleguide.severity')"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="s in STYLE_RULE_SEVERITIES" :key="s" :value="s">{{ t(SEVERITY[s].label) }}</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" variant="outline" class="h-9 gap-1" :disabled="!ruleText.trim()">
          <Plus class="size-3.5" /> {{ t('scaffold.conventions.addRule') }}
        </Button>
      </form>
    </section>

    <!-- Glossary -->
    <section class="space-y-3" aria-labelledby="kn-scaffold-gl">
      <div>
        <h3 id="kn-scaffold-gl" class="text-sm font-medium">{{ t('scaffold.conventions.glossary') }}</h3>
        <p class="text-muted-foreground mt-0.5 text-xs leading-snug">{{ t('scaffold.conventions.glossaryHint') }}</p>
      </div>
      <!-- Offered by the source project: a checklist, nothing ticked by default. -->
      <div v-if="offered.length" class="space-y-1.5">
        <p class="text-muted-foreground text-xs">
          {{ t('scaffold.conventions.offered', { from: offer!.from }) }}
        </p>
        <ul class="max-h-72 divide-y overflow-y-auto rounded-lg border">
          <li v-for="g in offered" :key="g.term">
            <label class="flex cursor-pointer items-start gap-3 px-3 py-2.5">
              <Checkbox
                class="mt-0.5"
                :model-value="picked.has(key(g))"
                @update:model-value="toggleOffered(g, $event === true)"
              />
              <span class="min-w-0 flex-1 text-ui leading-snug wrap-break-word">
                <span class="font-medium">{{ g.term }}</span>
                <span class="text-muted-foreground"> — {{ g.definition }}</span>
              </span>
            </label>
          </li>
        </ul>
      </div>
      <ul v-if="ownTerms.length" class="divide-y rounded-lg border">
        <li v-for="{ g, i } in ownTerms" :key="g.term" class="flex items-start gap-3 px-3 py-2.5">
          <span class="min-w-0 flex-1 text-ui leading-snug wrap-break-word">
            <span class="font-medium">{{ g.term }}</span>
            <span class="text-muted-foreground"> — {{ g.definition }}</span>
          </span>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground -m-1 grid size-6 shrink-0 place-items-center rounded"
            :aria-label="t('scaffold.conventions.removeTerm', { term: g.term })"
            @click="update((c) => c.glossary!.splice(i, 1))"
          >
            <X class="size-3.5" />
          </button>
        </li>
      </ul>
      <form class="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)_auto]" @submit.prevent="addTerm">
        <Input id="kn-scaffold-term" v-model="term" maxlength="200" :placeholder="t('scaffold.conventions.term')" :aria-label="t('scaffold.conventions.term')" :aria-invalid="termTaken || undefined" />
        <Input v-model="definition" maxlength="4000" :placeholder="t('scaffold.conventions.definition')" :aria-label="t('scaffold.conventions.definition')" />
        <Button type="submit" size="sm" variant="outline" class="h-9 gap-1" :disabled="!term.trim() || !definition.trim() || termTaken">
          <Plus class="size-3.5" /> {{ t('scaffold.conventions.addTerm') }}
        </Button>
      </form>
      <p v-if="termTaken" class="text-destructive text-xs">{{ t('scaffold.conventions.termTaken') }}</p>
    </section>

    <!-- Templates the blueprint carries. Built-ins carry none; a derived blueprint will. -->
    <section v-if="templates.length" class="space-y-3" aria-labelledby="kn-scaffold-tp">
      <div>
        <h3 id="kn-scaffold-tp" class="text-sm font-medium">{{ t('scaffold.conventions.templates') }}</h3>
        <p class="text-muted-foreground mt-0.5 text-xs leading-snug">{{ t('scaffold.conventions.templatesHint') }}</p>
      </div>
      <ul class="divide-y rounded-lg border">
        <li v-for="(tpl, i) in templates" :key="tpl.name" class="flex items-start gap-3 px-3 py-2.5">
          <span class="min-w-0 flex-1 text-ui leading-snug wrap-break-word">{{ tpl.icon ?? '' }} {{ tpl.name }}</span>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground -m-1 grid size-6 shrink-0 place-items-center rounded"
            :aria-label="t('scaffold.conventions.removeTemplate', { name: tpl.name })"
            @click="update((c) => c.templates!.splice(i, 1))"
          >
            <X class="size-3.5" />
          </button>
        </li>
      </ul>
    </section>
    </div>
  </div>
</template>
