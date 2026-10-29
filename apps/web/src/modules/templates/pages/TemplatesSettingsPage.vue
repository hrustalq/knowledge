<script setup lang="ts">
/**
 * /settings/templates (issue #69): every template the active project can see,
 * including the archived ones and the built-ins this workspace hid — this is
 * where they are brought back.
 *
 * The rail groups by scope like the gallery does; the pane shows the picked
 * template's shape and its version history, and is where it is written:
 * created, edited, customised (a built-in), reset, hidden or archived.
 *
 * Controls follow `canWriteTemplate`, the API's rule: a project template is an
 * editor's, a workspace-wide one or a built-in an admin's. The API enforces
 * it either way; hiding a control only spares a 403.
 *
 * `/settings/templates/new` is the create form and `/settings/templates/<ref>`
 * a template, by ref (`builtin:adr` or a uuid), so a link to an untouched
 * built-in — which has no row id — still works.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import {
  Archive,
  ArchiveRestore,
  Eye,
  EyeOff,
  FilePlus2,
  LayoutTemplate,
  Pencil,
  Plus,
  RotateCcw,
  Search,
} from 'lucide-vue-next'
import type { TemplateDetail, TemplateSummary } from '@knowledge/contracts'
import { api } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { errorMessage } from '@/shared/api/errors'
import { labelFor } from '@/shared/i18n/labels'
import { canWriteTemplate, groupTemplates, matchesTemplate } from '@/entities/template'
import { useAuthStore } from '@/stores/auth'
import { useTemplatesStore } from '@/entities/template'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Skeleton } from '@/shared/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog'
import MarkdownView from '@/modules/documents/components/MarkdownView.vue'
import TemplateEditor from '@/modules/templates/components/TemplateEditor.vue'
import TemplateHistory from '@/modules/templates/components/TemplateHistory.vue'
import { PageTabs, panelId, tabId, type PageTab } from '@/shared/layout'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const templates = useTemplatesStore()

// On mount, not in setup: setup also runs in the SSR pass, and a fetch started
// there hydrates as a pending Promise that never settles (see the store).
onMounted(() => void templates.ensureLoaded())

const query = ref('')
const groups = computed(() =>
  groupTemplates(
    templates.templates.filter((tpl) => matchesTemplate(tpl, query.value, labelFor(t, 'category', tpl.category))),
  ),
)

const routeRef = computed(() => {
  const value = route.params.ref
  return typeof value === 'string' && value ? value : null
})
const creating = computed(() => routeRef.value === 'new')
const selected = computed<TemplateSummary | null>(() =>
  routeRef.value && !creating.value ? (templates.byRef(routeRef.value) ?? null) : null,
)

/** Anyone who could create at least a project template. */
const canCreate = computed(() => canWriteTemplate('project', auth.role))
const canWrite = computed(() => (selected.value ? canWriteTemplate(selected.value.scope, auth.role) : false))

const detail = ref<TemplateDetail | null>(null)
const detailError = ref<string | null>(null)
const editing = ref(false)
const tab = ref<'shape' | 'history'>('shape')
const tabs = computed<PageTab<'shape' | 'history'>[]>(() => [
  { key: 'shape', label: t('templates.settings.shape') },
  { key: 'history', label: t('templates.history.title') },
])
const busy = ref(false)
const confirmReset = ref(false)

let seq = 0
async function loadDetail() {
  const summary = selected.value
  detail.value = null
  detailError.value = null
  if (!summary) return
  const mine = ++seq
  try {
    const res = await templates.detail(summary.ref)
    if (mine === seq) detail.value = res
  } catch (e) {
    if (mine === seq) detailError.value = errorMessage(e, t)
  }
}

// A new pick starts on its shape, not mid-edit on the last one.
watch(
  () => selected.value?.ref,
  () => {
    editing.value = false
    tab.value = 'shape'
    void loadDetail()
  },
  { immediate: true },
)
// The same template moved on (saved, customised, reset): read it again.
watch(
  () => [selected.value?.currentVersion, selected.value?.customized, selected.value?.updatedAt],
  () => {
    if (!editing.value) void loadDetail()
  },
)

function scopeLabel(scope: string): string {
  return scope === 'project'
    ? t('templates.gallery.groups.project')
    : scope === 'workspace'
      ? t('templates.gallery.groups.workspace')
      : t('templates.gallery.groups.builtIn')
}

function open(ref: string) {
  void router.push(`/settings/templates/${encodeURIComponent(ref)}`)
}

