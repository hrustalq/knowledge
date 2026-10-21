<script setup lang="ts">
/**
 * A tracker connector's handoff settings (#424), for an admin: which knowledge
 * projects hand off here, how this tracker's statuses read as ours, and which
 * tracker accounts are which people.
 *
 * Every map shows the default it overrides, so an empty field means "the
 * default", never "nothing": the status map is a sparse override of the
 * tracker's code default, and saving it empty restores the default.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Trash2 } from 'lucide-vue-next'
import type {
  ConnectorAclResponse,
  ConnectorSummary,
  ListTrackerRoutesResponse,
  TrackerRouteInfo,
  WorkItemStatus,
  WorkItemStatusMap,
} from '@knowledge/contracts'
import { DEFAULT_WORK_ITEM_STATUS_MAPS, WORK_ITEM_STATUSES, trackerKindOf } from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { errorMessage } from '@/api/errors'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import OwnerPicker from '@/components/verification/OwnerPicker.vue'

const props = defineProps<{ connector: ConnectorSummary }>()

const { t } = useI18n()
const queryClient = useQueryClient()
const projects = useProjectsStore()
if (!projects.loaded) void projects.fetchList()

const kind = computed(() => trackerKindOf(props.connector) ?? 'github')
const defaults = computed(() => DEFAULT_WORK_ITEM_STATUS_MAPS[kind.value])

/* ---------------------------------------------------------------- routes */

const routesQuery = useQuery(
  computed(() => apiQueryOptions('/v1/connectors/{id}/tracker-routes', { path: { id: props.connector.id } })),
)
const routes = computed(() => (routesQuery.data.value as ListTrackerRoutesResponse | undefined)?.routes ?? [])
const projectName = (id: string) => projects.items.find((p) => p.projectId === id)?.name ?? id.slice(0, 8)
const unrouted = computed(() => projects.items.filter((p) => !routes.value.some((r) => r.projectId === p.projectId)))

const draft = reactive({ projectId: '', externalProject: '', issueType: '', boardUrl: '' })
const savingRoute = ref(false)
watch(unrouted, (list) => {
  if (!list.some((p) => p.projectId === draft.projectId)) draft.projectId = list[0]?.projectId ?? ''
}, { immediate: true })

function refreshRoutes() {
  void queryClient.invalidateQueries({ queryKey: ['/v1/connectors/{id}/tracker-routes'] })
}

async function saveRoute(route?: TrackerRouteInfo) {
  const projectId = route?.projectId ?? draft.projectId
  if (!projectId || savingRoute.value) return
  savingRoute.value = true
  try {
    await api.put('/v1/projects/{id}/tracker-route', {
      path: { id: projectId },
      body: {
        connectorId: props.connector.id,
        externalProject: (route?.externalProject ?? draft.externalProject).trim() || null,
        issueType: (route?.issueType ?? draft.issueType).trim() || null,
        boardUrl: (route?.boardUrl ?? draft.boardUrl).trim() || null,
      },
    })
    toast.success(t('workItems.settings.routeSaved', { project: projectName(projectId) }))
    Object.assign(draft, { externalProject: '', issueType: '', boardUrl: '' })
    refreshRoutes()
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    savingRoute.value = false
  }
}

