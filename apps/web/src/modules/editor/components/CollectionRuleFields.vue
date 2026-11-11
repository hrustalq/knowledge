<script setup lang="ts">
/**
 * Page settings → Collection (#716): the rule new pages under this one follow,
 * a child template and a numbered title (`ADR {{n:4}}: `).
 *
 * Saved on its own, straight away, rather than with Publish: the rule is a
 * page field, not versioned, and has nothing to do with the body being edited.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { nextChildTitle } from '@knowledge/contracts'
import { Button } from '@knowledge/ui/button'
import { Input } from '@knowledge/ui/input'
import { Label } from '@knowledge/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@knowledge/ui/select'
import { api } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { useTemplatesStore } from '@/entities/template'
import { childTitles, type CollectionRule } from '@/modules/editor/model/collection'

const props = defineProps<{ documentId: string; rule: CollectionRule }>()
const emit = defineEmits<{ saved: [CollectionRule] }>()

const { t } = useI18n()
const queryClient = useQueryClient()
const templates = useTemplatesStore()

const NONE = '__none'
/** Literal braces cannot sit inside a template interpolation, nor in a vue-i18n message. */
const PATTERN_TOKENS = { n: '{{n:4}}', date: '{{date}}' }
const PATTERN_PLACEHOLDER = 'ADR {{n:4}}: '

const templateRef = ref(props.rule.childTemplateRef ?? NONE)
const pattern = ref(props.rule.childTitlePattern ?? '')
watch(
  () => props.rule,
  (r) => {
    templateRef.value = r.childTemplateRef ?? NONE
    pattern.value = r.childTitlePattern ?? ''
  },
)

const siblings = ref<string[]>([])
const saving = ref(false)

onMounted(() => {
  void templates.ensureLoaded()
  // Only for the preview: a failure leaves it numbering from 1.
  childTitles(queryClient, props.documentId).then((titles) => (siblings.value = titles), () => {})
})

/** A template the list no longer offers (archived, hidden) is still the saved one, so it stays selectable. */
const options = computed(() => {
  const offered = templates.offered.map((tpl) => ({ ref: tpl.ref, label: `${tpl.icon ?? ''} ${tpl.name}`.trim() }))
  const saved = props.rule.childTemplateRef
  return saved && !offered.some((o) => o.ref === saved) ? [{ ref: saved, label: templates.byRef(saved)?.name ?? saved }, ...offered] : offered
})

const next = computed(() => (pattern.value.trim() ? nextChildTitle(pattern.value, siblings.value) : ''))
const wanted = computed<CollectionRule>(() => ({
  childTemplateRef: templateRef.value === NONE ? null : templateRef.value,
  childTitlePattern: pattern.value.trim() ? pattern.value : null,
}))
const changed = computed(
  () => wanted.value.childTemplateRef !== props.rule.childTemplateRef || wanted.value.childTitlePattern !== props.rule.childTitlePattern,
)

async function save() {
  saving.value = true
  try {
    const doc = await api.patch('/v1/documents/{id}', { path: { id: props.documentId }, body: wanted.value })
    emit('saved', { childTemplateRef: doc.childTemplateRef ?? null, childTitlePattern: doc.childTitlePattern ?? null })
    toast.success(t('editor.collection.saved'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="space-y-3 border-t pt-5" :aria-labelledby="`collection-${documentId}`">
    <div class="space-y-1">
      <h3 :id="`collection-${documentId}`" class="kn-field-label">{{ t('editor.collection.title') }}</h3>
      <p class="text-xs leading-snug text-muted-foreground">{{ t('editor.collection.hint') }}</p>
    </div>

    <div class="space-y-1.5">
      <Label for="collection-template" class="kn-field-label">{{ t('scaffold.shape.childTemplate') }}</Label>
      <Select v-model="templateRef">
        <SelectTrigger id="collection-template" class="h-8 w-full min-w-0 text-xs"><SelectValue class="truncate" /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="NONE">{{ t('scaffold.shape.noTemplate') }}</SelectItem>
          <SelectItem v-for="o in options" :key="o.ref" :value="o.ref">{{ o.label }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="space-y-1.5">
      <Label for="collection-pattern" class="kn-field-label">{{ t('scaffold.shape.titlePattern') }}</Label>
      <Input id="collection-pattern" v-model="pattern" maxlength="100" :placeholder="PATTERN_PLACEHOLDER" class="h-8 font-mono text-xs" />
      <p class="text-xs leading-snug text-muted-foreground">
        {{ t('scaffold.shape.patternHint', PATTERN_TOKENS) }}
        <template v-if="next">
          <br />{{ t('scaffold.shape.nextItem') }} <span class="font-medium break-all text-foreground">{{ next }}</span>
        </template>
      </p>
    </div>

    <Button size="sm" variant="outline" :disabled="!changed || saving" @click="save">
      {{ saving ? t('editor.collection.saving') : t('editor.collection.save') }}
    </Button>
  </section>
</template>
