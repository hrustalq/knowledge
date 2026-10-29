<script setup lang="ts">
/**
 * "Save as template" (issue #69): the page as it stands becomes the body of a
 * new template, with its tags and relations as the defaults pages created from
 * it inherit.
 *
 * Opened from the document view and from the editor. Placeholders are found
 * in the page's own `{{…}}` (`detectPlaceholders`) and can be adjusted before
 * saving; a page with none still makes a useful template — a fixed structure
 * to fill in by hand.
 *
 * A project template needs `editor`, a workspace-wide one `admin`
 * (`canWriteTemplate`, the API's rule); the scope the caller cannot write is
 * shown disabled with the reason rather than hidden, so the choice is legible.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import {
  DOCUMENT_CATEGORIES,
  composeTemplateSource,
  detectPlaceholders,
  type DocumentCategory,
  type TemplateDetail,
  type TemplatePlaceholder,
  type TemplateRelationDefault,
} from '@knowledge/contracts'
import { api } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { errorMessage } from '@/shared/api/errors'
import { canWriteTemplate, unescapePlaceholders } from '@/entities/template/model/templates'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useTemplatesStore } from '@/entities/template/model/templates.store'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Textarea } from '@/shared/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/shared/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import TemplatePlaceholdersEditor from './TemplatePlaceholdersEditor.vue'

/** The page as the template will start from it. */
export interface SaveAsTemplatePage {
  title: string
  body: string
  category: string
  tags: string[]
  relations: TemplateRelationDefault[]
  /** Frontmatter keys beyond tags and relations, carried into the template. */
  other: Record<string, unknown>
  projectId: string | null
}

const props = defineProps<{ page: SaveAsTemplatePage | null }>()
const open = defineModel<boolean>('open', { required: true })
/** After the template exists — the import's "Save as template instead" then drops its staging. */
const emit = defineEmits<{ saved: [TemplateDetail] }>()

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()
const templates = useTemplatesStore()

const name = ref('')
const description = ref('')
const icon = ref('')
const category = ref<DocumentCategory>('other')
/** What the author picked; until then the default follows what they may write (see `scope`). */
const chosenScope = ref<'project' | 'workspace' | null>(null)
const placeholders = ref<TemplatePlaceholder[]>([])
const saving = ref(false)

const canProject = computed(() => !!props.page?.projectId && canWriteTemplate('project', auth.role))
const canWorkspace = computed(() => canWriteTemplate('workspace', auth.role))
/** Derived until picked: the role can arrive after the dialog opens. */
const scope = computed<'project' | 'workspace'>({
  get: () => chosenScope.value ?? (canProject.value ? 'project' : 'workspace'),
  set: (value) => (chosenScope.value = value),
})
const projectName = computed(
  () => projects.items.find((p) => p.projectId === props.page?.projectId)?.name ?? t('import.project'),
)

/** The body as the rich editor wrote it, with its escaping inside `{{…}}` undone. */
const body = computed(() => unescapePlaceholders(props.page?.body ?? ''))

// Fresh per opening: a name and placeholders from the last page are a trap.
watch(
  open,
  (isOpen) => {
    const page = props.page
    if (!isOpen || !page) return
    name.value = page.title.trim()
    description.value = ''
    icon.value = ''
    category.value = (DOCUMENT_CATEGORIES as readonly string[]).includes(page.category)
      ? (page.category as DocumentCategory)
      : 'other'
    chosenScope.value = null
    placeholders.value = detectPlaceholders({ body: body.value, tags: page.tags, relations: page.relations })
  },
  { immediate: true },
)

/** An example value for the empty icon field — not prose, so not translated. */
const ICON_EXAMPLE = '📄'

// Built here, not in the template: a `}}` inside a mustache would close it.
const placeholdersHint = computed(() => t('templates.saveAs.placeholdersHint', { example: '{{name}}' }))

const canSave = computed(
  () =>
    !!name.value.trim() &&
    (scope.value === 'project' ? canProject.value : canWorkspace.value) &&
    placeholders.value.every((p) => p.name.trim()),
)

