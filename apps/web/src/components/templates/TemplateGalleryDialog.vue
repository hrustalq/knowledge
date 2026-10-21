<script setup lang="ts">
/**
 * "New page from template" (issue #69): pick a template, fill in what it asks
 * for, watch the skeleton fill in, open the editor on it.
 *
 * In insert mode — the editor's `/template` — the same pick and form end in
 * the render being handed back to the page being written, at its cursor,
 * rather than in a new page. There is no blank option and no title field:
 * the page already has both.
 *
 * Mounted once in AppShell and driven by the templates store, because the
 * places that open it — the tree's `+`, a row's menu, the empty tree, the
 * editor when a link arrives without values — know nothing of each other.
 *
 * The preview is rendered here with the contracts functions; the page itself
 * starts from the server's render (`POST /v1/templates/render`), made on
 * Create and handed to the editor through the store, because only the server
 * can turn a user or page id into a label inside the workspace. Nothing is
 * written until the author publishes in the editor.
 *
 * "Describe the page for AI" rides along the same way: the editor opens the
 * assistant on the skeleton and sends the description as its first turn, so
 * the sections fill in as suggestions the author keeps or discards.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { FilePlus2, LayoutTemplate, Search } from 'lucide-vue-next'
import type { Locale, RenderTemplateResponse, TemplateDetail, TemplateValues } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { errorMessage } from '@/api/errors'
import { labelFor } from '@/lib/labels'
import { groupTemplates, matchesTemplate, previewTemplate } from '@/lib/templates'
import { useTemplatesStore } from '@/stores/templates'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'
import { useAuthStore } from '@/stores/auth'
import { useMembers } from '@/components/merge-requests/use-members'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import TemplatePlaceholderForm from './TemplatePlaceholderForm.vue'

const { t, locale } = useI18n()
const router = useRouter()
const templates = useTemplatesStore()
const documents = useDocumentsStore()
const projects = useProjectsStore()
const auth = useAuthStore()
const { nameOf } = useMembers()

const open = computed({
  get: () => templates.gallery.open,
  // The dialog only ever closes itself; opening is the store's, with a mode.
  set: (v: boolean) => {
    if (!v) templates.closeGallery()
  },
})
const target = computed(() => templates.gallery.target)
const inserting = computed(() => target.value.mode === 'insert')

/** `null` is the blank page, listed first: starting from nothing is still the commonest start. */
const selectedRef = ref<string | null>(null)
const query = ref('')
const title = ref('')
const values = ref<TemplateValues>({})
/** "Describe the page for AI" — empty means open the skeleton as it is. */
const describe = ref('')
const detail = ref<TemplateDetail | null>(null)
const detailError = ref<string | null>(null)
const loadingDetail = ref(false)
const creating = ref(false)
/** Required fields are marked once Create has been tried, not while the form is still being read. */
const triedCreate = ref(false)

// Reset per opening: a template and its values from last time are a trap.
// Immediate, because AppShell mounts this on its first opening.
watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    void templates.ensureLoaded()
    if (!documents.loaded) void documents.fetchList()
    query.value = ''
    title.value = target.value.title ?? ''
    values.value = {}
    describe.value = ''
    triedCreate.value = false
    selectedRef.value = target.value.ref ?? null
  },
  { immediate: true },
)

const groups = computed(() =>
  groupTemplates(
    templates.offered.filter((tpl) => matchesTemplate(tpl, query.value, labelFor(t, 'category', tpl.category))),
  ),
)
const blankMatches = computed(
  () =>
    !inserting.value &&
    t('templates.gallery.blank').toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()),
)
const selected = computed(() => templates.byRef(selectedRef.value))

// The detail carries the body and placeholders; fetched per pick, newest pick
// wins. Immediate for the same first-mount reason as the opening reset.
let detailSeq = 0
watch(
  selectedRef,
  async (ref) => {
    detail.value = null
    detailError.value = null
    values.value = {}
    triedCreate.value = false
    if (!ref) return
    const seq = ++detailSeq
    loadingDetail.value = true
    try {
      const res = await templates.detail(ref)
      if (seq === detailSeq) detail.value = res
    } catch (e) {
      if (seq === detailSeq) detailError.value = errorMessage(e, t)
    } finally {
      if (seq === detailSeq) loadingDetail.value = false
    }
  },
  { immediate: true },
)

const projectId = computed(() => target.value.projectId || projects.activeId || null)
const parentTitle = computed(() => {
  const id = target.value.parentId
  if (!id) return null
  return documents.pathTo(id).at(-1)?.title ?? documents.items.find((d) => d.documentId === id)?.title ?? null
})
const projectName = computed(() => projects.items.find((p) => p.projectId === projectId.value)?.name ?? '')

