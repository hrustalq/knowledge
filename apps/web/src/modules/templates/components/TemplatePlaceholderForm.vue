<script setup lang="ts">
/**
 * The fields a template declares (issue #69), one control per placeholder kind.
 *
 * `user` and `page` values are ids, picked from the same rosters the editor's
 * settings sheet and the owner picker use; the server turns them into a
 * mention chip, so nothing typed here becomes a raw link. An `entity` value is
 * typed as a key (`service:billing`) and folded wherever it lands in the
 * frontmatter.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TemplatePlaceholder, TemplateValues } from '@knowledge/contracts'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Autocomplete, type AutocompleteOption } from '@/shared/ui/autocomplete'
import { useMembers } from '@/entities/person'
import { useDocumentsStore } from '@/stores/documents'

const props = defineProps<{
  placeholders: TemplatePlaceholder[]
  /** Required names still blank — marked only once the author has tried to create. */
  missing: string[]
  showMissing: boolean
}>()
const values = defineModel<TemplateValues>({ required: true })

const { t } = useI18n()
const { members } = useMembers()
const documents = useDocumentsStore()

const memberOptions = computed<AutocompleteOption[]>(() =>
  members.value.filter((m) => !m.disabled).map((m) => ({ value: m.userId, label: m.displayName, meta: m.email })),
)
const pageOptions = computed<AutocompleteOption[]>(() =>
  documents.items.map((d) => ({ value: d.documentId, label: d.title })),
)

function set(name: string, value: string) {
  values.value = { ...values.value, [name]: value }
}

const invalid = (name: string) => props.showMissing && props.missing.includes(name)
const fieldId = (name: string) => `kn-tpl-${name}`
</script>

<template>
  <div v-for="p in placeholders" :key="p.name" class="space-y-1.5">
    <template v-if="p.kind === 'user' || p.kind === 'page'">
      <Autocomplete
        :model-value="values[p.name] ? [values[p.name]] : []"
        :multiple="false"
        :label="`${p.label || p.name}${p.required ? ' *' : ''}`"
        :placeholder="p.kind === 'user' ? t('templates.gallery.pickPerson') : t('templates.gallery.pickPage')"
        :options="p.kind === 'user' ? memberOptions : pageOptions"
        @update:model-value="(v: string[]) => set(p.name, v.at(-1) ?? '')"
      />
    </template>
    <template v-else>
      <Label :for="fieldId(p.name)">
        {{ p.label || p.name }}<span v-if="p.required" class="text-muted-foreground"> *</span>
      </Label>
      <Input
        :id="fieldId(p.name)"
        :type="p.kind === 'date' ? 'date' : 'text'"
        :model-value="values[p.name] ?? ''"
        :placeholder="p.kind === 'entity' ? (p.hint ?? 'service:billing') : undefined"
        :aria-invalid="invalid(p.name) || undefined"
        :aria-describedby="p.hint ? `${fieldId(p.name)}-hint` : undefined"
        @update:model-value="(v: string | number) => set(p.name, String(v))"
      />
    </template>
    <p v-if="invalid(p.name)" class="kn-field-error text-xs">{{ t('templates.gallery.required') }}</p>
    <p v-else-if="p.hint" :id="`${fieldId(p.name)}-hint`" class="text-muted-foreground text-xs">{{ p.hint }}</p>
  </div>
</template>

<style scoped>
/* `--destructive` is a fill colour; as text on the dark theme it is unreadable. */
.kn-field-error {
  color: color-mix(in oklab, var(--destructive) 45%, var(--foreground));
}
</style>
