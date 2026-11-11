<script setup lang="ts">
/**
 * The selected page in the Shape step (#716): what it is called, what it is,
 * whether new pages under it follow a rule, and what it will open as.
 *
 * The preview draws what the scaffold writes (`ProjectScaffoldService.skeleton`):
 * a template page is that template's skeleton, any other page is its title,
 * its guidance as a note and its heading skeleton. Under a collection the
 * title is the numbered one.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileText, Layers, Plus } from 'lucide-vue-next'
import {
  blueprintText,
  DOCUMENT_CATEGORIES,
  nextChildTitle,
  type BlueprintNode,
  type DocumentCategory,
  type Locale,
  type TemplateRef,
  type TemplateSummary,
} from '@knowledge/contracts'
import { Button } from '@knowledge/ui/button'
import { Input } from '@knowledge/ui/input'
import { Textarea } from '@knowledge/ui/textarea'
import { Checkbox } from '@knowledge/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@knowledge/ui/select'
import { itemTitles, typedText } from '@/modules/projects/model/blueprint-tree'

const props = defineProps<{
  node: BlueprintNode
  /** The parent, when it is a collection: this page is one of its items. */
  collection: BlueprintNode | null
  /** This page's position among the collection's items. */
  index: number
  locale: Locale
  templates: TemplateSummary[]
}>()
const emit = defineEmits<{ patch: [(node: BlueprintNode) => void]; addItem: [] }>()

const { t } = useI18n()

const NONE = '__none'
/** Literal braces cannot sit inside a template interpolation, nor in a vue-i18n message. */
const PATTERN_TOKENS = { n: '{{n:4}}', date: '{{date}}' }
const PATTERN_PLACEHOLDER = 'ADR {{n:4}}: '
const text = (v: BlueprintNode['title'] | undefined) => blueprintText(v, props.locale)
const title = computed(() => text(props.node.title))
const shownTitle = computed(() =>
  props.collection ? (itemTitles(props.collection, props.locale)[props.index] ?? title.value) : title.value,
)
const templateRef = computed<TemplateRef | undefined>(
  () => props.node.templateRef ?? props.collection?.collection?.childTemplateRef,
)
const template = computed(() => props.templates.find((tpl) => tpl.ref === templateRef.value))
const templateName = (ref: string | undefined) => props.templates.find((tpl) => tpl.ref === ref)?.name ?? ref