async function save() {
  const page = props.page
  if (!page || !canSave.value) return
  saving.value = true
  try {
    // `source:` names the connector page this one was synced from; a template
    // passing it on would claim every page created from it came from there.
    const other = Object.fromEntries(Object.entries(page.other).filter(([key]) => key !== 'source'))
    const created = await api.post('/v1/templates', {
      body: {
        workspaceId: getWorkspaceId(),
        projectId: scope.value === 'project' ? page.projectId : null,
        name: name.value.trim(),
        ...(description.value.trim() ? { description: description.value.trim() } : {}),
        ...(icon.value.trim() ? { icon: icon.value.trim() } : {}),
        source: composeTemplateSource({
          meta: { category: category.value, placeholders: placeholders.value },
          tags: page.tags,
          relations: page.relations,
          other,
          body: body.value,
        }),
      },
    })
    open.value = false
    emit('saved', created)
    void templates.refresh()
    toast.success(t('templates.saveAs.saved', { name: created.name }), {
      action: { label: t('templates.saveAs.openSettings'), onClick: () => void router.push(`/settings/templates/${created.ref}`) },
    })
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-xl">
      <DialogHeader class="border-b px-5 pt-5 pb-3">
        <DialogTitle>{{ t('templates.saveAs.title') }}</DialogTitle>
        <DialogDescription>{{ t('templates.saveAs.description') }}</DialogDescription>
      </DialogHeader>

      <form id="kn-save-as-template" class="min-h-0 space-y-4 overflow-y-auto px-5 py-4" @submit.prevent="save">
        <div class="grid grid-cols-[4rem_minmax(0,1fr)] gap-3">
          <div class="space-y-1.5">
            <Label for="kn-sat-icon">{{ t('templates.fields.icon') }}</Label>
            <Input id="kn-sat-icon" v-model="icon" class="text-center" maxlength="16" :placeholder="ICON_EXAMPLE" />
          </div>
          <div class="space-y-1.5">
            <Label for="kn-sat-name">{{ t('templates.fields.name') }}</Label>
            <Input id="kn-sat-name" v-model="name" maxlength="200" required />
          </div>
        </div>

        <div class="space-y-1.5">
          <Label for="kn-sat-description">{{ t('templates.fields.description') }}</Label>
          <Textarea id="kn-sat-description" v-model="description" rows="2" maxlength="1000" />
        </div>

        <div class="space-y-1.5">
          <Label id="kn-sat-scope-label">{{ t('templates.fields.scope') }}</Label>
          <RadioGroup v-model="scope" class="gap-2" aria-labelledby="kn-sat-scope-label">
            <label class="flex items-start gap-2 text-sm" :class="!canProject && 'opacity-60'">
              <RadioGroupItem value="project" :disabled="!canProject" class="mt-0.5" />
              <span>
                {{ t('templates.scope.projectNamed', { project: projectName }) }}
                <span v-if="!page?.projectId" class="text-muted-foreground block text-xs">{{ t('templates.scope.noProject') }}</span>
              </span>
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

        <div class="space-y-1.5">
          <Label for="kn-sat-category">{{ t('templates.fields.category') }}</Label>
          <Select v-model="category">
            <SelectTrigger id="kn-sat-category" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="c in DOCUMENT_CATEGORIES" :key="c" :value="c">{{ t(`category.${c}`) }}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="space-y-1.5">
          <Label>{{ t('templates.fields.placeholders') }}</Label>
          <p class="text-muted-foreground text-xs">{{ placeholdersHint }}</p>
          <TemplatePlaceholdersEditor v-model="placeholders" />
        </div>
      </form>

      <DialogFooter class="border-t px-5 py-3">
        <Button variant="ghost" :disabled="saving" @click="open = false">{{ t('common.cancel') }}</Button>
        <Button type="submit" form="kn-save-as-template" :disabled="saving || !canSave">
          {{ saving ? t('common.saving') : t('templates.saveAs.save') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
