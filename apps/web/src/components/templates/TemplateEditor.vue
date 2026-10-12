<script setup lang="ts">
/**
 * Writing a template in settings (issue #69): a form for the `template:`
 * block, the tags and relations pages inherit, and the rich editor for the
 * body — no YAML box. `composeTemplateSource` turns it back into the stored
 * markdown, and the API's parser is the one that decides it is valid.
 *
 * Three ways in:
 * - `create` — a new custom template, project or workspace-wide.
 * - `edit` — a custom template, or a built-in this workspace already customised.
 * - `customise` — a built-in's shipped source as the starting point. Its name
 *   and description stay the product's (translated); only its shape is the
 *   workspace's, and saving continues its version line.
 *
 * A save sends `source` only when the shape changed, so renaming does not
 * mint a version. "Changed" is against the editor's own normalised reading of
 * what was loaded (captured on `ready`), for the reason EditorPage captures
 * its baseline there: the rich editor may spell a loaded body differently
 * without anyone having touched it.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Plus, X } from 'lucide-vue-next'
import {
  AUTHORABLE_RELATION_TYPES,
  DOCUMENT_CATEGORIES,
  SYSTEM_PLACEHOLDERS,
  composeTemplateSource,
  detectPlaceholders,
  type DocumentCategory,
  type TemplateDetail,
  type TemplatePlaceholder,
  type TemplateRelationDefault,
} from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { errorMessage } from '@/api/errors'
import { canWriteTemplate, templateSourceFields, unescapePlaceholders } from '@/lib/templates'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import RichEditor from '@/components/editor/RichEditor.vue'
import TemplatePlaceholdersEditor from './TemplatePlaceholdersEditor.vue'

const props = defineProps<{
  mode: 'create' | 'edit' | 'customise'
  /** What is being edited or customised; absent when creating. */
  detail?: TemplateDetail | null
}>()
const emit = defineEmits<{ saved: [detail: TemplateDetail]; cancel: [] }>()

const { t } = useI18n()
const auth = useAuthStore()
const projects = useProjectsStore()

const isBuiltIn = computed(() => props.mode === 'customise' || !!props.detail?.builtInKey)

const name = ref('')
const description = ref('')
const icon = ref('')
/** What the author picked; until then the default follows what they may write (see `scope`). */
const chosenScope = ref<'project' | 'workspace' | null>(null)
const category = ref<DocumentCategory>('other')
const titlePattern = ref('')
const aiInstructions = ref('')
const placeholders = ref<TemplatePlaceholder[]>([])
const tags = ref('')
const relations = ref<TemplateRelationDefault[]>([])
const other = ref<Record<string, unknown>>({})
/** Carried, not edited here: the parser reads it, the gallery shows the row's description. */
const metaDescription = ref<string | undefined>(undefined)
const body = ref('')
const saving = ref(false)

const editorRef = ref<InstanceType<typeof RichEditor> | null>(null)
/** The source as loaded, in the editor's spelling — see the file comment. */
const baseline = ref<string | null>(null)

const activeProjectId = computed(() => projects.activeId ?? null)
const activeProjectName = computed(
  () => projects.items.find((p) => p.projectId === activeProjectId.value)?.name ?? t('import.project'),
)
const canProject = computed(() => !!activeProjectId.value && canWriteTemplate('project', auth.role))
const canWorkspace = computed(() => canWriteTemplate('workspace', auth.role))
/**
 * Derived, not seeded: the active project and the role can both arrive after
 * the form opens, and a default fixed at that moment silently made a
 * workspace-wide template of what should have been the project's.
 */
const scope = computed<'project' | 'workspace'>({
  get: () => chosenScope.value ?? (canProject.value ? 'project' : 'workspace'),
  set: (value) => (chosenScope.value = value),
})

watch(
  () => [props.mode, props.detail] as const,
  () => {
    const d = props.detail
    const fields = d
      ? templateSourceFields(d)
      : { meta: { category: 'other' as DocumentCategory, placeholders: [] }, tags: [], relations: [], other: {}, body: '' }
    name.value = props.mode === 'create' ? '' : (d?.name ?? '')
    description.value = d?.description ?? ''
    icon.value = d?.icon ?? ''
    chosenScope.value = null
    category.value = fields.meta.category
    titlePattern.value = fields.meta.titlePattern ?? ''
    aiInstructions.value = fields.meta.aiInstructions ?? ''
    metaDescription.value = fields.meta.description
    placeholders.value = fields.meta.placeholders
    tags.value = fields.tags.join(', ')
    relations.value = fields.relations
    other.value = fields.other ?? {}
    body.value = fields.body
    baseline.value = null
  },
  { immediate: true },
)