async function removeRoute(route: TrackerRouteInfo) {
  try {
    await api.delete('/v1/projects/{id}/tracker-route', { path: { id: route.projectId } })
    refreshRoutes()
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

/* ------------------------------------------------------------ status map */

type Override = Partial<WorkItemStatusMap>
const stored = computed(() => ((props.connector.config as unknown as { statusMap?: Override }).statusMap ?? {}) as Override)
/** Inbound as rows a person edits; outbound as one field per status. */
const inboundRows = ref<Array<{ raw: string; status: WorkItemStatus }>>([])
const outbound = reactive<Record<WorkItemStatus, string>>({ open: '', in_progress: '', done: '', wont_do: '' })
watch(
  stored,
  (map) => {
    inboundRows.value = Object.entries(map.inbound ?? {}).map(([raw, status]) => ({ raw, status }))
    for (const s of WORK_ITEM_STATUSES) outbound[s] = map.outbound?.[s] ?? ''
  },
  { immediate: true },
)
const savingMap = ref(false)

async function saveMap() {
  if (savingMap.value) return
  savingMap.value = true
  try {
    await api.put('/v1/connectors/{id}/status-map', {
      path: { id: props.connector.id },
      body: {
        inbound: Object.fromEntries(inboundRows.value.filter((r) => r.raw.trim()).map((r) => [r.raw.trim(), r.status])),
        outbound: Object.fromEntries(WORK_ITEM_STATUSES.filter((s) => outbound[s].trim()).map((s) => [s, outbound[s].trim()])),
      },
    })
    toast.success(t('workItems.settings.mapSaved'))
    void queryClient.invalidateQueries({ queryKey: ['/v1/connectors/{id}'] })
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    savingMap.value = false
  }
}

/* ---------------------------------------------------------------- people */

const aclQuery = useQuery(computed(() => apiQueryOptions('/v1/connectors/{id}/acl', { path: { id: props.connector.id } })))
const identities = computed(() => (aclQuery.data.value as ConnectorAclResponse | undefined)?.identities ?? [])

async function mapIdentity(identityId: string, userId: string | null) {
  try {
    await api.put('/v1/connectors/{id}/acl/identities/{identityId}', {
      path: { id: props.connector.id, identityId },
      body: { userId },
    })
    void queryClient.invalidateQueries({ queryKey: ['/v1/connectors/{id}/acl'] })
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

/** Examples in Jira's own vocabulary, not ours: never translated. */
const JIRA_PROJECT_EXAMPLE = 'BILL'
const JIRA_DEFAULT_ISSUE_TYPE = 'Task'

const field = 'h-8 w-full rounded-md border bg-transparent px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring'
</script>

<template>
  <div class="max-w-3xl space-y-8 text-sm">
    <!-- Routes: where each project's handoffs go. -->
    <section class="space-y-3" aria-labelledby="tracker-routes">
      <div>
        <h2 id="tracker-routes" class="font-medium">{{ t('workItems.settings.routesTitle') }}</h2>
        <p class="text-xs text-muted-foreground">{{ t('workItems.settings.routesHint') }}</p>
      </div>
      <ul v-if="routes.length" class="divide-y rounded-md border">
        <li v-for="route in routes" :key="route.projectId" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
          <span class="font-medium">{{ projectName(route.projectId) }}</span>
          <span v-if="route.externalProject" class="text-xs text-muted-foreground">
            {{ route.externalProject }}<template v-if="route.issueType"> · {{ route.issueType }}</template>
          </span>
          <a v-if="route.boardUrl" :href="route.boardUrl" target="_blank" rel="noopener noreferrer" class="truncate text-xs underline underline-offset-2">
            {{ t('workItems.settings.board') }}
          </a>
          <span class="flex-1" aria-hidden="true" />
          <Button variant="ghost" size="icon-xs" :aria-label="t('workItems.settings.removeRoute', { project: projectName(route.projectId) })" @click="removeRoute(route)">
            <Trash2 class="size-3.5" />
          </Button>
        </li>
      </ul>
      <p v-else-if="!routesQuery.isPending.value" class="text-xs text-muted-foreground">{{ t('workItems.settings.noRoutes') }}</p>

      <form v-if="unrouted.length" class="grid gap-2 rounded-md border p-3 sm:grid-cols-2" @submit.prevent="saveRoute()">
        <div class="space-y-1">
          <Label for="route-project" class="text-xs">{{ t('workItems.settings.project') }}</Label>
          <select id="route-project" v-model="draft.projectId" :class="field">
            <option v-for="p in unrouted" :key="p.projectId" :value="p.projectId">{{ p.name }}</option>
          </select>
        </div>
        <template v-if="kind === 'jira'">
          <div class="space-y-1">
            <Label for="route-jira-project" class="text-xs">{{ t('workItems.settings.jiraProject') }}</Label>
            <Input id="route-jira-project" v-model="draft.externalProject" class="h-8" :placeholder="JIRA_PROJECT_EXAMPLE" autocomplete="off" />
          </div>
          <div class="space-y-1">
            <Label for="route-issue-type" class="text-xs">{{ t('workItems.settings.issueType') }}</Label>
            <Input id="route-issue-type" v-model="draft.issueType" class="h-8" :placeholder="JIRA_DEFAULT_ISSUE_TYPE" autocomplete="off" />
          </div>
        </template>
        <div v-else-if="kind === 'github'" class="space-y-1">
          <Label for="route-board" class="text-xs">{{ t('workItems.settings.boardUrl') }}</Label>
          <Input id="route-board" v-model="draft.boardUrl" class="h-8" placeholder="https://github.com/orgs/acme/projects/5" autocomplete="off" />
        </div>
        <div class="flex items-end sm:col-span-2">
          <Button type="submit" size="sm" :disabled="!draft.projectId || savingRoute">{{ t('workItems.settings.addRoute') }}</Button>
        </div>
      </form>
    </section>

    <!-- Status map: the tracker's words for each of ours. -->
    <section class="space-y-3" aria-labelledby="tracker-map">
      <div>
        <h2 id="tracker-map" class="font-medium">{{ t('workItems.settings.mapTitle') }}</h2>
        <p class="text-xs text-muted-foreground">{{ t('workItems.settings.mapHint') }}</p>
      </div>
      <form class="space-y-4" @submit.prevent="saveMap">
        <fieldset class="space-y-2">
          <legend class="text-xs font-medium">{{ t('workItems.settings.outbound') }}</legend>
          <div class="grid gap-2 sm:grid-cols-2">
            <div v-for="s in WORK_ITEM_STATUSES" :key="s" class="space-y-1">
              <Label :for="`map-out-${s}`" class="text-xs">{{ t(`workItems.status.${s}`) }}</Label>
              <Input :id="`map-out-${s}`" v-model="outbound[s]" class="h-8" :placeholder="defaults.outbound[s] ?? t('workItems.settings.notPushed')" autocomplete="off" />
            </div>
          </div>
        </fieldset>
        <fieldset class="space-y-2">
          <legend class="text-xs font-medium">{{ t('workItems.settings.inbound') }}</legend>
          <p class="text-xs text-muted-foreground">
            {{ t('workItems.settings.inboundDefaults', { list: Object.entries(defaults.inbound).map(([raw, s]) => `${raw} → ${t(`workItems.status.${s}`)}`).join(', ') }) }}
          </p>
          <div v-for="(row, i) in inboundRows" :key="i" class="flex items-center gap-2">
            <Input v-model="row.raw" class="h-8 flex-1" :aria-label="t('workItems.settings.trackerStatus')" :placeholder="t('workItems.settings.trackerStatus')" autocomplete="off" />
            <select v-model="row.status" :class="[field, 'w-40']" :aria-label="t('workItems.settings.ourStatus')">
              <option v-for="s in WORK_ITEM_STATUSES" :key="s" :value="s">{{ t(`workItems.status.${s}`) }}</option>
            </select>
            <Button type="button" variant="ghost" size="icon-xs" :aria-label="t('common.remove')" @click="inboundRows.splice(i, 1)">
              <Trash2 class="size-3.5" />
            </Button>
          </div>
          <Button type="button" variant="outline" size="xs" @click="inboundRows.push({ raw: '', status: 'in_progress' })">
            {{ t('workItems.settings.addInbound') }}
          </Button>
        </fieldset>
        <Button type="submit" size="sm" :disabled="savingMap">{{ t('common.save') }}</Button>
      </form>
    </section>

    <!-- People: attribution only. Nobody is assigned anything. -->
    <section class="space-y-3" aria-labelledby="tracker-people">
      <div>
        <h2 id="tracker-people" class="font-medium">{{ t('workItems.settings.peopleTitle') }}</h2>
        <p class="text-xs text-muted-foreground">{{ t('workItems.settings.peopleHint') }}</p>
      </div>
      <ul v-if="identities.length" class="divide-y rounded-md border">
        <li v-for="identity in identities" :key="identity.id" class="flex flex-wrap items-center gap-2 px-3 py-2">
          <span class="min-w-0 truncate">{{ identity.displayName ?? identity.externalId }}</span>
          <span class="flex-1" aria-hidden="true" />
          <OwnerPicker :owner-id="identity.userId ?? null" can-edit always :label="t('workItems.settings.mapPerson')" @change="(userId) => mapIdentity(identity.id, userId)" />
        </li>
      </ul>
      <p v-else-if="!aclQuery.isPending.value" class="text-xs text-muted-foreground">{{ t('workItems.settings.noPeople') }}</p>
    </section>
  </div>
</template>
