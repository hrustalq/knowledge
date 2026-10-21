<script setup lang="ts">
/**
 * A list of inbox rows with its own empty and loading states.
 *
 * Shared by the bell panel and the /notifications page so the two cannot drift
 * into showing the same row differently — the panel just passes `compact` and a
 * shorter slice.
 */
import { useI18n } from 'vue-i18n'
import { CircleAlert } from 'lucide-vue-next'
import type { NotificationEntry } from '@knowledge/contracts'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { PageState } from '@/components/layout/page'
import { errorMessage } from '@/api/errors'
import NotificationRow from './NotificationRow.vue'

defineProps<{
  entries: NotificationEntry[]
  loading?: boolean
  /** The first page failed. Not an empty inbox, so it never reads as one. */
  error?: unknown
  compact?: boolean
  emptyText?: string
  hasMore?: boolean
  loadingMore?: boolean
}>()
const emit = defineEmits<{ read: [string]; navigated: []; 'load-more': []; retry: [] }>()

const { t } = useI18n()
</script>

<template>
  <div class="flex flex-col gap-0.5">
    <template v-if="loading">
      <Skeleton v-for="i in 3" :key="i" class="h-12 w-full" />
    </template>

    <!-- The panel is 22rem of popover, so it gets the same sentence and retry
         in a row's footprint rather than the page's full error block. -->
    <div
      v-else-if="error && compact"
      role="alert"
      class="flex flex-col items-center gap-2 px-2.5 py-5 text-center text-sm"
    >
      <p class="flex items-center gap-1.5 font-medium text-destructive">
        <CircleAlert class="size-4 shrink-0" aria-hidden="true" />
        {{ t('page.errorTitle') }}
      </p>
      <p class="text-muted-foreground">{{ errorMessage(error, t) }}</p>
      <Button size="sm" variant="outline" @click="emit('retry')">{{ t('common.retry') }}</Button>
    </div>
    <PageState v-else-if="error" state="error" :error="error">
      <template #actions>
        <Button size="sm" variant="outline" @click="emit('retry')">{{ t('common.retry') }}</Button>
      </template>
    </PageState>

    <p v-else-if="entries.length === 0" class="px-2.5 py-6 text-center text-sm text-muted-foreground">
      {{ emptyText ?? t('notifications.empty') }}
    </p>

    <template v-else>
      <NotificationRow
        v-for="entry in entries"
        :key="entry.id"
        :entry="entry"
        :compact="compact"
        @read="emit('read', $event)"
        @navigated="emit('navigated')"
      />
      <Button
        v-if="hasMore"
        variant="ghost"
        size="sm"
        class="mt-1 self-center"
        :disabled="loadingMore"
        @click="emit('load-more')"
      >
        {{ loadingMore ? t('common.loading') : t('common.loadMore') }}
      </Button>
    </template>
  </div>
</template>
