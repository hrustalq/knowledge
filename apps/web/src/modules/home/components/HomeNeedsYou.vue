<script setup lang="ts">
// What waits on the caller (#1243): merge requests they review, then their
// unread notifications. Both empty is one quiet line, not two empty boxes.
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { Bell, CircleCheck, GitPullRequestArrow } from 'lucide-vue-next'
import type { HomeNeedsYou } from '@knowledge/contracts'
import { relativeTime } from '@/shared/api/api'
import { useMembers } from '@/entities/person'

const props = defineProps<{ data: HomeNeedsYou }>()
const { t } = useI18n()
const { nameOf } = useMembers()
const uid = useId()

const reviews = computed(() => props.data.reviews ?? [])
const empty = computed(() => reviews.value.length === 0 && props.data.notifications.length === 0)
</script>

<template>
  <p v-if="empty" class="flex items-center gap-2 rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
    <CircleCheck class="size-4 shrink-0 text-panel-tip-ink" aria-hidden="true" />
    {{ t('home.needsYou.empty') }}
  </p>

  <div v-else class="divide-y overflow-hidden rounded-xl border bg-card">
    <section v-if="reviews.length" :aria-labelledby="`${uid}-reviews`">
      <div class="flex items-baseline justify-between gap-2 px-4 pt-3 pb-1 text-xs text-muted-foreground">
        <h3 :id="`${uid}-reviews`" class="font-medium">{{ t('home.needsYou.reviews') }}</h3>
        <RouterLink
          v-if="data.reviewCount > reviews.length"
          to="/merge-requests"
          class="-my-1 px-1 py-1 underline-offset-2 hover:text-foreground hover:underline outline-none focus-visible:ring-3 focus-visible:ring-ring rounded-sm"
        >
          {{ t('home.needsYou.allReviews', { n: data.reviewCount }) }}
        </RouterLink>
      </div>
      <ul>
        <li v-for="mr in reviews" :key="mr.id" class="flex items-center gap-2 px-4 py-2 text-sm">
          <GitPullRequestArrow class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <RouterLink :to="`/merge-requests/${mr.id}`" class="-my-1 min-w-0 flex-1 truncate py-1 font-medium hover:underline outline-none focus-visible:ring-3 focus-visible:ring-ring rounded-sm">
            {{ mr.title }}
          </RouterLink>
          <span class="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline sm:max-w-[10rem]">
            {{ nameOf(mr.authorId) }}
          </span>
          <span class="shrink-0 text-xs text-muted-foreground">{{ relativeTime(mr.createdAt) }}</span>
        </li>
      </ul>
    </section>

    <section v-if="data.notifications.length" :aria-labelledby="`${uid}-unread`">
      <div class="flex items-baseline justify-between gap-2 px-4 pt-3 pb-1 text-xs text-muted-foreground">
        <h3 :id="`${uid}-unread`" class="font-medium">{{ t('home.needsYou.unread') }}</h3>
        <RouterLink to="/notifications" class="-my-1 px-1 py-1 underline-offset-2 hover:text-foreground hover:underline outline-none focus-visible:ring-3 focus-visible:ring-ring rounded-sm">
          {{ t('home.needsYou.inbox', { n: data.unreadCount }, data.unreadCount) }}
        </RouterLink>
      </div>
      <ul>
        <li v-for="n in data.notifications" :key="n.id" class="flex items-center gap-2 px-4 py-2 text-sm">
          <Bell class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <RouterLink
            :to="n.documentId ? `/documents/${n.documentId}` : '/notifications'"
            class="-my-1 min-w-0 flex-1 truncate py-1 hover:underline outline-none focus-visible:ring-3 focus-visible:ring-ring rounded-sm"
          >
            {{ n.title ?? t('home.needsYou.untitled') }}
          </RouterLink>
          <span class="shrink-0 text-xs text-muted-foreground">{{ relativeTime(n.createdAt) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