const pattern = computed(() => text(props.node.collection?.childTitlePattern))
const nextItem = computed(() =>
  pattern.value ? nextChildTitle(pattern.value, itemTitles(props.node, props.locale), t('scaffold.shape.itemExample')) : '',
)
const headings = computed(() =>
  text(props.node.body)
    .split('\n')
    .filter((l) => /^#{2,4}\s/.test(l)),
)

function set<K extends keyof BlueprintNode>(key: K, value: BlueprintNode[K] | undefined) {
  emit('patch', (n) => {
    if (value === undefined || value === '') delete n[key]
    else n[key] = value
  })
}

function setText(key: 'title' | 'guidance', value: string) {
  set(key, key === 'title' || value.trim() ? typedText(props.locale, value) : undefined)
}

function setRule(key: 'childTemplateRef' | 'childTitlePattern', value: string) {
  emit('patch', (n) => {
    const c = (n.collection ??= {})
    if (!value || value === NONE) delete c[key]
    else if (key === 'childTitlePattern') c.childTitlePattern = typedText(props.locale, value)
    else c.childTemplateRef = value as TemplateRef
  })
}
</script>

<template>
  <div class="grid gap-6 p-4 lg:p-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <div class="min-w-0 space-y-4">
      <label class="block space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('scaffold.shape.title') }}</span>
        <Input
          id="kn-scaffold-node-title"
          :model-value="title"
          maxlength="200"
          :aria-invalid="!title.trim() || undefined"
          @update:model-value="(v) => setText('title', String(v))"
        />
        <span v-if="collection" class="text-muted-foreground block text-caption">
          {{ t('scaffold.shape.itemTitleHint', { title: shownTitle }) }}
        </span>
      </label>

      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('scaffold.shape.category') }}</span>
          <Select
            :model-value="node.category ?? NONE"
            @update:model-value="(v) => set('category', v === NONE ? undefined : (v as DocumentCategory))"
          >
            <SelectTrigger class="h-9 w-full min-w-0"><SelectValue class="truncate" /></SelectTrigger>
            <SelectContent>
              <SelectItem :value="NONE">{{ t('scaffold.shape.noCategory') }}</SelectItem>
              <SelectItem v-for="c in DOCUMENT_CATEGORIES" :key="c" :value="c">{{ t(`category.${c}`) }}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('scaffold.shape.template') }}</span>
          <Select
            :model-value="node.templateRef ?? NONE"
            @update:model-value="(v) => set('templateRef', v === NONE ? undefined : (v as TemplateRef))"
          >
            <SelectTrigger class="h-9 w-full min-w-0"><SelectValue class="truncate" /></SelectTrigger>
            <SelectContent>
              <SelectItem :value="NONE">
                {{ collection?.collection?.childTemplateRef ? t('scaffold.shape.inheritTemplate', { name: templateName(collection.collection.childTemplateRef) }) : t('scaffold.shape.noTemplate') }}
              </SelectItem>
              <SelectItem v-for="tpl in templates" :key="tpl.ref" :value="tpl.ref">{{ tpl.icon ?? '' }} {{ tpl.name }}</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>

      <label class="block space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('scaffold.shape.guidance') }}</span>
        <Textarea
          :model-value="text(node.guidance)"
          rows="2"
          maxlength="2000"
          :placeholder="t('scaffold.shape.guidancePlaceholder')"
          @update:model-value="(v) => setText('guidance', String(v))"
        />
      </label>

      <!-- A collection: the rule its future pages follow. -->
      <fieldset class="space-y-3 rounded-lg border p-3">
        <label class="flex items-start gap-2.5">
          <Checkbox class="mt-0.5" :model-value="!!node.collection" @update:model-value="set('collection', $event === true ? {} : undefined)" />
          <span>
            <span class="flex items-center gap-1.5 text-sm font-medium"><Layers class="size-3.5" /> {{ t('scaffold.shape.collection') }}</span>
            <span class="text-muted-foreground mt-0.5 block text-xs leading-snug">{{ t('scaffold.shape.collectionHint') }}</span>
          </span>
        </label>
        <template v-if="node.collection">
          <div class="grid gap-3">
            <label class="block space-y-1.5">
              <span class="text-muted-foreground text-xs font-medium">{{ t('scaffold.shape.childTemplate') }}</span>
              <Select
                :model-value="node.collection.childTemplateRef ?? NONE"
                @update:model-value="(v) => setRule('childTemplateRef', String(v))"
              >
                <SelectTrigger class="h-9 w-full min-w-0"><SelectValue class="truncate" /></SelectTrigger>
                <SelectContent>
                  <SelectItem :value="NONE">{{ t('scaffold.shape.noTemplate') }}</SelectItem>
                  <SelectItem v-for="tpl in templates" :key="tpl.ref" :value="tpl.ref">{{ tpl.icon ?? '' }} {{ tpl.name }}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label class="block space-y-1.5">
              <span class="text-muted-foreground text-xs font-medium">{{ t('scaffold.shape.titlePattern') }}</span>
              <Input
                class="font-mono text-sm"
                :model-value="pattern"
                maxlength="100"
                :placeholder="PATTERN_PLACEHOLDER"
                @update:model-value="(v) => setRule('childTitlePattern', String(v))"
              />
            </label>
          </div>
          <p class="text-muted-foreground text-caption leading-snug">
            {{ t('scaffold.shape.patternHint', PATTERN_TOKENS) }}
            <template v-if="nextItem">
              <br />{{ t('scaffold.shape.nextItem') }} <span class="text-foreground font-medium">{{ nextItem }}</span>
            </template>
          </p>
          <Button size="sm" variant="outline" class="gap-1" @click="emit('addItem')">
            <Plus class="size-3.5" /> {{ t('scaffold.shape.addItem') }}
          </Button>
        </template>
      </fieldset>
    </div>

    <!-- What the page opens as on day one. -->
    <section class="min-w-0" :aria-label="t('scaffold.shape.preview')">
      <h3 class="text-muted-foreground mb-2 text-xs font-medium">{{ t('scaffold.shape.preview') }}</h3>
      <div class="bg-card rounded-xl border p-5">
        <p class="font-display text-lg leading-snug font-semibold tracking-tight wrap-break-word">
          {{ shownTitle || t('scaffold.shape.untitled') }}
        </p>
        <template v-if="template">
          <p class="text-muted-foreground mt-3 flex items-start gap-2 text-ui leading-snug">
            <FileText class="mt-0.5 size-3.5 shrink-0" />
            <span>
              {{ t('scaffold.shape.fromTemplate', { name: template.name }) }}
              <span v-if="template.description" class="block text-caption">{{ template.description }}</span>
            </span>
          </p>
        </template>
        <template v-else>
          <p v-if="text(node.guidance).trim()" class="border-panel-note text-muted-foreground mt-3 border-l-2 pl-3 text-ui leading-relaxed">
            {{ text(node.guidance) }}
          </p>
          <ul v-if="headings.length" class="mt-3 space-y-1 text-ui">
            <li v-for="h in headings" :key="h" class="text-muted-foreground">{{ h.replace(/^#+\s*/, '') }}</li>
          </ul>
          <p v-if="!text(node.guidance).trim() && !headings.length" class="text-muted-foreground mt-3 text-ui">
            {{ t('scaffold.shape.blankPage') }}
          </p>
        </template>
        <p v-if="node.collection" class="text-muted-foreground mt-4 border-t pt-3 text-caption">
          {{ t('scaffold.shape.previewCollection', { count: node.children?.length ?? 0 }, node.children?.length ?? 0) }}
        </p>
      </div>
      <p class="text-muted-foreground mt-2 text-caption leading-snug">{{ t('scaffold.shape.stubNote') }}</p>
    </section>
  </div>
</template>
