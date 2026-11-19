<script setup lang="ts">
// The workspace home (#1243). One read (`GET /v1/workspaces/:id/home`, prefetched
// by entry-server so it renders with JS off) carries the layout and the data of
// every widget this caller may read. A workspace admin edits the layout in
// place: Customize turns each widget into a slot with show/hide and move
// controls, and Save writes the whole list.
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Settings2 } from 'lucide-vue-next'
import { HOME_WIDGETS, HOME_WIDGET_ZONE, type HomeWidget as Widget, type HomeZone } from '@knowledge/contracts'
import { Button } from '@knowledge/ui/button'
import { PageLayout, PageState } from '@knowledge/ui/layout'
import { getWorkspaceId } from '@/shared/api/api'
import { api } from '@/shared/api/client'
import { errorMessage } from '@/shared/api/errors'
import { usePermission } from '@/stores/permissions'
import { ActivityFeed } from '@/entities/document'
import HomeWidget from '../components/HomeWidget.vue'
import HomeMetrics from '../components/HomeMetrics.vue'
import HomeActions from '../components/HomeActions.vue'
import HomeNeedsYou from '../components/HomeNeedsYou.vue'
import HomeRecent from '../components/HomeRecent.vue'
import HomeAgents from '../components/HomeAgents.vue'
import { homeQuery } from '../model/home-query'
import { inZone, moveWidget, slotsFor, toggleWidget } from '../model/layout-draft'

const { t } = useI18n()
const isWorkspaceAdmin = usePermission('workspace:admin')
const queryClient = useQueryClient()
const query = useQuery(homeQuery())
const data = computed(() => query.data.value)

// Customize needs JS, so it appears only once the page is live.
const mounted = ref(false)
onMounted(() => (mounted.value = true))

/** The layout being edited, or null outside customize mode. */
const draft = ref<Widget[] | null>(null)
/** Reset asks for the built-in layout (null), not a copy of it that would stop following new widgets. */
const resetting = ref(false)
const saving = ref(false)
const customizing = computed(() => draft.value !== null)