/** Labels the pickers show, so a `user`/`page` value previews as the chip it will become. */
const labels = computed(() => {
  const out: Record<string, string> = {}
  for (const p of detail.value?.meta.placeholders ?? []) {
    const id = values.value[p.name]
    if (!id) continue
    if (p.kind === 'user') out[id] = nameOf(id)
    if (p.kind === 'page') out[id] = documents.items.find((d) => d.documentId === id)?.title ?? ''
  }
  return out
})

const preview = computed(() => {
  if (!detail.value) return null
  return previewTemplate(detail.value, values.value, {
    locale: locale.value as Locale,
    title: title.value.trim(),
    author: auth.me?.displayName,
    project: projectName.value,
    parent: parentTitle.value ?? undefined,
    labels: labels.value,
  })
})

const where = computed(() =>
  inserting.value
    ? t('templates.gallery.insertWhere')
    : parentTitle.value
    ? t('templates.gallery.whereUnder', { project: projectName.value, parent: parentTitle.value })
    : t('templates.gallery.whereTop', { project: projectName.value }),
)

/** The editor reads these once, as an opening instruction (see EditorPage). */
function editorQuery(ref?: string): Record<string, string> {
  return {
    ...(ref ? { template: ref } : {}),
    ...(target.value.parentId ? { parent: target.value.parentId } : {}),
    ...(projectId.value ? { project: projectId.value } : {}),
  }
}

async function create() {
  if (!selectedRef.value && inserting.value) return
  if (!selectedRef.value) {
    templates.closeGallery()
    await router.push({ path: '/create', query: editorQuery() })
    return
  }
  triedCreate.value = true
  if (!detail.value || preview.value?.missing.length) return
  creating.value = true
  try {
    const rendered = await apiFetch<RenderTemplateResponse>('/v1/templates/render', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: getWorkspaceId(),
        ref: selectedRef.value,
        version: detail.value.version,
        ...(title.value.trim() ? { title: title.value.trim() } : {}),
        values: values.value,
        ...(projectId.value ? { projectId: projectId.value } : {}),
        ...(target.value.parentId ? { parentId: target.value.parentId } : {}),
      }),
    })
    if (inserting.value) {
      templates.closeGallery()
      templates.deliverInsert(rendered)
      return
    }
    templates.rendered = rendered
    const prompt = describe.value.trim()
    templates.fill = prompt ? { ref: rendered.templateRef, prompt } : null
    templates.closeGallery()
    await router.push({ path: '/create', query: editorQuery(rendered.templateRef) })
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    creating.value = false
  }
}

