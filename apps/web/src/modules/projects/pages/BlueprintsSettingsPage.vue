<script setup lang="ts">
/**
 * /settings/blueprints (#716): every blueprint a project here can start from,
 * including the built-ins this workspace hid and the saved ones switched off —
 * this is where they come back.
 *
 * The template model, read the same way: built-ins are code, a row customises
 * or hides one, saved ones are rows. The pane shows a blueprint's tree and
 * conventions and is where it is hidden, reset, switched off or deleted. Its
 * content changes in the wizard (Open in wizard → Save as blueprint), the one
 * blueprint editor. Editors read; writes are admin, as the routes are.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Bot, Eye, EyeOff, FolderTree, LayoutTemplate, Workflow, Power, PowerOff, RotateCcw, Search, Trash2, WandSparkles } from 'lucide-vue-next'
import { blueprintText, isMethodology, SUPPORTED_LOCALES, type BlueprintEntry, type BuiltInBlueprintKey, type Locale } from '@knowledge/contracts'
import { api } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { errorMessage } from '@/shared/api/errors'
import { useAuthStore } from '@/stores/auth'
import { useTemplatesStore } from '@/entities/template'
import { Badge } from '@knowledge/ui/badge'
import { Button } from '@knowledge/ui/button'
import { Input } from '@knowledge/ui/input'
import { Skeleton } from '@knowledge/ui/skeleton'
import { confirm } from '@knowledge/ui/confirm'
import BlueprintTreePreview from '@/modules/projects/components/BlueprintTreePreview.vue'
import { countPages } from '@/modules/projects/model/blueprint-tree'
import { revealStackedPane } from '@/shared/utils/reveal-pane'

const { t, locale: uiLocale } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const lang = computed<Locale>(() => (SUPPORTED_LOCALES.includes(uiLocale.value as Locale) ? (uiLocale.value as Locale) : 'en'))

const entries = ref<BlueprintEntry[] | null>(null)
const loadError = ref<string | null>(null)
async function load() {
  loadError.value = null
  try {
    entries.value = (await api.get('/v1/blueprints', { query: { workspaceId: getWorkspaceId(), includeDisabled: true } })).blueprints
  } catch (e) {
    loadError.value = errorMessage(e, t)
  }
}
// On mount, not in setup: setup also runs in the SSR pass.
onMounted(load)

const nameOf = (e: BlueprintEntry) => blueprintText(e.blueprint.name, lang.value)
const customised = (e: BlueprintEntry) => e.builtIn && e.version > 0

const query = ref('')
const groups = computed(() => {
  const q = query.value.trim().toLocaleLowerCase()
  const shown = (entries.value ?? []).filter((e) => !q || nameOf(e).toLocaleLowerCase().includes(q))
  return [
    { key: 'builtIn', label: t('blueprints.groups.builtIn'), items: shown.filter((e) => e.builtIn) },
    { key: 'saved', label: t('blueprints.groups.saved'), items: shown.filter((e) => !e.builtIn) },
  ].filter((g) => g.items.length)
})

const routeKey = computed(() => (typeof route.params.key === 'string' && route.params.key ? route.params.key : null))
const selected = computed(() => (routeKey.value ? (entries.value?.find((e) => e.key === routeKey.value) ?? null) : null))
const conventions = computed(() => selected.value?.blueprint.conventions ?? {})
const pages = computed(() => countPages(selected.value?.blueprint.tree ?? []))

// A methodology's own parts (#1266): its levels, agents and workflows, read-only like the rest of the pane.
const method = computed(() => (selected.value && isMethodology(selected.value.blueprint) ? selected.value.blueprint : null))
const templates = useTemplatesStore()
watch(method, (m) => {
  if (m?.levels?.length) void templates.ensureLoaded()
})
const templatesOf = (refs: readonly string[]) => refs.map((ref) => templates.byRef(ref)?.name ?? ref).join(' · ')
/** A level names one of the methodology's agents or a built-in one, which keeps its key. */
const agentOf = (key: string) => {
  const agent = method.value?.agents?.find((a) => a.key === key)
  const name = agent?.name ?? key
  return agent?.minTier ? `${name} · ${t('ai.agents.minTier', { tier: t(`ai.models.tier.${agent.minTier}`) })}` : name
}