async function onSaved(saved: TemplateDetail) {
  editing.value = false
  await templates.refresh()
  if (creating.value || routeRef.value !== saved.ref) open(saved.ref)
  else void loadDetail()
}

/** One write, then the roster again — every action here changes what the gallery offers. */
async function act(run: () => Promise<unknown>, done: string) {
  busy.value = true
  try {
    await run()
    await templates.refresh()
    toast.success(done)
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = false
  }
}

function setArchived(archived: boolean) {
  const tpl = selected.value
  const id = tpl?.id
  if (!tpl || !id) return
  void act(
    () =>
      archived
        ? api.post('/v1/templates/{id}/archive', { path: { id } })
        : api.post('/v1/templates/{id}/unarchive', { path: { id } }),
    archived ? t('templates.settings.archivedToast', { name: tpl.name }) : t('templates.settings.unarchivedToast', { name: tpl.name }),
  )
}

/** Hiding a built-in is a row with `enabled: false`; showing it again flips the row back. */
function setHidden(hidden: boolean) {
  const tpl = selected.value
  const builtInKey = tpl?.builtInKey
  if (!tpl || !builtInKey) return
  const id = tpl.id
  void act(
    () =>
      id
        ? api.patch('/v1/templates/{id}', { path: { id }, body: { enabled: !hidden } })
        : api.post('/v1/templates', {
            body: { workspaceId: getWorkspaceId(), builtInKey, enabled: !hidden },
          }),
    hidden ? t('templates.settings.hiddenToast', { name: tpl.name }) : t('templates.settings.shownToast', { name: tpl.name }),
  )
}

function reset() {
  const tpl = selected.value
  const id = tpl?.id
  confirmReset.value = false
  if (!tpl || !id) return
  void act(() => api.delete('/v1/templates/{id}', { path: { id } }), t('templates.settings.resetToast', { name: tpl.name }))
}

function useTemplate() {
  if (selected.value) templates.openGallery({ ref: selected.value.ref })
}

const editorMode = computed<'edit' | 'customise'>(() =>
  selected.value?.builtInKey && !selected.value.customized ? 'customise' : 'edit',
)
const offered = computed(() => !!selected.value && selected.value.enabled && !selected.value.archivedAt)
</script>