function scopeLabel(scope: string): string {
  return scope === 'project'
    ? t('templates.gallery.groups.project')
    : scope === 'workspace'
      ? t('templates.gallery.groups.workspace')
      : t('templates.gallery.groups.builtIn')
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex h-[min(44rem,90vh)] flex-col gap-0 p-0 sm:max-w-4xl">
      <DialogHeader class="border-b px-5 pt-5 pb-3">
        <DialogTitle>{{ inserting ? t('templates.gallery.insertTitle') : t('templates.gallery.title') }}</DialogTitle>
        <DialogDescription>{{ where }}</DialogDescription>
      </DialogHeader>

      <div class="grid min-h-0 flex-1 grid-rows-[minmax(0,12rem)_minmax(0,1fr)] md:grid-cols-[17rem_minmax(0,1fr)] md:grid-rows-1">
        <!-- The roster ------------------------------------------------- -->
        <div class="flex min-h-0 flex-col border-b md:border-r md:border-b-0">
          <div class="px-3 py-2">
            <div class="relative">
              <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
              <Input
                v-model="query"
                class="h-8 pl-7"
                :placeholder="t('templates.gallery.search')"
                :aria-label="t('templates.gallery.search')"
              />
            </div>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2" role="listbox" :aria-label="t('templates.gallery.title')">
            <button
              v-if="blankMatches"
              type="button"
              role="option"
              :aria-selected="selectedRef === null"
              class="kn-tpl-row"
              :data-selected="selectedRef === null || undefined"
              @click="selectedRef = null"
            >
              <FilePlus2 class="text-muted-foreground size-4 shrink-0" />
              <span class="truncate">{{ t('templates.gallery.blank') }}</span>
            </button>

            <template v-if="!templates.loaded">
              <Skeleton v-for="i in 5" :key="i" class="mx-2 my-1.5 h-6" />
            </template>
            <template v-for="group in groups" v-else :key="group.scope">
              <p class="text-muted-foreground px-2 pt-3 pb-1 text-caption font-semibold tracking-wider uppercase">
                {{ scopeLabel(group.scope) }}
              </p>
              <button
                v-for="tpl in group.templates"
                :key="tpl.ref"
                type="button"
                role="option"
                :aria-selected="selectedRef === tpl.ref"
                class="kn-tpl-row"
                :data-selected="selectedRef === tpl.ref || undefined"
                @click="selectedRef = tpl.ref"
              >
                <span v-if="tpl.icon" class="w-4 shrink-0 text-center text-sm leading-none" aria-hidden="true">{{ tpl.icon }}</span>
                <LayoutTemplate v-else class="text-muted-foreground size-4 shrink-0" />
                <span class="min-w-0 flex-1 truncate">{{ tpl.name }}</span>
                <span class="text-muted-foreground shrink-0 text-xs">{{ labelFor(t, 'category', tpl.category) }}</span>
              </button>
            </template>
            <p
              v-if="templates.loaded && !groups.length && query.trim()"
              class="text-muted-foreground px-2 py-6 text-center text-sm"
            >
              {{ t('common.noMatchFor', { query }) }}
            </p>
          </div>
        </div>

        <!-- The pick ---------------------------------------------------- -->
        <div class="min-h-0 overflow-y-auto px-5 py-4">
          <div v-if="selectedRef === null" class="text-muted-foreground text-sm">
            {{ inserting ? t('templates.gallery.insertPick') : t('templates.gallery.blankDescription') }}
          </div>

          <p v-else-if="detailError" class="text-sm">{{ detailError }}</p>

          <div v-else-if="loadingDetail || !detail" class="space-y-3">
            <Skeleton class="h-5 w-1/2" />
            <Skeleton class="h-9 w-full" />
            <Skeleton class="h-40 w-full" />
          </div>

          <div v-else class="space-y-5">
            <p v-if="selected?.description || detail.meta.description" class="text-muted-foreground text-sm">
              {{ selected?.description || detail.meta.description }}
            </p>

            <form id="kn-tpl-form" class="space-y-3" @submit.prevent="create">
              <div v-if="!inserting" class="space-y-1.5">
                <Label for="kn-tpl-title">{{ t('templates.gallery.pageTitle') }}</Label>
                <Input id="kn-tpl-title" v-model="title" :placeholder="t('editor.pageTitle')" />
              </div>
              <TemplatePlaceholderForm
                v-model="values"
                :placeholders="detail.meta.placeholders"
                :missing="preview?.missing ?? []"
                :show-missing="triedCreate"
              />
              <div v-if="!inserting" class="space-y-1.5">
                <Label for="kn-tpl-describe">{{ t('templates.gallery.describeForAi') }}</Label>
                <Textarea
                  id="kn-tpl-describe"
                  v-model="describe"
                  rows="3"
                  maxlength="4000"
                  :placeholder="t('templates.gallery.describeForAiPlaceholder')"
                  @keydown.enter.meta.prevent="create"
                  @keydown.enter.ctrl.prevent="create"
                />
                <p class="text-muted-foreground text-xs">{{ t('templates.gallery.describeForAiHint') }}</p>
              </div>
            </form>

            <section :aria-label="t('templates.gallery.preview')">
              <p class="text-muted-foreground mb-1.5 text-caption font-semibold tracking-wider uppercase">
                {{ t('templates.gallery.preview') }}
              </p>
              <div class="kn-tpl-preview bg-muted/30 rounded-md border px-4 py-3">
                <p v-if="!inserting" class="mb-2 text-lg font-semibold">{{ preview?.title || t('editor.untitledPage') }}</p>
                <MarkdownView :markdown="preview?.body ?? ''" />
              </div>
            </section>
          </div>
        </div>
      </div>

      <DialogFooter class="border-t px-5 py-3">
        <Button variant="ghost" :disabled="creating" @click="open = false">{{ t('common.cancel') }}</Button>
        <!-- The form's submit button, outside it: Enter in any field submits. The
             blank page has no form, so it is the click that creates. -->
        <Button
          type="submit"
          form="kn-tpl-form"
          :disabled="creating || (selectedRef !== null && !detail) || (inserting && selectedRef === null)"
          @click="selectedRef === null && create()"
        >
          {{
            creating
              ? t('common.creating')
              : inserting
                ? t('templates.gallery.insert')
                : describe.trim() && selectedRef !== null
                  ? t('templates.gallery.createWithAi')
                  : t('templates.gallery.create')
          }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.kn-tpl-row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.5rem;
  border-radius: calc(var(--radius) - 2px);
  padding: 0.375rem 0.5rem;
  text-align: left;
  font-size: var(--kn-text-sm);
  transition: background-color 120ms;
}
.kn-tpl-row:hover {
  background: var(--accent);
}
.kn-tpl-row[data-selected] {
  background: color-mix(in oklab, var(--primary) 10%, transparent);
  color: var(--primary);
}
/* A page preview, not a page: headings at reading size would push the form off screen. */
.kn-tpl-preview :deep(h1) {
  font-size: 1.125rem;
}
.kn-tpl-preview :deep(h2) {
  font-size: 1rem;
}
</style>