const busy = ref(false)
async function act(run: () => Promise<unknown>, done: string) {
  busy.value = true
  try {
    await run()
    await load()
    toast.success(done)
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = false
  }
}

/** A built-in is hidden by a row with `enabled: false`; a saved one is switched off the same way. */
function setEnabled(entry: BlueprintEntry, enabled: boolean) {
  const name = nameOf(entry)
  const done = entry.builtIn
    ? t(enabled ? 'blueprints.settings.shownToast' : 'blueprints.settings.hiddenToast', { name })
    : t(enabled ? 'blueprints.settings.onToast' : 'blueprints.settings.offToast', { name })
  const { id, key } = entry
  void act(
    () =>
      id
        ? api.patch('/v1/blueprints/{id}', { path: { id }, body: { enabled } })
        : // No row yet = an untouched built-in, so the key is a built-in key.
          api.post('/v1/blueprints', { body: { workspaceId: getWorkspaceId(), builtInKey: key as BuiltInBlueprintKey, enabled } }),
    done,
  )
}

async function remove(entry: BlueprintEntry) {
  const id = entry.id
  if (!id) return
  const name = nameOf(entry)
  const ok = await confirm(
    entry.builtIn
      ? { title: t('blueprints.settings.resetTitle', { name }), description: t('blueprints.settings.resetBody'), action: t('blueprints.settings.reset') }
      : { title: t('blueprints.settings.deleteTitle', { name }), description: t('blueprints.settings.deleteBody'), action: t('common.delete'), destructive: true },
  )
  if (!ok) return
  await act(
    () => api.delete('/v1/blueprints/{id}', { path: { id } }),
    entry.builtIn ? t('blueprints.settings.resetToast', { name }) : t('blueprints.settings.deletedToast', { name }),
  )
  if (!entry.builtIn) void router.replace('/settings/blueprints')
}

const wizardLink = (e: BlueprintEntry) => `/projects/new?blueprint=${encodeURIComponent(e.key)}`
/** #1071: below xl (#1046) the rail stacks above the detail, so a pick would otherwise change nothing on screen. */
const detailEl = ref<HTMLElement | null>(null)
watch(
  () => routeKey.value,
  (key) => {
    if (key) void nextTick(() => revealStackedPane(detailEl.value))
  },
)
</script>