<template>
  <!-- Bleed out of the settings column's padding so the rail sits flush, as /settings/projects does. -->
  <div class="-mx-4 -my-6 flex min-h-0 flex-1 flex-col lg:-mx-8 lg:flex-row">
    <!-- The rail and the template's name carry the page visually; the route
         still needs the one h1 its h2s sit under. -->
    <h1 class="sr-only">{{ t('nav.templates') }}</h1>
    <div
      class="flex h-80 shrink-0 flex-col border-b bg-background lg:sticky lg:top-0 lg:h-[calc(100vh-5.75rem)] lg:w-72 lg:self-start lg:border-r lg:border-b-0"
    >
      <div class="border-b p-2">
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

      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <template v-if="!templates.loaded">
          <Skeleton v-for="i in 6" :key="i" class="mx-1 my-2 h-6" />
        </template>
        <template v-for="group in groups" v-else :key="group.scope">
          <p class="text-muted-foreground px-2 pt-3 pb-1 text-caption font-semibold tracking-wider uppercase">
            {{ scopeLabel(group.scope) }}
          </p>
          <RouterLink
            v-for="tpl in group.templates"
            :key="tpl.ref"
            :to="`/settings/templates/${encodeURIComponent(tpl.ref)}`"
            class="kn-tpl-rail-row"
            :data-selected="selected?.ref === tpl.ref || undefined"
            :data-muted="!tpl.enabled || !!tpl.archivedAt || undefined"
          >
            <span v-if="tpl.icon" class="w-4 shrink-0 text-center text-sm leading-none" aria-hidden="true">{{ tpl.icon }}</span>
            <LayoutTemplate v-else class="text-muted-foreground size-4 shrink-0" />
            <span class="min-w-0 flex-1 truncate">{{ tpl.name }}</span>
            <span v-if="tpl.archivedAt" class="text-muted-foreground shrink-0 text-caption">{{ t('templates.settings.archived') }}</span>
            <span v-else-if="!tpl.enabled" class="text-muted-foreground shrink-0 text-caption">{{ t('templates.settings.hidden') }}</span>
            <span v-else-if="tpl.customized" class="text-muted-foreground shrink-0 text-caption">{{ t('templates.settings.customized') }}</span>
          </RouterLink>
        </template>
        <p v-if="templates.loaded && !groups.length" class="text-muted-foreground px-2 py-6 text-center text-sm">
          {{ query.trim() ? t('common.noMatchFor', { query }) : t('templates.settings.none') }}
        </p>
      </div>

      <div v-if="canCreate" class="mt-auto shrink-0 border-t p-2">
        <Button variant="outline" size="sm" class="w-full justify-start gap-2" as-child>
          <RouterLink to="/settings/templates/new"><Plus class="size-4" /> {{ t('templates.settings.new') }}</RouterLink>
        </Button>
      </div>
    </div>

    <div data-kn-pane="3" class="flex min-h-0 min-w-0 flex-1 flex-col px-4 py-6 lg:px-8">
      <!-- New -------------------------------------------------------------- -->
      <template v-if="creating">
        <h2 class="mb-1 text-lg font-semibold">{{ t('templates.settings.new') }}</h2>
        <p class="text-muted-foreground mb-6 text-sm">{{ t('templates.settings.newHint') }}</p>
        <TemplateEditor v-if="canCreate" mode="create" @saved="onSaved" @cancel="router.push('/settings/templates')" />
        <p v-else class="text-sm">{{ t('templates.settings.readOnly') }}</p>
      </template>

      <!-- Nothing picked --------------------------------------------------- -->
      <div v-else-if="!selected" class="text-muted-foreground mx-auto my-16 max-w-sm space-y-2 text-center text-sm">
        <LayoutTemplate class="mx-auto size-8 opacity-40" aria-hidden="true" />
        <p v-if="routeRef && templates.loaded">{{ t('templates.settings.notFound') }}</p>
        <p v-else>{{ t('templates.settings.pick') }}</p>
      </div>

      <!-- A template ------------------------------------------------------- -->
      <template v-else>
        <!-- Name and actions share a row; the facts about the template get the
             full width under it, so a row of buttons never squeezes them. -->
        <header class="mb-4 space-y-2">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span v-if="selected.icon" class="text-2xl leading-none" aria-hidden="true">{{ selected.icon }}</span>
            <LayoutTemplate v-else class="text-muted-foreground size-6" aria-hidden="true" />
            <h2 class="min-w-0 flex-1 basis-48 truncate text-lg font-semibold">{{ selected.name }}</h2>

            <div v-if="!editing" class="flex flex-wrap gap-1.5">
              <Button v-if="offered && auth.canEdit" variant="outline" size="sm" @click="useTemplate">
                <FilePlus2 class="size-3.5" /> {{ t('templates.settings.use') }}
              </Button>
              <template v-if="canWrite">
                <Button v-if="!selected.archivedAt" variant="outline" size="sm" :disabled="!detail" @click="editing = true">
                  <Pencil class="size-3.5" />
                  {{ editorMode === 'customise' ? t('templates.settings.customise') : t('common.edit') }}
                </Button>
                <template v-if="selected.builtInKey">
                  <Button v-if="selected.enabled" variant="ghost" size="sm" :disabled="busy" @click="setHidden(true)">
                    <EyeOff class="size-3.5" /> {{ t('templates.settings.hide') }}
                  </Button>
                  <Button v-else variant="ghost" size="sm" :disabled="busy" @click="setHidden(false)">
                    <Eye class="size-3.5" /> {{ t('templates.settings.show') }}
                  </Button>
                  <Button v-if="selected.id" variant="ghost" size="sm" :disabled="busy" @click="confirmReset = true">
                    <RotateCcw class="size-3.5" /> {{ t('templates.settings.reset') }}
                  </Button>
                </template>
                <template v-else>
                  <Button v-if="!selected.archivedAt" variant="ghost" size="sm" :disabled="busy" @click="setArchived(true)">
                    <Archive class="size-3.5" /> {{ t('templates.settings.archive') }}
                  </Button>
                  <Button v-else variant="ghost" size="sm" :disabled="busy" @click="setArchived(false)">
                    <ArchiveRestore class="size-3.5" /> {{ t('templates.settings.unarchive') }}
                  </Button>
                </template>
              </template>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{{ scopeLabel(selected.scope) }}</Badge>
            <Badge variant="outline">{{ labelFor(t, 'category', selected.category) }}</Badge>
            <Badge variant="outline" class="font-mono">{{ t('templates.version', { version: selected.currentVersion }) }}</Badge>
            <Badge v-if="selected.customized" variant="secondary">{{ t('templates.settings.customized') }}</Badge>
            <Badge v-if="!selected.enabled" variant="secondary">{{ t('templates.settings.hidden') }}</Badge>
            <Badge v-if="selected.archivedAt" variant="secondary">{{ t('templates.settings.archived') }}</Badge>
          </div>
          <p v-if="selected.description" class="text-muted-foreground text-sm">{{ selected.description }}</p>
        </header>

        <p v-if="!canWrite && auth.role" class="text-muted-foreground mb-4 text-xs">
          {{ selected.scope === 'project' ? t('templates.settings.readOnly') : t('templates.settings.adminOnly') }}
        </p>

        <TemplateEditor
          v-if="editing && detail"
          :key="`${selected.ref}@${detail.version}`"
          :mode="editorMode"
          :detail="detail"
          @saved="onSaved"
          @cancel="editing = false"
        />

        <template v-else>
          <PageTabs v-model="tab" :tabs="tabs" :label="selected.name" class="mb-4" />

          <div :id="panelId(tab)" role="tabpanel" :aria-labelledby="tabId(tab)">
            <template v-if="tab === 'shape'">
              <p v-if="detailError" class="text-sm">{{ detailError }}</p>
              <div v-else-if="!detail" class="space-y-3">
                <Skeleton class="h-5 w-1/3" />
                <Skeleton class="h-40 w-full" />
              </div>
              <div v-else class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
                <div class="kn-tpl-preview min-w-0 rounded-md border px-5 py-4">
                  <MarkdownView :markdown="detail.body" />
                </div>
                <dl class="space-y-4 text-sm">
                  <div v-if="detail.meta.titlePattern">
                    <dt class="text-muted-foreground mb-1 text-xs font-medium">{{ t('templates.fields.titlePattern') }}</dt>
                    <dd class="font-mono text-xs">{{ detail.meta.titlePattern }}</dd>
                  </div>
                  <div>
                    <dt class="text-muted-foreground mb-1 text-xs font-medium">{{ t('templates.fields.placeholders') }}</dt>
                    <dd v-if="!detail.meta.placeholders.length" class="text-muted-foreground text-xs">
                      {{ t('templates.placeholders.none') }}
                    </dd>
                    <dd v-for="p in detail.meta.placeholders" :key="p.name" class="flex items-baseline gap-2 py-0.5">
                      <code class="text-xs">{{ p.name }}</code>
                      <span class="text-muted-foreground text-xs">
                        {{ t(`templates.placeholderKind.${p.kind}`) }}<template v-if="p.required"> · {{ t('templates.gallery.required') }}</template>
                      </span>
                    </dd>
                  </div>
                  <div v-if="detail.tags.length">
                    <dt class="text-muted-foreground mb-1 text-xs font-medium">{{ t('templates.fields.tags') }}</dt>
                    <dd class="flex flex-wrap gap-1">
                      <Badge v-for="tag in detail.tags" :key="tag" variant="outline" class="font-normal">{{ tag }}</Badge>
                    </dd>
                  </div>
                  <div v-if="detail.relations.length">
                    <dt class="text-muted-foreground mb-1 text-xs font-medium">{{ t('templates.fields.relations') }}</dt>
                    <dd v-for="(r, i) in detail.relations" :key="i" class="font-mono text-xs">{{ r.type }} → {{ r.target }}</dd>
                  </div>
                  <div v-if="detail.meta.aiInstructions">
                    <dt class="text-muted-foreground mb-1 text-xs font-medium">{{ t('templates.fields.aiInstructions') }}</dt>
                    <dd class="text-xs whitespace-pre-line">{{ detail.meta.aiInstructions }}</dd>
                  </div>
                </dl>
              </div>
            </template>

            <TemplateHistory v-else :template="selected" />
          </div>
        </template>
      </template>
    </div>

    <AlertDialog v-model:open="confirmReset">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('templates.settings.resetTitle', { name: selected?.name ?? '' }) }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t('templates.settings.resetBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="reset">{{ t('templates.settings.reset') }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

<style scoped>
.kn-tpl-rail-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: calc(var(--radius) - 2px);
  padding: 0.375rem 0.5rem;
  font-size: var(--kn-text-sm);
  transition: background-color 120ms;
}
.kn-tpl-rail-row:hover {
  background: var(--accent);
}
.kn-tpl-rail-row[data-selected] {
  background: color-mix(in oklab, var(--primary) 10%, transparent);
  color: var(--primary);
  font-weight: 500;
}
.kn-tpl-rail-row[data-muted]:not([data-selected]) {
  color: var(--muted-foreground);
}
.kn-tpl-preview :deep(h1) {
  font-size: 1.375rem;
}
</style>