function currentSource(): string {
  const markdown = unescapePlaceholders(editorRef.value?.flush() ?? body.value)
  return composeTemplateSource({
    meta: {
      category: category.value,
      placeholders: placeholders.value,
      ...(titlePattern.value.trim() ? { titlePattern: titlePattern.value.trim() } : {}),
      ...(metaDescription.value ? { description: metaDescription.value } : {}),
      ...(aiInstructions.value.trim() ? { aiInstructions: aiInstructions.value.trim() } : {}),
    },
    tags: tags.value.split(',').map((tag) => tag.trim()).filter(Boolean),
    relations: relations.value,
    other: other.value,
    body: markdown,
  })
}

function onEditorReady() {
  if (props.mode !== 'create') baseline.value = currentSource()
}

function detect() {
  placeholders.value = detectPlaceholders(
    {
      body: unescapePlaceholders(editorRef.value?.flush() ?? body.value),
      tags: tags.value.split(','),
      relations: relations.value,
    },
    placeholders.value,
  )
}

/** Example values for empty fields — syntax, not prose, so not translated. */
const EXAMPLES = { icon: '📄', titlePattern: 'ADR-{{number}}: {{title}}', relationTarget: 'service:{{component}}' }

// Built here, not in the template: a `}}` inside a mustache would close it.
const hints = computed(() => ({
  titlePattern: t('templates.fields.titlePatternHint', { example: 'ADR-{{number}}: {{title}}' }),
  placeholders: t('templates.fields.placeholdersHint', { example: '{{name}}' }),
  body: t('templates.fields.bodyHint', {
    example: '{{name}}',
    system: SYSTEM_PLACEHOLDERS.map((name) => `{{${name}}}`).join(', '),
    escaped: '\\{{name}}',
  }),
}))

const canSave = computed(
  () =>
    (isBuiltIn.value || !!name.value.trim()) &&
    placeholders.value.every((p) => p.name.trim()) &&
    (props.mode !== 'create' || (scope.value === 'project' ? canProject.value : canWorkspace.value)),
)

/** Row fields only a custom template owns; a built-in keeps the product's. */
function rowFields() {
  if (isBuiltIn.value) return {}
  return {
    name: name.value.trim(),
    description: description.value.trim() || null,
    icon: icon.value.trim() || null,
  }
}