function startCustomize() {
  draft.value = [...(data.value?.layout ?? HOME_WIDGETS)]
  resetting.value = false
}
function cancel() {
  draft.value = null
}
function reset() {
  draft.value = [...HOME_WIDGETS]
  resetting.value = true
}
function edit(next: Widget[]) {
  draft.value = next
  resetting.value = false
}
/** Read out by the polite live region below: a move or a hide is otherwise silent to a screen reader. */
const announcement = ref('')
function onMove(w: Widget, step: -1 | 1) {
  edit(moveWidget(draft.value!, w, step))
  const zone = inZone(draft.value!, HOME_WIDGET_ZONE[w])
  announcement.value = t('home.customize.moved', { name: t(TITLES[w]), n: zone.indexOf(w) + 1, total: zone.length })
}
function onToggle(w: Widget) {
  edit(toggleWidget(draft.value!, w))
  announcement.value = t(draft.value!.includes(w) ? 'home.customize.nowShown' : 'home.customize.nowHidden', { name: t(TITLES[w]) })
}
async function save() {
  if (!draft.value) return
  saving.value = true
  try {
    await api.put('/v1/workspaces/{id}/home/layout', {
      path: { id: getWorkspaceId() },
      body: { widgets: resetting.value ? null : draft.value },
    })
    await queryClient.invalidateQueries({ queryKey: homeQuery().queryKey })
    draft.value = null
    toast.success(t('home.customize.saved'))
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}

const TITLES: Record<Widget, string> = {
  metrics: 'home.widget.metrics',
  actions: 'home.widget.actions',
  'needs-you': 'home.widget.needsYou',
  recent: 'home.widget.recent',
  activity: 'home.widget.activity',
  agents: 'home.widget.agents',
}
const LINKS: Partial<Record<Widget, { to: string; label: string }>> = {
  recent: { to: '/documents', label: 'home.recent.all' },
  activity: { to: '/settings/activity', label: 'home.activity.all' },
  agents: { to: '/settings/ai/runs', label: 'home.agents.all' },
}

/** What each zone draws: in customize mode every widget, otherwise what the caller may read. */
function slots(zone: HomeZone): Widget[] {
  if (draft.value) return slotsFor(draft.value, zone)
  return inZone(data.value?.widgets ?? [], zone)
}
function frame(w: Widget) {
  const shown = draft.value?.includes(w) ?? true
  const zone = draft.value ? inZone(draft.value, HOME_WIDGET_ZONE[w]) : []
  return { shown, first: zone[0] === w, last: zone.at(-1) === w }
}
/** A widget re-shown in customize mode has no data until the layout is saved. */
function hasData(w: Widget): boolean {
  const d = data.value
  if (!d) return false
  if (w === 'actions') return true
  if (w === 'needs-you') return !!d.needsYou
  return !!d[w]
}
</script>

<template>
  <PageLayout variant="list" :title="t('home.title')">
    <template v-if="mounted && isWorkspaceAdmin && data" #actions>
      <template v-if="customizing">
        <Button variant="ghost" size="sm" :disabled="saving" @click="reset">{{ t('home.customize.reset') }}</Button>
        <Button variant="outline" size="sm" :disabled="saving" @click="cancel">{{ t('common.cancel') }}</Button>
        <Button size="sm" :disabled="saving" @click="save">{{ saving ? t('common.saving') : t('common.save') }}</Button>
      </template>
      <Button v-else variant="outline" size="sm" @click="startCustomize">
        <Settings2 aria-hidden="true" /> {{ t('home.customize.start') }}
      </Button>
    </template>

    <PageState v-if="query.isError.value && !data" state="error" :error="query.error.value" />
    <PageState v-else-if="!data" state="loading" :rows="3" row-class="h-24" />

    <template v-else>
      <p v-if="customizing" class="kn-measure text-sm text-muted-foreground">{{ t('home.customize.hint') }}</p>
      <p class="sr-only" role="status" aria-live="polite">{{ announcement }}</p>

      <template v-for="w in slots('top')" :key="w">
        <HomeWidget
          :title="t(TITLES[w])"
          quiet
          :customizing="customizing"
          v-bind="frame(w)"
          @move="(step) => onMove(w, step)"
          @toggle="onToggle(w)"
        >
          <HomeMetrics v-if="w === 'metrics' && data.metrics" :metrics="data.metrics" />
          <HomeActions v-else-if="w === 'actions'" />
          <p v-else class="text-sm text-muted-foreground">{{ t('home.customize.afterSave') }}</p>
        </HomeWidget>
      </template>

      <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div v-for="zone in (['main', 'side'] as const)" :key="zone" class="min-w-0 space-y-6">
          <HomeWidget
            v-for="w in slots(zone)"
            :key="w"
            :title="t(TITLES[w])"
            :to="LINKS[w]?.to"
            :to-label="LINKS[w] ? t(LINKS[w]!.label) : undefined"
            :customizing="customizing"
            v-bind="frame(w)"
            @move="(step) => onMove(w, step)"
            @toggle="onToggle(w)"
          >
            <p v-if="!hasData(w)" class="text-sm text-muted-foreground">{{ t('home.customize.afterSave') }}</p>
            <HomeNeedsYou v-else-if="w === 'needs-you'" :data="data.needsYou!" />
            <HomeRecent v-else-if="w === 'recent'" :pages="data.recent!" />
            <div v-else-if="w === 'activity'" class="rounded-xl border bg-card p-2">
              <ActivityFeed :limit="8" :initial="data.activity!" stacked />
            </div>
            <HomeAgents v-else-if="w === 'agents'" :data="data.agents!" />
          </HomeWidget>
        </div>
      </div>
    </template>
  </PageLayout>
</template>
