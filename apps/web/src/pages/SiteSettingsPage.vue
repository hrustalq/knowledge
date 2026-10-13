<script setup lang="ts">
/**
 * /settings/projects/:id/site (docs/features/44, issue #77 phase 2a): a
 * project's published site — its address, root page, look and versions.
 *
 * Reading it is open to anyone who can read the project; every control is an
 * admin's, as the routes behind it are. While the workspace switch (or the
 * deployment's PUBLIC_SITES_ENABLED ceiling) is off, the page says so instead
 * of offering buttons that would 403.
 *
 * Builds run in the worker, so a version shows `building` for a moment after
 * any change; the query polls while one does, and stops when none is.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { ExternalLink, Plus, RefreshCw, Trash2, X } from 'lucide-vue-next'
import {
  SITE_FONTS,
  SITE_THEME_LIMITS,
  isHexColor,
  isValidSiteSlug,
  type DocumentTreeNode,
  type DocumentTreeResponse,
  type ProjectSiteResponse,
  type PublishedSiteSummary,
  type SiteFont,
  type SiteHeaderLink,
  type SiteVersionKind,
  type SiteVersionSummary,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { getWorkspaceId, relativeTime } from '@/lib/api'
import { useTheme } from '@/lib/theme'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageState } from '@/components/layout/page'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()
const queryClient = useQueryClient()

const projectId = computed(() => route.params.id as string)
const project = computed(() => projects.items.find((p) => p.projectId === projectId.value) ?? null)
const canManage = computed(() => auth.canAdminWorkspace)

const siteOptions = computed(() => apiQueryOptions('/v1/projects/{id}/site', { path: { id: projectId.value } }))
const siteQuery = useQuery(
  computed(() => ({
    ...siteOptions.value,
    // Poll only while a build is running; a settled page asks nothing.
    refetchInterval: (q: { state: { data?: unknown } }) =>
      (q.state.data as ProjectSiteResponse | undefined)?.site?.versions.some((v) => v.status === 'building') ? 2000 : false,
  })),
)
const data = computed(() => siteQuery.data.value as ProjectSiteResponse | undefined)
const site = computed(() => data.value?.site ?? null)
const policy = computed(() => data.value?.policy ?? null)

function setSite(next: PublishedSiteSummary | null) {
  queryClient.setQueryData(siteOptions.value.queryKey, { ...data.value!, site: next })
}
const refetch = () => queryClient.invalidateQueries({ queryKey: siteOptions.value.queryKey })

/** The project's pages, flattened in tree order, for the root-page picker. */
const treeQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/documents/tree', { query: { workspaceId: getWorkspaceId(), projectId: projectId.value } }),
    enabled: canManage.value,
  })),
)
const pageOptions = computed(() => {
  const roots = (treeQuery.data.value as DocumentTreeResponse | undefined)?.roots ?? []
  const out: { id: string; label: string }[] = []
  const walk = (nodes: DocumentTreeNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ id: n.documentId, label: `${' '.repeat(depth)}${n.title}` })
      walk(n.children, depth + 1)
    }
  }
  walk(roots, 0)
  return out
})
const WHOLE_PROJECT = '__whole__'
// Format examples, not copy: the same in every language.
const HEX_EXAMPLE = '#4f46e5'
const URL_EXAMPLE = 'https://'
const VERSION_EXAMPLE = 'v1.0'

function previewUrl(slug: string): string {
  const base = policy.value?.baseDomain
  if (base) return `${slug || '…'}.${base}`
  return `${typeof window === 'undefined' ? '' : window.location.origin}/pub/${slug || '…'}`
}

// ---------------------------------------------------------------- tabs
// Hand-rolled (CLAUDE.md); `?tab=` opens one, it is not two-way state.
const TABS = ['general', 'theme', 'versions'] as const
type Tab = (typeof TABS)[number]
const tab = ref<Tab>(TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'general')