async function save() {
  if (!canSave.value) return
  saving.value = true
  try {
    const source = currentSource()
    const d = props.detail
    let saved: TemplateDetail
    if (props.mode === 'create') {
      saved = await apiFetch<TemplateDetail>('/v1/templates', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: getWorkspaceId(),
          projectId: scope.value === 'project' ? activeProjectId.value : null,
          ...rowFields(),
          source,
        }),
      })
    } else if (d?.builtInKey && !d.id) {
      // An untouched built-in has no row yet: the override starts here.
      saved = await apiFetch<TemplateDetail>('/v1/templates', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: getWorkspaceId(), builtInKey: d.builtInKey, source }),
      })
    } else if (d?.id) {
      // A built-in that is only hidden has a row but no versions of its own;
      // its first source continues the shipped line all the same.
      const changed = source !== baseline.value || (d.builtInKey !== null && !d.customized)
      saved = await apiFetch<TemplateDetail>(`/v1/templates/${d.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...rowFields(), ...(changed ? { source } : {}) }),
      })
    } else {
      return
    }
    toast.success(
      props.mode === 'create'
        ? t('templates.settings.created', { name: saved.name })
        : t('templates.settings.saved', { name: saved.name, version: saved.currentVersion }),
    )
    emit('saved', saved)
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <form class="space-y-6" @submit.prevent="save">
    <section v-if="!isBuiltIn" class="space-y-4">
      <div class="grid grid-cols-[4rem_minmax(0,1fr)] gap-3">
        <div class="space-y-1.5">
          <Label for="kn-tpl-icon">{{ t('templates.fields.icon') }}</Label>
          <Input id="kn-tpl-icon" v-model="icon" class="text-center" maxlength="16" :placeholder="EXAMPLES.icon" />
        </div>
        <div class="space-y-1.5">
          <Label for="kn-tpl-name">{{ t('templates.fields.name') }}</Label>
          <Input id="kn-tpl-name" v-model="name" maxlength="200" required />
        </div>
      </div>
      <div class="space-y-1.5">
        <Label for="kn-tpl-description">{{ t('templates.fields.description') }}</Label>
        <Textarea id="kn-tpl-description" v-model="description" rows="2" maxlength="1000" />
      </div>
      <div v-if="mode === 'create'" class="space-y-1.5">
        <Label>{{ t('templates.fields.scope') }}</Label>
        <RadioGroup v-model="scope" class="gap-2">
          <label class="flex items-start gap-2 text-sm" :class="!canProject && 'opacity-60'">
            <RadioGroupItem value="project" :disabled="!canProject" class="mt-0.5" />
            <span>{{ t('templates.scope.projectNamed', { project: activeProjectName }) }}</span>
          </label>
          <label class="flex items-start gap-2 text-sm" :class="!canWorkspace && 'opacity-60'">
            <RadioGroupItem value="workspace" :disabled="!canWorkspace" class="mt-0.5" />
            <span>
              {{ t('templates.scope.workspace') }}
              <span class="text-muted-foreground block text-xs">
                {{ canWorkspace ? t('templates.scope.workspaceHint') : t('templates.scope.adminOnly') }}
              </span>
            </span>
          </label>
        </RadioGroup>
      </div>
    </section>
    <p v-else class="text-muted-foreground bg-muted/30 rounded-md border px-3 py-2 text-sm">
      {{ t('templates.settings.customiseHint') }}
    </p>

    <section class="grid gap-4 sm:grid-cols-2">
      <div class="space-y-1.5">
        <Label>{{ t('templates.fields.category') }}</Label>
        <Select v-model="category">
          <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="c in DOCUMENT_CATEGORIES" :key="c" :value="c">{{ t(`category.${c}`) }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="space-y-1.5">
        <Label for="kn-tpl-title-pattern">{{ t('templates.fields.titlePattern') }}</Label>
        <Input id="kn-tpl-title-pattern" v-model="titlePattern" class="font-mono text-xs" :placeholder="EXAMPLES.titlePattern" />
        <p class="text-muted-foreground text-xs">{{ hints.titlePattern }}</p>
      </div>
    </section>

    <section class="space-y-1.5">
      <Label>{{ t('templates.fields.placeholders') }}</Label>
      <p class="text-muted-foreground text-xs">{{ hints.placeholders }}</p>
      <TemplatePlaceholdersEditor v-model="placeholders" can-detect @detect="detect" />
    </section>

    <section class="space-y-4">
      <div class="space-y-1.5">
        <Label for="kn-tpl-tags">{{ t('templates.fields.tags') }}</Label>
        <Input id="kn-tpl-tags" v-model="tags" class="text-xs" :placeholder="t('editor.tagsPlaceholder')" />
      </div>
      <div class="space-y-1.5">
        <Label>{{ t('templates.fields.relations') }}</Label>
        <div v-for="(r, i) in relations" :key="i" class="grid grid-cols-[10rem_minmax(0,1fr)_auto] gap-2">
          <Select :model-value="r.type" @update:model-value="relations[i] = { ...r, type: String($event) }">
            <SelectTrigger class="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="type in AUTHORABLE_RELATION_TYPES" :key="type" :value="type">{{ type }}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            :model-value="r.target"
            class="h-8 font-mono text-xs"
            :placeholder="EXAMPLES.relationTarget"
            :aria-label="t('templates.fields.relationTarget')"
            @update:model-value="relations[i] = { ...r, target: String($event) }"
          />
          <Button type="button" variant="ghost" size="icon-sm" :aria-label="t('common.remove')" @click="relations.splice(i, 1)">
            <X class="size-3.5" />
          </Button>
        </div>
        <Button type="button" variant="outline" size="sm" @click="relations.push({ type: 'DEPENDS_ON', target: '' })">
          <Plus class="size-3.5" /> {{ t('editor.addRelation') }}
        </Button>
      </div>
    </section>

    <section class="space-y-1.5">
      <Label for="kn-tpl-ai">{{ t('templates.fields.aiInstructions') }}</Label>
      <Textarea id="kn-tpl-ai" v-model="aiInstructions" rows="2" />
      <p class="text-muted-foreground text-xs">{{ t('templates.fields.aiInstructionsHint') }}</p>
    </section>

    <section class="space-y-1.5">
      <Label>{{ t('templates.fields.body') }}</Label>
      <p class="text-muted-foreground text-xs">{{ hints.body }}</p>
      <div class="kn-tpl-body rounded-md border px-4 py-3">
        <RichEditor ref="editorRef" v-model="body" @ready="onEditorReady" />
      </div>
    </section>

    <div class="bg-background sticky bottom-0 flex justify-end gap-2 border-t py-3">
      <Button type="button" variant="ghost" :disabled="saving" @click="emit('cancel')">{{ t('common.cancel') }}</Button>
      <Button type="submit" :disabled="saving || !canSave">
        {{ saving ? t('common.saving') : mode === 'create' ? t('templates.settings.create') : t('common.save') }}
      </Button>
    </div>
  </form>
</template>

<style scoped>
/* The body is a template, not a page: page-sized headings would push the form off screen. */
.kn-tpl-body :deep(.kn-prose h1) {
  font-size: 1.375rem;
}
</style>