<template>
  <!-- Bleed out of the settings column's padding so the rail sits flush, as /settings/templates does. -->
  <div class="-mx-4 -my-6 flex min-h-0 flex-1 flex-col lg:-mx-8 xl:flex-row">
    <h1 class="sr-only">{{ t('nav.blueprints') }}</h1>
    <!-- #1071: cap the stacked rail (below xl, #1046) so the detail stays in view -->
    <div
      class="flex max-h-[40dvh] shrink-0 flex-col border-b bg-background xl:sticky xl:top-0 xl:max-h-none xl:h-[calc(100vh-5.75rem)] xl:w-72 xl:self-start xl:border-r xl:border-b-0"
    >
      <div class="border-b p-2">
        <div class="relative">
          <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
          <Input v-model="query" class="h-8 pl-7" :placeholder="t('blueprints.search')" :aria-label="t('blueprints.search')" />
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <template v-if="!entries && !loadError">
          <Skeleton v-for="i in 5" :key="i" class="mx-1 my-2 h-6" />
        </template>
        <template v-for="group in groups" v-else :key="group.key">
          <p class="text-muted-foreground px-2 pt-3 pb-1 text-caption font-semibold tracking-wider uppercase">{{ group.label }}</p>
          <RouterLink
            v-for="entry in group.items"
            :key="entry.key"
            :to="`/settings/blueprints/${encodeURIComponent(entry.key)}`"
            class="kn-bp-rail-row"
            :data-selected="selected?.key === entry.key || undefined"
            :data-muted="!entry.enabled || undefined"
          >
            <span v-if="entry.blueprint.icon" class="w-4 shrink-0 text-center text-sm leading-none" aria-hidden="true">{{ entry.blueprint.icon }}</span>
            <FolderTree v-else class="text-muted-foreground size-4 shrink-0" />
            <span class="min-w-0 flex-1 truncate">{{ nameOf(entry) }}</span>
            <span v-if="!entry.enabled" class="text-muted-foreground shrink-0 text-caption">
              {{ entry.builtIn ? t('blueprints.settings.hidden') : t('blueprints.settings.off') }}
            </span>
            <span v-else-if="customised(entry)" class="text-muted-foreground shrink-0 text-caption">{{ t('blueprints.settings.customised') }}</span>
          </RouterLink>
        </template>
        <p v-if="entries && !groups.length" class="text-muted-foreground px-2 py-6 text-center text-sm">
          {{ query.trim() ? t('common.noMatchFor', { query }) : t('blueprints.settings.none') }}
        </p>
      </div>

      <div v-if="auth.canEdit" class="mt-auto shrink-0 border-t p-2">
        <Button variant="outline" size="sm" class="w-full justify-start gap-2" as-child>
          <RouterLink to="/projects/new"><WandSparkles class="size-4" /> {{ t('blueprints.settings.new') }}</RouterLink>
        </Button>
      </div>
    </div>

    <div ref="detailEl" data-kn-pane="3" class="@container flex min-h-0 min-w-0 flex-1 flex-col px-4 py-6 lg:px-8">
      <div v-if="loadError" class="max-w-md rounded-xl border p-4 text-sm" role="alert">
        <p>{{ t('scaffold.start.loadFailed') }}</p>
        <p class="text-muted-foreground mt-1 text-xs">{{ loadError }}</p>
        <Button size="sm" variant="outline" class="mt-3" @click="load">{{ t('common.retry') }}</Button>
      </div>

      <div v-else-if="!selected" class="text-muted-foreground mx-auto my-16 max-w-sm space-y-2 text-center text-sm">
        <FolderTree class="mx-auto size-8 opacity-40" aria-hidden="true" />
        <p v-if="routeKey && entries">{{ t('blueprints.settings.notFound') }}</p>
        <p v-else>{{ t('blueprints.settings.pick') }}</p>
      </div>

      <template v-else>
        <header class="mb-6 space-y-2">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span v-if="selected.blueprint.icon" class="text-2xl leading-none" aria-hidden="true">{{ selected.blueprint.icon }}</span>
            <FolderTree v-else class="text-muted-foreground size-6" aria-hidden="true" />
            <h2 class="min-w-0 flex-1 basis-48 truncate text-lg font-semibold">{{ nameOf(selected) }}</h2>

            <div class="flex flex-wrap gap-1.5">
              <Button v-if="selected.enabled && auth.canEdit" variant="outline" size="sm" as-child>
                <RouterLink :to="wizardLink(selected)"><WandSparkles class="size-3.5" /> {{ t('blueprints.settings.open') }}</RouterLink>
              </Button>
              <template v-if="auth.canAdminWorkspace">
                <template v-if="selected.builtIn">
                  <Button v-if="selected.enabled" variant="ghost" size="sm" :disabled="busy" @click="setEnabled(selected, false)">
                    <EyeOff class="size-3.5" /> {{ t('blueprints.settings.hide') }}
                  </Button>
                  <Button v-else variant="ghost" size="sm" :disabled="busy" @click="setEnabled(selected, true)">
                    <Eye class="size-3.5" /> {{ t('blueprints.settings.show') }}
                  </Button>
                  <Button v-if="customised(selected)" variant="ghost" size="sm" :disabled="busy" @click="remove(selected)">
                    <RotateCcw class="size-3.5" /> {{ t('blueprints.settings.reset') }}
                  </Button>
                </template>
                <template v-else>
                  <Button v-if="selected.enabled" variant="ghost" size="sm" :disabled="busy" @click="setEnabled(selected, false)">
                    <PowerOff class="size-3.5" /> {{ t('blueprints.settings.switchOff') }}
                  </Button>
                  <Button v-else variant="ghost" size="sm" :disabled="busy" @click="setEnabled(selected, true)">
                    <Power class="size-3.5" /> {{ t('blueprints.settings.switchOn') }}
                  </Button>
                  <Button variant="ghost" size="sm" class="text-destructive" :disabled="busy" @click="remove(selected)">
                    <Trash2 class="size-3.5" /> {{ t('common.delete') }}
                  </Button>
                </template>
              </template>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{{ selected.builtIn ? t('blueprints.kind.builtIn') : t('blueprints.kind.saved') }}</Badge>
            <Badge variant="outline" class="tabular-nums">{{ t('scaffold.start.pages', { count: pages }, pages) }}</Badge>
            <Badge v-if="selected.version" variant="outline" class="font-mono">{{ t('templates.version', { version: selected.version }) }}</Badge>
            <Badge v-if="customised(selected)" variant="secondary">{{ t('blueprints.settings.customised') }}</Badge>
            <Badge v-if="!selected.enabled" variant="secondary">
              {{ selected.builtIn ? t('blueprints.settings.hidden') : t('blueprints.settings.off') }}
            </Badge>
          </div>
          <p v-if="selected.blueprint.description" class="kn-measure text-muted-foreground text-sm">
            {{ blueprintText(selected.blueprint.description, lang) }}
          </p>
          <p class="text-muted-foreground text-xs">
            {{ auth.canAdminWorkspace ? t('blueprints.settings.editHint') : t('blueprints.settings.adminOnly') }}
          </p>
        </header>

        <!-- Split by the pane's width, not the viewport's: three rails sit beside it (#1266). -->
        <div class="grid gap-8 @3xl:grid-cols-[minmax(0,1fr)_18rem]">
          <section class="min-w-0" aria-labelledby="kn-bp-tree">
            <h3 id="kn-bp-tree" class="text-muted-foreground mb-2 text-xs font-medium">{{ t('scaffold.shape.outline') }}</h3>
            <div class="rounded-md border px-4 py-3">
              <BlueprintTreePreview :tree="selected.blueprint.tree" :locale="lang" />
            </div>
          </section>

          <dl class="space-y-5 text-sm">
            <div>
              <dt class="text-muted-foreground mb-1 text-xs font-medium">{{ t('scaffold.conventions.styleguide') }}</dt>
              <dd v-if="!conventions.styleguide?.rules.length" class="text-muted-foreground text-xs">{{ t('blueprints.settings.noneSet') }}</dd>
              <dd v-for="rule in conventions.styleguide?.rules ?? []" :key="rule.id" class="py-0.5 text-xs leading-snug">{{ rule.text }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground mb-1 text-xs font-medium">{{ t('scaffold.conventions.templates') }}</dt>
              <dd v-if="!conventions.templates?.length" class="text-muted-foreground text-xs">{{ t('blueprints.settings.noneSet') }}</dd>
              <dd v-for="tpl in conventions.templates ?? []" :key="tpl.name" class="flex items-center gap-1.5 py-0.5 text-xs">
                <span v-if="tpl.icon" aria-hidden="true">{{ tpl.icon }}</span>
                <LayoutTemplate v-else class="text-muted-foreground size-3.5" aria-hidden="true" />
                {{ tpl.name }}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground mb-1 text-xs font-medium">{{ t('scaffold.conventions.glossary') }}</dt>
              <dd v-if="!conventions.glossary?.length" class="text-muted-foreground text-xs">{{ t('blueprints.settings.noneSet') }}</dd>
              <dd v-else class="text-xs leading-relaxed">{{ conventions.glossary.map((g) => g.term).join(' · ') }}</dd>
            </div>
          </dl>
        </div>

        <div v-if="method" class="mt-8 space-y-8">
          <section v-if="method.levels?.length" aria-labelledby="kn-bp-levels">
            <h3 id="kn-bp-levels" class="text-muted-foreground mb-2 text-xs font-medium">{{ t('blueprints.method.levels') }}</h3>
            <ol class="divide-y rounded-md border">
              <li v-for="level in method.levels" :key="level.key" class="space-y-1 px-4 py-3">
                <p class="text-sm">
                  <span class="font-medium">{{ blueprintText(level.name, lang) }}</span>
                  <span v-if="blueprintText(level.description, lang)" class="text-muted-foreground"> — {{ blueprintText(level.description, lang) }}</span>
                </p>
                <p class="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <span class="inline-flex min-w-0 items-center gap-1">
                    <LayoutTemplate class="size-3 shrink-0" aria-hidden="true" />
                    <span class="sr-only">{{ t('scaffold.conventions.templates') }}: </span>
                    {{ level.templateRefs.length ? templatesOf(level.templateRefs) : t('blueprints.method.noTemplates') }}
                  </span>
                  <span v-if="level.agentKey" class="inline-flex min-w-0 items-center gap-1">
                    <Bot class="size-3 shrink-0" aria-hidden="true" />
                    {{ t('chat.level.agent', { name: agentOf(level.agentKey) }) }}
                  </span>
                </p>
                <details v-if="blueprintText(level.guidance, lang)" class="text-xs">
                  <summary class="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit cursor-pointer rounded-sm outline-none focus-visible:ring-2">
                    {{ t('blueprints.method.guidance') }}
                  </summary>
                  <p class="kn-measure mt-1.5 leading-relaxed whitespace-pre-line">{{ blueprintText(level.guidance, lang) }}</p>
                </details>
              </li>
            </ol>
          </section>

          <div class="grid gap-8 @3xl:grid-cols-2">
            <section v-if="method.agents?.length" aria-labelledby="kn-bp-agents">
              <h3 id="kn-bp-agents" class="text-muted-foreground mb-2 text-xs font-medium">{{ t('blueprints.method.agents') }}</h3>
              <ul class="divide-y rounded-md border">
                <li v-for="agent in method.agents" :key="agent.key" class="space-y-0.5 px-4 py-2.5">
                  <p class="flex flex-wrap items-center gap-2 text-sm">
                    <Bot class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                    <span class="font-medium">{{ agent.name }}</span>
                    <Badge v-if="agent.minTier" variant="outline" class="font-normal">
                      {{ t('ai.agents.minTier', { tier: t(`ai.models.tier.${agent.minTier}`) }) }}
                    </Badge>
                  </p>
                  <p v-if="agent.description" class="text-muted-foreground text-xs">{{ agent.description }}</p>
                  <p class="text-muted-foreground text-xs tabular-nums">{{ t('blueprints.method.tools', { n: agent.tools?.length ?? 0 }, agent.tools?.length ?? 0) }}</p>
                </li>
              </ul>
            </section>

            <section v-if="method.workflows?.length" aria-labelledby="kn-bp-workflows">
              <h3 id="kn-bp-workflows" class="text-muted-foreground mb-2 text-xs font-medium">{{ t('blueprints.method.workflows') }}</h3>
              <ul class="divide-y rounded-md border">
                <li v-for="wf in method.workflows" :key="wf.name" class="space-y-0.5 px-4 py-2.5">
                  <p class="flex items-center gap-2 text-sm">
                    <Workflow class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                    <span class="font-medium">{{ wf.name }}</span>
                  </p>
                  <p v-if="wf.description" class="text-muted-foreground text-xs">{{ wf.description }}</p>
                </li>
              </ul>
            </section>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.kn-bp-rail-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: calc(var(--radius) - 2px);
  padding: 0.375rem 0.5rem;
  font-size: var(--kn-text-sm);
  transition: background-color 120ms;
}
.kn-bp-rail-row:hover {
  background: var(--accent);
}
.kn-bp-rail-row[data-selected] {
  background: color-mix(in oklab, var(--primary) 10%, transparent);
  color: var(--primary);
  font-weight: 500;
}
.kn-bp-rail-row[data-muted]:not([data-selected]) {
  color: var(--muted-foreground);
}
</style>
