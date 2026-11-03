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
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Eye, EyeOff, FolderTree, LayoutTemplate, Power, PowerOff, RotateCcw, Search, Trash2, WandSparkles } from 'lucide-vue-next'
import { blueprintText, SUPPORTED_LOCALES, type BlueprintEntry, type BuiltInBlueprintKey, type Locale } from '@knowledge/contracts'
import { api } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { errorMessage } from '@/shared/api/errors'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Skeleton } from '@/shared/ui/skeleton'
import { confirm } from '@/shared/ui/confirm'
import BlueprintTreePreview from '@/modules/projects/components/BlueprintTreePreview.vue'
import { countPages } from '@/modules/projects/model/blueprint-tree'

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
</script>

<template>
  <!-- Bleed out of the settings column's padding so the rail sits flush, as /settings/templates does. -->
  <div class="-mx-4 -my-6 flex min-h-0 flex-1 flex-col lg:-mx-8 lg:flex-row">
    <h1 class="sr-only">{{ t('nav.blueprints') }}</h1>
    <div
      class="flex h-80 shrink-0 flex-col border-b bg-background lg:sticky lg:top-0 lg:h-[calc(100vh-5.75rem)] lg:w-72 lg:self-start lg:border-r lg:border-b-0"
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

    <div data-kn-pane="3" class="flex min-h-0 min-w-0 flex-1 flex-col px-4 py-6 lg:px-8">
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

        <div class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_18rem]">
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
