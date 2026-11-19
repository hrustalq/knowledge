<script setup lang="ts">
/**
 * One error (#1240): the row `ops_events` holds — trace id, where it ran, who
 * and which workspace it ran for, the stack and every field the call site
 * logged — and the group it belongs to across everything still kept. The trace
 * id is the way into the logs, so it is the one thing with a copy button.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { ArrowLeft, Copy, FileQuestion } from 'lucide-vue-next'
import { PageLayout, PageState } from '@knowledge/ui/layout'
import { Badge } from '@knowledge/ui/badge'
import { Button } from '@knowledge/ui/button'
import { formatDateTime, formatDuration, formatNumber, formatRelative } from '@knowledge/contracts/format'
import { apiQueryOptions, isApiRequestError } from '@/shared/api/queries'
import { levelLabel, processLabel, sourceLabel } from '../model/error'

const props = defineProps<{ id: string }>()

const i18n = useI18n()
const { t, locale } = i18n
const query = useQuery(computed(() => apiQueryOptions('/v1/admin/errors/{id}', { path: { id: props.id } })))
const data = computed(() => query.data.value)
const event = computed(() => data.value?.event)
const notFound = computed(() => isApiRequestError(query.error.value) && query.error.value.status === 404)

/** The stack is shown on its own; the rest of the logged error stays with the fields. */
const fieldsText = computed(() => {
  const fields = { ...(event.value?.fields ?? {}) }
  if (fields.err && typeof fields.err === 'object') {
    const { stack: _stack, ...err } = fields.err as Record<string, unknown>
    fields.err = err
  }
  return JSON.stringify(fields, null, 2)
})

/** A catch-all logs one sentence ("Unhandled exception"); the error's own message is what went wrong. */
const errMessage = computed(() => {
  const err = event.value?.fields.err as { message?: unknown } | undefined
  const text = typeof err?.message === 'string' ? err.message.replace(/\s+/g, ' ').trim() : ''
  return text && text !== event.value?.message ? text.slice(0, 300) : null
})

/** The message is the page's title, so a long one is cut there and shown whole in the details. */
const TITLE_MAX = 120
const title = computed(() => {
  const message = event.value?.message ?? ''
  return message.length > TITLE_MAX ? `${message.slice(0, TITLE_MAX).trimEnd()}…` : message
})

const details = computed(() => {
  const e = event.value
  if (!e) return []
  return [
    { key: 'message', value: e.message.length > TITLE_MAX ? e.message : null },
    { key: 'process', value: processLabel(e.process, i18n) },
    { key: 'source', value: sourceLabel(e.source, i18n) },
    { key: 'context', value: e.context },
    { key: 'route', value: e.route, mono: true },
    { key: 'code', value: e.code, mono: true },
    { key: 'duration', value: e.durationMs === null ? null : formatDuration(e.durationMs, locale.value) },
    { key: 'workspace', value: e.workspaceName ?? e.workspaceId, hint: e.workspaceName ? e.workspaceId : null },
    { key: 'user', value: e.userEmail ?? e.userId, hint: e.userEmail ? e.userId : null, link: e.userId ? `/users/${e.userId}` : null },
  ].filter((row) => row.value)
})

async function copyTrace() {
  if (!event.value) return
  try {
    await navigator.clipboard.writeText(event.value.traceId)
    toast.success(t('admin.errors.traceCopied'))
  } catch {
    toast.error(t('admin.errors.copyFailed'))
  }
}

const relative = (iso: string) => formatRelative(iso, locale.value)
const exact = (iso: string) => formatDateTime(iso, locale.value)
</script>

