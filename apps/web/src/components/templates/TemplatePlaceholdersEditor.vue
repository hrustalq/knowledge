<script setup lang="ts">
/**
 * The placeholders a template declares (issue #69), as rows rather than YAML.
 *
 * Used by "Save as template", which starts from what the page's `{{…}}`
 * reference, and by the settings editor, where the author can also add one by
 * hand. Only declared names are filled in when a page is created, so a
 * `{{name}}` with no row here stays literal — which is also how an API-spec
 * template keeps its Handlebars examples.
 */
import { useI18n } from 'vue-i18n'
import { Plus, ScanSearch, X } from 'lucide-vue-next'
import { TEMPLATE_PLACEHOLDER_KINDS, type TemplatePlaceholder } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

defineProps<{
  disabled?: boolean
  /** Offer "Detect from text"; the host knows what text to scan. */
  canDetect?: boolean
}>()
const emit = defineEmits<{ detect: [] }>()
const placeholders = defineModel<TemplatePlaceholder[]>({ required: true })

const { t } = useI18n()

function patch(index: number, change: Partial<TemplatePlaceholder>) {
  placeholders.value = placeholders.value.map((p, i) => (i === index ? { ...p, ...change } : p))
}

function remove(index: number) {
  placeholders.value = placeholders.value.filter((_, i) => i !== index)
}

function add() {
  placeholders.value = [...placeholders.value, { name: '', kind: 'text' }]
}
</script>

<template>
  <div class="space-y-2">
    <p v-if="placeholders.length === 0" class="text-muted-foreground text-xs">
      {{ t('templates.placeholders.none') }}
    </p>
    <div
      v-for="(p, i) in placeholders"
      :key="i"
      class="bg-muted/20 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7.5rem_auto] items-center gap-2 rounded-md border p-2"
    >
      <Input
        :model-value="p.name"
        class="h-8 font-mono text-xs"
        :placeholder="t('templates.placeholders.name')"
        :aria-label="t('templates.placeholders.name')"
        :disabled="disabled"
        @update:model-value="patch(i, { name: String($event).trim() })"
      />
      <Input
        :model-value="p.label ?? ''"
        class="h-8 text-xs"
        :placeholder="t('templates.placeholders.label')"
        :aria-label="t('templates.placeholders.label')"
        :disabled="disabled"
        @update:model-value="patch(i, { label: String($event) })"
      />
      <Select
        :model-value="p.kind"
        :disabled="disabled"
        @update:model-value="patch(i, { kind: String($event) as TemplatePlaceholder['kind'] })"
      >
        <SelectTrigger class="h-8 w-full text-xs" :aria-label="t('templates.placeholders.kind')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="kind in TEMPLATE_PLACEHOLDER_KINDS" :key="kind" :value="kind">
            {{ t(`templates.placeholderKind.${kind}`) }}
          </SelectItem>
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        :disabled="disabled"
        :aria-label="t('templates.placeholders.remove', { name: p.name || '?' })"
        @click="remove(i)"
      >
        <X class="size-3.5" />
      </Button>
      <Input
        :model-value="p.hint ?? ''"
        class="col-span-2 h-7 text-xs"
        :placeholder="t('templates.placeholders.hint')"
        :aria-label="t('templates.placeholders.hint')"
        :disabled="disabled"
        @update:model-value="patch(i, { hint: String($event) })"
      />
      <label class="col-span-2 flex items-center gap-2 text-xs">
        <Checkbox
          :model-value="!!p.required"
          :disabled="disabled"
          @update:model-value="patch(i, { required: $event === true })"
        />
        {{ t('templates.gallery.required') }}
      </label>
    </div>
    <div v-if="!disabled" class="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" @click="add">
        <Plus class="size-3.5" /> {{ t('templates.placeholders.add') }}
      </Button>
      <Button v-if="canDetect" type="button" variant="ghost" size="sm" @click="emit('detect')">
        <ScanSearch class="size-3.5" /> {{ t('templates.placeholders.detect') }}
      </Button>
    </div>
  </div>
</template>
