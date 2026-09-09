<script setup lang="ts">
/**
 * One person's activity, grouped by day.
 *
 * A separate component from `ActivityFeed` rather than four more props on it:
 * the feed is a virtualized firehose whose row is one line, and this is a
 * read of a narrow window where the day heading is the point — you arrived
 * here by clicking a day, so the day has to be the thing you land on. Same
 * endpoint, different question. (The `DiffView`-out-of-`RevisionsView` split,
 * for the same reason.)
 *
 * Kind filtering is applied client-side because the server has no kind column
 * by design — the kind is a *reading* of the action string (see contracts),
 * and both sides read it with the same function.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { activityKindFor, type ActivityEntry, type ActivityKind, type ListActivityResponse } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { activityKindStyle } from '@/lib/activity-kinds'
import { api } from '@/api'
import { getWorkspaceId } from '@/lib/api'
import { formatDate, formatRelative } from '@/lib/format'

const props = defineProps<{
  actor: string
  /** `YYYY-MM-DD` bounds; both absent means the whole window the caller set. */
  from?: string | null
  to?: string | null
  kind: ActivityKind | null
}>()

const { t, locale } = useI18n()

/**
 * `formatDate` reads a module-level locale, so it carries no reactive
 * dependency: on a live language switch a date already on screen keeps the
 * previous language until something else in the component happens to change.
 * Touching vue-i18n's reactive `locale` here is what makes these dates follow
 * the switcher. (The same staleness exists wherever the app formats a date in
 * a template; this fixes this surface, not the underlying helper.)
 */
function localeDate(iso: string): string {
  void locale.value
  return formatDate(iso)
}

const entries = ref<ActivityEntry[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(true)
const busy = ref(false)
const failed = ref(false)

async function fetchPage(cursor?: string): Promise<ListActivityResponse> {
  return (await api.get('/v1/activity', {
    query: {
      workspaceId: getWorkspaceId(),
      actor: props.actor,
      ...(props.from ? { from: props.from } : {}),
      ...(props.to ? { to: props.to } : {}),
      limit: '60',
      ...(cursor ? { cursor } : {}),
    },
  })) as ListActivityResponse
}

async function reload() {
  loading.value = true
  failed.value = false
  try {
    const res = await fetchPage()
    entries.value = res.entries
    nextCursor.value = res.nextCursor
  } catch {
    failed.value = true
    entries.value = []
    nextCursor.value = null
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (!nextCursor.value || busy.value) return
  busy.value = true
  try {
    const res = await fetchPage(nextCursor.value)
    entries.value = [...entries.value, ...res.entries]
    nextCursor.value = res.nextCursor
  } catch {
    /* the button stays; the loaded page is still good */
  } finally {
    busy.value = false
  }
}

watch(() => [props.actor, props.from, props.to], () => void reload(), { immediate: true })

const filtered = computed(() =>
  props.kind === null ? entries.value : entries.value.filter((e) => activityKindFor(e.action) === props.kind),
)

/** Day → its entries, newest day first; the feed already arrives sorted. */
const days = computed(() => {
  const out: { date: string; entries: ActivityEntry[] }[] = []
  for (const entry of filtered.value) {
    const date = entry.createdAt.slice(0, 10)
    const last = out[out.length - 1]
    if (last && last.date === date) last.entries.push(entry)
    else out.push({ date, entries: [entry] })
  }
  return out
})

/**
 * The action code IS the key path (`activity.action.<code>`), so there is no
 * second map to keep in sync — the convention `ActivityFeed` established. An
 * unknown code renders as itself rather than as a raw key.
 */
function label(entry: ActivityEntry): string {
  const key = `activity.action.${entry.action}`
  const text = t(key)
  return text === key ? entry.action : text
}

function title(entry: ActivityEntry): string {
  return (
    entry.documentTitle ??
    (typeof entry.metadata.documentTitle === 'string' ? entry.metadata.documentTitle : null) ??
    (typeof entry.metadata.title === 'string' ? entry.metadata.title : null) ??
    ''
  )
}
</script>

<template>
  <div class="min-w-0">
    <div v-if="loading" class="space-y-3">
      <Skeleton v-for="i in 4" :key="i" class="h-9 w-full" />
    </div>

    <p v-else-if="failed" class="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
      {{ t('profile.activity.failed') }}
    </p>

    <!-- Two different emptinesses, and they mean different things: nothing in
         this window at all, versus nothing of the kind being filtered for. -->
    <p v-else-if="days.length === 0" class="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
      {{ kind ? t('profile.activity.emptyKind') : t('profile.activity.empty') }}
    </p>

    <ol v-else class="space-y-6">
      <li v-for="day in days" :key="day.date">
        <div class="mb-2 flex items-baseline gap-2">
          <h3 class="font-display text-sm font-semibold tracking-tight">
            {{ localeDate(`${day.date}T00:00:00.000Z`) }}
          </h3>
          <span class="text-xs text-muted-foreground">{{
            t('profile.activity.dayCount', { n: day.entries.length })
          }}</span>
        </div>
        <ul class="space-y-px">
          <li
            v-for="entry in day.entries"
            :key="entry.id"
            class="group flex items-baseline gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/50"
          >
            <component
              :is="activityKindStyle(activityKindFor(entry.action)).icon"
              class="size-3.5 shrink-0 translate-y-0.5"
              :style="{ color: activityKindStyle(activityKindFor(entry.action)).color }"
              aria-hidden="true"
            />
            <span class="shrink-0 text-muted-foreground">{{ label(entry) }}</span>
            <RouterLink
              v-if="entry.documentId"
              :to="`/documents/${entry.documentId}`"
              class="min-w-0 truncate font-medium text-primary hover:underline"
            >{{ title(entry) || entry.documentId.slice(0, 8) }}</RouterLink>
            <span v-else-if="title(entry)" class="min-w-0 truncate font-medium">{{ title(entry) }}</span>
            <time
              class="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
              :datetime="entry.createdAt"
              :title="entry.createdAt"
            >{{ (locale, formatRelative(entry.createdAt)) }}</time>
          </li>
        </ul>
      </li>
    </ol>

    <div v-if="!loading && nextCursor" class="mt-5">
      <Button variant="outline" size="sm" :disabled="busy" @click="loadMore">
        {{ busy ? t('profile.activity.loading') : t('profile.activity.loadMore') }}
      </Button>
    </div>
  </div>
</template>