// ---------------------------------------------------------------- create
const createForm = reactive({ slug: '', root: WHOLE_PROJECT })
watch(
  policy,
  (p) => {
    if (p && !createForm.slug) createForm.slug = p.suggestedSlug
  },
  { immediate: true },
)
const creating = ref(false)
async function createSite() {
  if (creating.value || !isValidSiteSlug(createForm.slug)) return
  creating.value = true
  try {
    const created = (await api.post('/v1/projects/{id}/site', {
      path: { id: projectId.value },
      body: { slug: createForm.slug, rootDocumentId: createForm.root === WHOLE_PROJECT ? null : createForm.root },
    })) as PublishedSiteSummary
    setSite(created)
    toast.success(t('site.created'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    creating.value = false
  }
}

// ---------------------------------------------------------------- general
const general = reactive({ slug: '', root: WHOLE_PROJECT, seoIndexable: true })
watch(
  site,
  (s) => {
    if (!s) return
    general.slug = s.slug
    general.root = s.rootDocumentId ?? WHOLE_PROJECT
    general.seoIndexable = s.seoIndexable
  },
  { immediate: true },
)
const generalDirty = computed(
  () =>
    !!site.value &&
    (general.slug !== site.value.slug ||
      (general.root === WHOLE_PROJECT ? null : general.root) !== site.value.rootDocumentId ||
      general.seoIndexable !== site.value.seoIndexable),
)
const busy = ref(false)
async function patchSite(body: Record<string, unknown>, success: string) {
  if (!site.value || busy.value) return
  busy.value = true
  try {
    const next = (await api.patch('/v1/sites/{id}', { path: { id: site.value.id }, body })) as PublishedSiteSummary
    setSite(next)
    toast.success(t(success))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = false
  }
}
function saveGeneral() {
  if (!site.value) return
  const body: Record<string, unknown> = {}
  if (general.slug !== site.value.slug) body.slug = general.slug
  const root = general.root === WHOLE_PROJECT ? null : general.root
  if (root !== site.value.rootDocumentId) body.rootDocumentId = root
  if (general.seoIndexable !== site.value.seoIndexable) body.seoIndexable = general.seoIndexable
  void patchSite(body, 'site.saved')
}

async function setLive(live: boolean) {
  if (!site.value || busy.value) return
  busy.value = true
  try {
    const next = (await (live
      ? api.post('/v1/sites/{id}/publish', { path: { id: site.value.id } })
      : api.post('/v1/sites/{id}/unpublish', { path: { id: site.value.id } }))) as PublishedSiteSummary
    setSite(next)
    toast.success(t(live ? 'site.publishedToast' : 'site.unpublishedToast'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = false
  }
}

// An inline second step rather than a browser confirm(): deleting frees the
// address for anyone, and there is no undo.
const confirmingDelete = ref(false)
async function deleteSite() {
  if (!site.value || busy.value) return
  busy.value = true
  try {
    await api.delete('/v1/sites/{id}', { path: { id: site.value.id } })
    setSite(null)
    confirmingDelete.value = false
    toast.success(t('site.deleted'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    busy.value = false
  }
}

// ---------------------------------------------------------------- theme
const theme = reactive({
  primaryColor: '',
  primaryColorDark: '',
  font: 'system' as SiteFont,
  showLogo: true,
  headerLinks: [] as SiteHeaderLink[],
  footerText: '',
})
function resetTheme() {
  const th = site.value?.theme
  if (!th) return
  theme.primaryColor = th.primaryColor ?? ''
  theme.primaryColorDark = th.primaryColorDark ?? ''
  theme.font = th.font
  theme.showLogo = th.showLogo
  theme.headerLinks = th.headerLinks.map((l) => ({ ...l }))
  theme.footerText = th.footerText ?? ''
}
watch(site, resetTheme, { immediate: true })
const colourError = (v: string) => v !== '' && !isHexColor(v)
// The swatch shows the colour the reader would see in the mode the app is in.
const { isDark } = useTheme()
const previewColour = computed(() => {
  const dark = isHexColor(theme.primaryColorDark) ? theme.primaryColorDark : null
  const light = isHexColor(theme.primaryColor) ? theme.primaryColor : null
  return isDark.value ? (dark ?? light) : light
})
const themeValid = computed(
  () =>
    !colourError(theme.primaryColor) &&
    !colourError(theme.primaryColorDark) &&
    theme.headerLinks.every((l) => l.label.trim() && /^https?:\/\/\S+$/.test(l.url)),
)
function saveTheme() {
  if (!themeValid.value) return
  void patchSite(
    {
      theme: {
        primaryColor: theme.primaryColor || null,
        primaryColorDark: theme.primaryColorDark || null,
        font: theme.font,
        showLogo: theme.showLogo,
        headerLinks: theme.headerLinks.map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
        footerText: theme.footerText.trim() || null,
      },
    },
    'site.saved',
  )
}

// ---------------------------------------------------------------- versions
const versionForm = reactive({ name: '', slug: '', kind: 'frozen' as SiteVersionKind, sourceBranch: '' })
const addingVersion = ref(false)
async function addVersion() {
  if (!site.value || !versionForm.name.trim() || addingVersion.value) return
  addingVersion.value = true
  try {
    await api.post('/v1/sites/{id}/versions', {
      path: { id: site.value.id },
      body: {
        name: versionForm.name.trim(),
        ...(versionForm.slug.trim() ? { slug: versionForm.slug.trim() } : {}),
        kind: versionForm.kind,
        sourceBranch: versionForm.sourceBranch.trim() || null,
      },
    })
    Object.assign(versionForm, { name: '', slug: '', sourceBranch: '' })
    toast.success(t('site.versionCreated'))
    await refetch()
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    addingVersion.value = false
  }
}
async function versionAction(v: SiteVersionSummary, action: 'rebuild' | 'default' | 'delete' | 'freeze' | 'unfreeze') {
  if (!site.value) return
  try {
    if (action === 'rebuild') await api.post('/v1/site-versions/{id}/rebuild', { path: { id: v.id } })
    else if (action === 'delete') await api.delete('/v1/site-versions/{id}', { path: { id: v.id } })
    else if (action === 'default') await api.patch('/v1/sites/{id}', { path: { id: site.value.id }, body: { defaultVersionId: v.id } })
    else await api.patch('/v1/site-versions/{id}', { path: { id: v.id }, body: { kind: action === 'freeze' ? 'frozen' : 'live' } })
    await refetch()
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}
const openWarnings = ref<string | null>(null)

function statusVariant(status: string): 'default' | 'secondary' | 'outline' {
  return status === 'live' ? 'default' : status === 'draft' ? 'outline' : 'secondary'
}
const backToProject = () => router.push(`/settings/projects/${projectId.value}`)
</script>

<template>
  <div class="flex w-full min-w-0 flex-col gap-6">
    <div>
      <button type="button" class="text-xs text-muted-foreground hover:text-foreground" @click="backToProject">
        ← {{ project?.name ?? t('nav.settings') }}
      </button>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('site.title') }}</h1>
      <p class="mt-0.5 text-sm text-muted-foreground">{{ t('site.subtitle') }}</p>
    </div>

    <PageState v-if="siteQuery.isPending.value" state="loading" :rows="3" row-class="h-12" />
    <PageState v-else-if="siteQuery.isError.value" state="error" :error="siteQuery.error.value" />

    <template v-else-if="data && policy">
      <p
        v-if="!policy.ceiling"
        class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
      >
        {{ t('site.ceilingOff') }}
      </p>
      <p
        v-else-if="!policy.enabled"
        class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
      >
        {{ t('site.disabled') }}
        <RouterLink v-if="canManage" to="/settings/publishing" class="font-medium underline">{{ t('site.openPublishing') }}</RouterLink>
      </p>

      <!-- No site yet -->
      <template v-if="!site">
        <p v-if="!canManage" class="text-sm text-muted-foreground">{{ t('site.noneReadOnly') }}</p>
        <form v-else class="max-w-xl space-y-4 rounded-xl border p-5" @submit.prevent="createSite">
          <p class="text-sm text-muted-foreground">{{ t('site.createIntro') }}</p>
          <label class="block space-y-1">
            <span class="text-xs font-medium text-muted-foreground">{{ t('site.slug') }}</span>
            <Input v-model="createForm.slug" autocomplete="off" spellcheck="false" />
            <span class="block text-xs text-muted-foreground">{{ previewUrl(createForm.slug) }}</span>
            <span v-if="createForm.slug && !isValidSiteSlug(createForm.slug)" class="block text-xs text-destructive">
              {{ t('site.slugHint') }}
            </span>
          </label>
          <div class="space-y-1">
            <span class="text-xs font-medium text-muted-foreground">{{ t('site.root') }}</span>
            <Select v-model="createForm.root">
              <SelectTrigger class="h-9 w-full" :aria-label="t('site.root')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="WHOLE_PROJECT">{{ t('site.wholeProject') }}</SelectItem>
                <SelectItem v-for="o in pageOptions" :key="o.id" :value="o.id">{{ o.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" size="sm" :disabled="creating || !policy.enabled || !isValidSiteSlug(createForm.slug)">
            {{ creating ? t('common.saving') : t('site.create') }}
          </Button>
        </form>
      </template>

      <!-- The site -->
      <template v-else>
        <div class="flex flex-wrap items-center gap-3 rounded-xl border p-4">
          <Badge :variant="statusVariant(site.status)">{{ t(`site.status.${site.status}`) }}</Badge>
          <a
            v-if="site.status === 'live'"
            :href="site.url"
            target="_blank"
            rel="noopener"
            class="inline-flex min-w-0 items-center gap-1 truncate text-sm text-primary hover:underline"
          >{{ site.url }}<ExternalLink class="size-3 shrink-0" aria-hidden="true" /></a>
          <span v-else class="min-w-0 truncate text-sm text-muted-foreground">{{ site.url }}</span>
          <span class="flex-1" />
          <template v-if="canManage">
            <Button
              v-if="site.status !== 'live'"
              size="sm"
              :disabled="busy || !policy.enabled"
              @click="setLive(true)"
            >
              {{ t('site.publish') }}
            </Button>
            <Button v-else size="sm" variant="outline" :disabled="busy" @click="setLive(false)">{{ t('site.unpublish') }}</Button>
          </template>
        </div>

        <div class="flex gap-1 border-b" role="tablist">
          <button
            v-for="id in TABS"
            :key="id"
            type="button"
            role="tab"
            :aria-selected="tab === id"
            class="-mb-px border-b-2 px-3 py-2 text-sm"
            :class="tab === id ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
            @click="tab = id"
          >
            {{ t(`site.tab.${id}`) }}
          </button>
        </div>

        <!-- General -->
        <form v-if="tab === 'general'" class="max-w-xl space-y-4" @submit.prevent="saveGeneral">
          <label class="block space-y-1">
            <span class="text-xs font-medium text-muted-foreground">{{ t('site.slug') }}</span>
            <Input v-model="general.slug" :disabled="!canManage" autocomplete="off" spellcheck="false" />
            <span class="block text-xs text-muted-foreground">{{ t('site.slugChangeHint') }}</span>
          </label>
          <div class="space-y-1">
            <span class="text-xs font-medium text-muted-foreground">{{ t('site.root') }}</span>
            <Select v-model="general.root" :disabled="!canManage">
              <SelectTrigger class="h-9 w-full" :aria-label="t('site.root')"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="WHOLE_PROJECT">{{ t('site.wholeProject') }}</SelectItem>
                <SelectItem
                  v-if="site.rootDocumentId && !pageOptions.some((o) => o.id === site!.rootDocumentId)"
                  :value="site.rootDocumentId"
                >
                  {{ site.rootDocumentTitle ?? site.rootDocumentId }}
                </SelectItem>
                <SelectItem v-for="o in pageOptions" :key="o.id" :value="o.id">{{ o.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label class="flex items-start gap-2 text-sm">
            <input v-model="general.seoIndexable" type="checkbox" class="mt-0.5" :disabled="!canManage">
            <span>
              {{ t('site.seoIndexable') }}
              <span class="block text-xs text-muted-foreground">{{ t('site.seoIndexableHint') }}</span>
            </span>
          </label>
          <Button v-if="canManage" type="submit" size="sm" :disabled="!generalDirty || busy">{{ t('common.save') }}</Button>

          <div v-if="canManage" class="mt-8 space-y-2 border-t pt-4">
            <p class="text-sm font-medium">{{ t('site.deleteTitle') }}</p>
            <p class="text-xs text-muted-foreground">{{ t('site.deleteHint') }}</p>
            <div class="flex gap-2">
              <Button v-if="!confirmingDelete" type="button" size="sm" variant="outline" class="text-destructive" @click="confirmingDelete = true">
                {{ t('site.delete') }}
              </Button>
              <template v-else>
                <Button type="button" size="sm" variant="destructive" :disabled="busy" @click="deleteSite">{{ t('site.deleteConfirm') }}</Button>
                <Button type="button" size="sm" variant="ghost" @click="confirmingDelete = false">{{ t('common.cancel') }}</Button>
              </template>
            </div>
          </div>
        </form>

        <!-- Theme -->
        <form v-else-if="tab === 'theme'" class="grid max-w-3xl gap-6 md:grid-cols-[1fr_16rem]" @submit.prevent="saveTheme">
          <div class="space-y-4">
            <div class="grid gap-4 sm:grid-cols-2">
              <label v-for="key in (['primaryColor', 'primaryColorDark'] as const)" :key="key" class="block space-y-1">
                <span class="text-xs font-medium text-muted-foreground">{{ t(`site.theme.${key}`) }}</span>
                <div class="flex items-center gap-2">
                  <input
                    type="color"
                    class="h-9 w-10 shrink-0 cursor-pointer rounded border bg-transparent"
                    :value="isHexColor(theme[key]) ? theme[key] : HEX_EXAMPLE"
                    :disabled="!canManage"
                    :aria-label="t(`site.theme.${key}`)"
                    @input="theme[key] = ($event.target as HTMLInputElement).value"
                  >
                  <Input v-model="theme[key]" :placeholder="HEX_EXAMPLE" :disabled="!canManage" spellcheck="false" />
                </div>
                <span v-if="colourError(theme[key])" class="block text-xs text-destructive">{{ t('site.theme.colourHint') }}</span>
              </label>
            </div>
            <div class="space-y-1">
              <span class="text-xs font-medium text-muted-foreground">{{ t('site.theme.font') }}</span>
              <Select v-model="theme.font" :disabled="!canManage">
                <SelectTrigger class="h-9 w-full" :aria-label="t('site.theme.font')"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="f in SITE_FONTS" :key="f" :value="f">{{ t(`site.theme.fonts.${f}`) }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label class="flex items-center gap-2 text-sm">
              <input v-model="theme.showLogo" type="checkbox" :disabled="!canManage">
              {{ t('site.theme.showLogo') }}
            </label>

            <div class="space-y-2">
              <span class="text-xs font-medium text-muted-foreground">{{ t('site.theme.headerLinks') }}</span>
              <div v-for="(link, i) in theme.headerLinks" :key="i" class="flex gap-2">
                <Input v-model="link.label" :placeholder="t('site.theme.linkLabel')" :maxlength="SITE_THEME_LIMITS.linkLabel" class="w-40" :disabled="!canManage" />
                <Input v-model="link.url" :placeholder="URL_EXAMPLE" :disabled="!canManage" />
                <Button v-if="canManage" type="button" size="icon" variant="ghost" :aria-label="t('common.remove')" @click="theme.headerLinks.splice(i, 1)">
                  <X class="size-4" />
                </Button>
              </div>
              <Button
                v-if="canManage && theme.headerLinks.length < SITE_THEME_LIMITS.headerLinks"
                type="button"
                size="sm"
                variant="outline"
                @click="theme.headerLinks.push({ label: '', url: '' })"
              >
                <Plus class="size-4" />{{ t('site.theme.addLink') }}
              </Button>
            </div>

            <label class="block space-y-1">
              <span class="text-xs font-medium text-muted-foreground">{{ t('site.theme.footer') }}</span>
              <Textarea v-model="theme.footerText" :maxlength="SITE_THEME_LIMITS.footerText" rows="2" :disabled="!canManage" />
            </label>

            <div v-if="canManage" class="flex gap-2">
              <Button type="submit" size="sm" :disabled="busy || !themeValid">{{ t('common.save') }}</Button>
              <Button type="button" size="sm" variant="ghost" @click="resetTheme">{{ t('site.theme.reset') }}</Button>
            </div>
          </div>

          <!-- A swatch of what the colours do on the site: the primary drives
               links, the current page in the nav and focus rings. -->
          <div class="h-fit space-y-2 rounded-xl border p-4 text-sm" :style="previewColour ? { '--primary': previewColour } : undefined">
            <p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">{{ t('site.theme.preview') }}</p>
            <p class="rounded-md bg-primary/10 px-2 py-1 font-medium text-primary">{{ t('site.theme.previewCurrent') }}</p>
            <p class="px-2 text-foreground/80">{{ t('site.theme.previewOther') }}</p>
            <p class="px-2"><a class="text-primary underline" href="#" @click.prevent>{{ t('site.theme.previewLink') }}</a></p>
          </div>
        </form>

        <!-- Versions -->
        <div v-else class="space-y-6">
          <p class="max-w-2xl text-sm text-muted-foreground">{{ t('site.versionsIntro') }}</p>
          <div class="overflow-x-auto rounded-md border">
            <table class="w-full text-sm">
              <thead class="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th class="px-3 py-2 font-medium">{{ t('site.col.version') }}</th>
                  <th class="px-3 py-2 font-medium">{{ t('site.col.source') }}</th>
                  <th class="px-3 py-2 font-medium">{{ t('site.col.build') }}</th>
                  <th class="px-3 py-2" />
                </tr>
              </thead>
              <tbody class="divide-y">
                <template v-for="v in site.versions" :key="v.id">
                  <tr>
                    <td class="px-3 py-2">
                      <div class="flex flex-wrap items-center gap-1.5">
                        <span class="font-medium">{{ v.name }}</span>
                        <Badge v-if="v.isDefault" variant="secondary">{{ t('site.default') }}</Badge>
                        <Badge variant="outline">{{ t(`site.kind.${v.kind}`) }}</Badge>
                      </div>
                      <span class="text-xs text-muted-foreground">/{{ v.isDefault ? '' : v.slug }}</span>
                    </td>
                    <td class="px-3 py-2 text-muted-foreground">{{ v.sourceBranch ?? t('site.defaultBranches') }}</td>
                    <td class="px-3 py-2">
                      <span v-if="v.status === 'building'" class="inline-flex items-center gap-1 text-muted-foreground">
                        <RefreshCw class="size-3 animate-spin" aria-hidden="true" />{{ t('site.building') }}
                      </span>
                      <span v-else-if="v.status === 'failed'" class="text-destructive" :title="v.error ?? ''">{{ t('site.failed') }}</span>
                      <span v-else class="text-muted-foreground">
                        {{ t('site.builtSummary', { n: v.pageCount, when: v.builtAt ? relativeTime(v.builtAt) : '—' }) }}
                      </span>
                      <button
                        v-if="v.warnings.length"
                        type="button"
                        class="ml-2 text-xs text-amber-700 underline dark:text-amber-300"
                        @click="openWarnings = openWarnings === v.id ? null : v.id"
                      >
                        {{ t('site.warnings', { n: v.warnings.length }, v.warnings.length) }}
                      </button>
                    </td>
                    <td class="px-3 py-2 text-right whitespace-nowrap">
                      <template v-if="canManage">
                        <Button size="sm" variant="ghost" class="h-7" :disabled="v.status === 'building'" @click="versionAction(v, 'rebuild')">
                          {{ t('site.rebuild') }}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          class="h-7"
                          @click="versionAction(v, v.kind === 'live' ? 'freeze' : 'unfreeze')"
                        >
                          {{ t(v.kind === 'live' ? 'site.freeze' : 'site.unfreeze') }}
                        </Button>
                        <Button v-if="!v.isDefault && v.builtAt" size="sm" variant="ghost" class="h-7" @click="versionAction(v, 'default')">
                          {{ t('site.makeDefault') }}
                        </Button>
                        <Button
                          v-if="!v.isDefault"
                          size="icon"
                          variant="ghost"
                          class="size-7 text-destructive hover:text-destructive"
                          :aria-label="t('common.delete')"
                          @click="versionAction(v, 'delete')"
                        >
                          <Trash2 class="size-4" />
                        </Button>
                      </template>
                    </td>
                  </tr>
                  <tr v-if="openWarnings === v.id">
                    <td colspan="4" class="bg-muted/30 px-3 py-2">
                      <ul class="space-y-1 text-xs">
                        <li v-for="(w, i) in v.warnings" :key="i">
                          <RouterLink v-if="w.documentId" :to="`/documents/${w.documentId}`" class="font-medium hover:underline">{{ w.title }}</RouterLink>
                          — {{ t(`site.warning.${w.code}`) }}
                        </li>
                      </ul>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>

          <form v-if="canManage" class="max-w-3xl space-y-3 rounded-xl border p-4" @submit.prevent="addVersion">
            <p class="text-sm font-medium">{{ t('site.addVersion') }}</p>
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="block space-y-1">
                <span class="text-xs font-medium text-muted-foreground">{{ t('site.versionName') }}</span>
                <Input v-model="versionForm.name" :placeholder="VERSION_EXAMPLE" maxlength="60" />
              </label>
              <label class="block space-y-1">
                <span class="text-xs font-medium text-muted-foreground">{{ t('site.versionSlug') }}</span>
                <Input v-model="versionForm.slug" :placeholder="t('site.versionSlugAuto')" maxlength="32" spellcheck="false" />
              </label>
              <div class="space-y-1">
                <span class="text-xs font-medium text-muted-foreground">{{ t('site.versionKind') }}</span>
                <Select v-model="versionForm.kind">
                  <SelectTrigger class="h-9 w-full" :aria-label="t('site.versionKind')"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="frozen">{{ t('site.kind.frozen') }} — {{ t('site.kindHint.frozen') }}</SelectItem>
                    <SelectItem value="live">{{ t('site.kind.live') }} — {{ t('site.kindHint.live') }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <label class="block space-y-1">
                <span class="text-xs font-medium text-muted-foreground">{{ t('site.sourceBranch') }}</span>
                <Input v-model="versionForm.sourceBranch" :placeholder="t('site.defaultBranches')" maxlength="100" spellcheck="false" />
              </label>
            </div>
            <p class="text-xs text-muted-foreground">{{ t('site.sourceBranchHint') }}</p>
            <Button type="submit" size="sm" :disabled="addingVersion || !versionForm.name.trim()">{{ t('site.addVersion') }}</Button>
          </form>
        </div>
      </template>
    </template>
  </div>
</template>