<template>
  <PageState v-if="query.isPending.value" state="loading" :rows="6" row-class="h-10" />
  <PageLayout v-else-if="notFound" :title="t('admin.errors.notFound')">
    <PageState state="empty" :icon="FileQuestion" :title="t('admin.errors.notFound')" :description="t('admin.errors.notFoundHint')">
      <template #actions>
        <Button as-child variant="outline" size="sm">
          <RouterLink to="/errors">{{ t('admin.errors.allErrors') }}</RouterLink>
        </Button>
      </template>
    </PageState>
  </PageLayout>
  <PageState v-else-if="query.isError.value || !data || !event" state="error" :error="query.error.value" />

  <PageLayout v-else :title="title || t('admin.errors.noMessage')" :subtitle="errMessage ?? undefined">
    <template #actions>
      <Button variant="outline" size="sm" @click="copyTrace">
        <Copy aria-hidden="true" /> {{ t('admin.errors.copyTrace') }}
      </Button>
    </template>
    <template #meta>
      <div class="space-y-2">
        <RouterLink to="/errors" class="text-muted-foreground hover:text-foreground text-caption inline-flex items-center gap-1 transition-colors">
          <ArrowLeft class="size-3.5" aria-hidden="true" /> {{ t('admin.errors.allErrors') }}
        </RouterLink>
        <div class="text-caption text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge :variant="event.level === 'fatal' ? 'destructive' : 'outline'">{{ levelLabel(event.level, i18n) }}</Badge>
          <time :datetime="event.createdAt">{{ exact(event.createdAt) }}</time>
          <span class="text-foreground font-medium tabular-nums">{{ t('admin.errors.seenTimes', { n: formatNumber(data.group.count, locale) }) }}</span>
          <span>
            {{ t('admin.errors.firstSeen') }}
            <time :datetime="data.group.firstSeenAt" :title="exact(data.group.firstSeenAt)">{{ relative(data.group.firstSeenAt) }}</time>
          </span>
          <span>
            {{ t('admin.errors.lastSeen') }}
            <time :datetime="data.group.lastSeenAt" :title="exact(data.group.lastSeenAt)">{{ relative(data.group.lastSeenAt) }}</time>
          </span>
        </div>
      </div>
    </template>

    <section class="space-y-2" aria-labelledby="error-details">
      <h2 id="error-details" class="font-display text-base font-semibold tracking-tight">{{ t('admin.errors.details') }}</h2>
      <dl class="divide-y rounded-lg border">
        <div class="text-ui grid gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <dt class="text-muted-foreground">{{ t('admin.errors.field.trace') }}</dt>
          <dd class="font-mono break-all select-all">{{ event.traceId }}</dd>
        </div>
        <div v-for="row in details" :key="row.key" class="text-ui grid gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <dt class="text-muted-foreground">{{ t(`admin.errors.field.${row.key}`) }}</dt>
          <dd class="min-w-0 break-words" :class="row.mono && 'font-mono break-all'">
            <RouterLink v-if="row.link" :to="row.link" class="decoration-primary/40 underline-offset-4 hover:underline focus-visible:underline">
              {{ row.value }}
            </RouterLink>
            <template v-else>{{ row.value }}</template>
            <span v-if="row.hint" class="text-muted-foreground text-caption block font-mono break-all">{{ row.hint }}</span>
          </dd>
        </div>
      </dl>
    </section>

    <section class="space-y-2" aria-labelledby="error-stack">
      <h2 id="error-stack" class="font-display text-base font-semibold tracking-tight">{{ t('admin.errors.stack') }}</h2>
      <pre
        v-if="event.stack"
        class="bg-muted/40 text-caption max-h-[28rem] overflow-auto rounded-lg border px-3 py-2 font-mono leading-relaxed whitespace-pre"
        tabindex="0"
        :aria-label="t('admin.errors.stack')"
        >{{ event.stack }}</pre
      >
      <p v-else class="text-ui text-muted-foreground rounded-lg border px-3 py-2">{{ t('admin.errors.noStack') }}</p>
    </section>

    <section class="space-y-2" aria-labelledby="error-fields">
      <h2 id="error-fields" class="font-display text-base font-semibold tracking-tight">{{ t('admin.errors.fields') }}</h2>
      <pre
        class="bg-muted/40 text-caption max-h-[28rem] overflow-auto rounded-lg border px-3 py-2 font-mono leading-relaxed whitespace-pre-wrap break-all"
        tabindex="0"
        :aria-label="t('admin.errors.fields')"
        >{{ fieldsText }}</pre
      >
    </section>

    <section class="space-y-2" aria-labelledby="error-recent">
      <h2 id="error-recent" class="font-display flex items-baseline gap-2 text-base font-semibold tracking-tight">
        {{ t('admin.errors.recent') }}
        <span class="text-muted-foreground text-caption font-sans font-normal">{{ data.recent.length }}</span>
      </h2>
      <ul class="divide-y rounded-lg border">
        <li
          v-for="occ in data.recent"
          :key="occ.id"
          class="text-ui grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[11rem_8rem_minmax(0,1fr)_minmax(0,16rem)]"
          :class="occ.id === event.id && 'bg-muted/40'"
        >
          <RouterLink
            v-if="occ.id !== event.id"
            :to="`/errors/${occ.id}`"
            class="decoration-primary/40 whitespace-nowrap tabular-nums underline-offset-4 hover:underline focus-visible:underline"
          >
            <time :datetime="occ.createdAt">{{ exact(occ.createdAt) }}</time>
          </RouterLink>
          <span v-else class="font-medium whitespace-nowrap tabular-nums" aria-current="page">
            <time :datetime="occ.createdAt">{{ exact(occ.createdAt) }}</time>
          </span>
          <span class="text-muted-foreground justify-self-end sm:justify-self-start">{{ processLabel(occ.process, i18n) }}</span>
          <span class="text-muted-foreground col-span-2 truncate sm:col-span-1">{{ occ.workspaceName ?? t('admin.errors.noWorkspace') }}</span>
          <span class="text-muted-foreground text-caption col-span-2 truncate font-mono sm:col-span-1" :title="occ.traceId">{{ occ.traceId }}</span>
        </li>
      </ul>
    </section>
  </PageLayout>
</template>
