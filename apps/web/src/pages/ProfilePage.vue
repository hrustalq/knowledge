<script setup lang="ts">
/**
 * A workspace member as a work record.
 *
 * The arrangement it refuses is the social profile: no centred portrait, no
 * badge shelf, no streak trophy. What a governed knowledge base wants to know
 * about a person is what they have written, what rhythm they work at, and what
 * is still open on them — so the page is an identity band, a year of ink, and
 * the list that year opens onto, with the standing facts in the rail beside it.
 *
 * Everything here is workspace-scoped, because `activity_log` is: this answers
 * "who is this, here", never "who is this, everywhere".
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import {
  CalendarDays,
  FileText,
  GitPullRequestArrow,
  MessageSquare,
  Pencil,
  ShieldCheck,
  X,
} from 'lucide-vue-next'
import type {
  ActivityCalendarResponse,
  ActivityKind,
  UserProfileResponse,
} from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId, statusDot } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import UserAvatar from '@/components/merge-requests/UserAvatar.vue'
import RailSection from '@/components/knowledge/RailSection.vue'
import ActivityLedger from '@/components/profile/ActivityLedger.vue'
import ContributionStrip from '@/components/profile/ContributionStrip.vue'
import ProfileActivity from '@/components/profile/ProfileActivity.vue'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

/** `/u` with no id is your own profile — the avatar menu's target. */
const userId = computed(() => (route.params.userId as string) || auth.me?.userId || '')
const isSelf = computed(() => userId.value === auth.me?.userId)

// --- window -------------------------------------------------------------
// A year at a time, ending today. Earlier years are whole calendar years,
// which is the only framing where "2025" is a meaningful label.

const YEARS_BACK = 3
const thisYear = new Date().getUTCFullYear()
const years = Array.from({ length: YEARS_BACK + 1 }, (_, i) => thisYear - i)
const year = ref<number | 'rolling'>('rolling')

const windowRange = computed(() => {
  if (year.value === 'rolling') {
    const to = new Date()
    const from = new Date(to)
    from.setUTCDate(from.getUTCDate() - 364)
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
  }
  return { from: `${year.value}-01-01`, to: `${year.value}-12-31` }
})

// --- data ---------------------------------------------------------------

const profileQuery = useQuery({
  ...apiQueryOptions('/v1/profiles/{userId}', {
    path: { userId: userId.value },
    query: { workspaceId: getWorkspaceId() },
  }),
  enabled: computed(() => userId.value !== ''),
})
// The path is part of the query key, so a different person is a different
// query — re-running the options on id change is what refetches.
watch(userId, () => void profileQuery.refetch())

const profile = computed(() => profileQuery.data.value as UserProfileResponse | undefined)

const calendarQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/activity/calendar', {
      query: {
        workspaceId: getWorkspaceId(),
        actor: userId.value,
        from: windowRange.value.from,
        to: windowRange.value.to,
      },
    }),
    enabled: userId.value !== '',
  })),
)
const calendar = computed(() => (calendarQuery.data.value as ActivityCalendarResponse | undefined) ?? null)

// --- narrowing ----------------------------------------------------------
// The selected day lives in the URL so a day of someone's work is a link you
// can send. The kind filter does not: it is a way of reading the page you are
// already on, not a place.

const selectedDay = computed(() => (route.query.day as string) || null)
const kind = ref<ActivityKind | null>(null)

function selectDay(day: string | null) {
  void router.replace({ query: { ...route.query, day: day ?? undefined } })
}

const listRange = computed(() =>
  selectedDay.value
    ? { from: selectedDay.value, to: selectedDay.value }
    : { from: windowRange.value.from, to: windowRange.value.to },
)

const openWork = computed(() => profile.value?.openWork ?? null)
const openWorkTotal = computed(() =>
  openWork.value
    ? openWork.value.authoredMergeRequests +
      openWork.value.awaitingTheirReview +
      openWork.value.unresolvedThreads
    : 0,
)

/**
 * `formatDate` reads a module-level locale, so it carries no reactive
 * dependency: on a live language switch a date already on screen keeps the
 * previous language until something else in the component happens to change.
 * Touching vue-i18n's reactive `locale` here is what makes these dates follow
 * the switcher. (The same staleness exists wherever the app formats a date in
 * a template; this fixes the profile surface, not the underlying helper.)
 */
function localeDate(iso: string): string {
  void locale.value
  return formatDate(iso)
}

const rail = ref<Record<string, boolean>>({ pages: true, open: false, access: false })
</script>

<template>
  <div class="flex min-w-0 flex-col gap-6">
    <!-- Identity band. Left-aligned and horizontal: this is a record header,
         not a portrait. -->
    <header v-if="profileQuery.isPending.value" class="flex items-center gap-4">
      <Skeleton class="size-14 rounded-full" />
      <div class="space-y-2">
        <Skeleton class="h-6 w-48" />
        <Skeleton class="h-4 w-64" />
      </div>
    </header>

    <p
      v-else-if="profileQuery.isError.value"
      class="rounded-lg border border-dashed px-4 py-8 text-sm text-muted-foreground"
    >
      {{ t('profile.notFound') }}
    </p>

    <template v-else-if="profile">
      <header class="flex flex-wrap items-start gap-4">
        <UserAvatar
          :user-id="profile.userId"
          :name="profile.displayName"
          :src="profile.avatarUrl"
          class="!size-14 !text-lg"
        />
        <div class="min-w-0 flex-1">
          <h1 class="font-display text-2xl font-bold tracking-tight">{{ profile.displayName }}</h1>
          <p class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span class="truncate">{{ profile.email }}</span>
            <span v-if="profile.memberSince || !profile.role" aria-hidden="true">·</span>
            <span v-if="profile.memberSince">{{
              t('profile.memberSince', { date: localeDate(profile.memberSince) })
            }}</span>
            <span v-else-if="!profile.role">{{ t('profile.notAMember') }}</span>
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge v-if="profile.role" variant="secondary">{{ t(`role.${profile.role}`) }}</Badge>
            <Badge v-if="profile.isAdmin" variant="outline">{{ t('profile.platformAdmin') }}</Badge>
            <Badge v-if="profile.trustedOperator" variant="outline">{{ t('profile.trustedOperator') }}</Badge>
            <Badge v-if="profile.disabled" variant="destructive">{{ t('profile.disabled') }}</Badge>
          </div>
        </div>
        <Button v-if="isSelf" as-child variant="outline" size="sm">
          <RouterLink to="/settings/profile">
            <Pencil class="size-4" />
            {{ t('profile.editProfile') }}
          </RouterLink>
        </Button>
      </header>

      <div class="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div class="flex min-w-0 flex-col gap-6">
          <!-- The ledger. Not prose, so it takes the full column rather than
               the 46rem measure. -->
          <section class="min-w-0 rounded-xl border bg-card p-4 lg:p-5">
            <div class="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
              <h2 class="font-display text-[15px] font-semibold tracking-tight">
                {{
                  calendar
                    ? t('profile.ledger.heading', { n: calendar.total })
                    : t('profile.ledger.headingLoading')
                }}
              </h2>
              <!-- Year picker as a row of text buttons, not a <select>: four
                   options that fit inline should not cost a menu. -->
              <div class="flex items-center gap-1" role="group" :aria-label="t('profile.ledger.window')">
                <button
                  type="button"
                  class="kn-year"
                  :class="year === 'rolling' ? 'kn-year--on' : ''"
                  :aria-pressed="year === 'rolling'"
                  @click="year = 'rolling'"
                >{{ t('profile.ledger.rolling') }}</button>
                <button
                  v-for="y in years"
                  :key="y"
                  type="button"
                  class="kn-year"
                  :class="year === y ? 'kn-year--on' : ''"
                  :aria-pressed="year === y"
                  @click="year = y"
                >{{ y }}</button>
              </div>
            </div>

            <ActivityLedger
              :calendar="calendar"
              :loading="calendarQuery.isFetching.value"
              :selected="selectedDay"
              @select="selectDay"
            />

            <div v-if="calendar && calendar.total > 0" class="mt-5 border-t pt-4">
              <ContributionStrip
                :by-kind="calendar.byKind"
                :total="calendar.total"
                :active="kind"
                @update:active="kind = $event"
              />
              <p v-if="calendar.longestStreak > 1" class="mt-3 text-xs text-muted-foreground">
                {{ t('profile.ledger.streak', { current: calendar.currentStreak, longest: calendar.longestStreak }) }}
              </p>
            </div>
          </section>

          <section class="min-w-0">
            <div class="mb-3 flex flex-wrap items-center gap-2">
              <h2 class="font-display text-[15px] font-semibold tracking-tight">
                {{ t('profile.activity.heading') }}
              </h2>
              <!-- The narrowing states itself in words. A filter you cannot
                   read is a filter you forget you set. -->
              <Badge v-if="selectedDay" variant="secondary" class="gap-1">
                <CalendarDays class="size-3" />
                {{ localeDate(`${selectedDay}T00:00:00.000Z`) }}
              </Badge>
              <Button
                v-if="selectedDay || kind"
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs"
                @click="selectDay(null); kind = null"
              >
                <X class="size-3.5" />
                {{ t('profile.activity.clear') }}
              </Button>
            </div>
            <ProfileActivity
              :actor="userId"
              :from="listRange.from"
              :to="listRange.to"
              :kind="kind"
            />
          </section>
        </div>

        <!-- Standing facts, in the rail the rest of the app already uses for
             them: collapsed to the one number that decides whether to open. -->
        <aside class="flex min-w-0 flex-col gap-2.5">
          <RailSection
            :icon="FileText"
            :title="t('profile.pages.title')"
            :preview="t('profile.pages.preview', { n: profile.pageCount })"
            :open="rail.pages"
            @update:open="rail.pages = $event"
          >
            <p v-if="profile.pages.length === 0" class="text-sm text-muted-foreground">
              {{ t('profile.pages.empty') }}
            </p>
            <ul v-else class="space-y-px">
              <li v-for="page in profile.pages" :key="page.documentId">
                <RouterLink
                  :to="`/documents/${page.documentId}`"
                  class="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-sm transition-colors hover:bg-muted/50"
                >
                  <span
                    class="size-1.5 shrink-0 rounded-full"
                    :class="statusDot(page.status)"
                    aria-hidden="true"
                  />
                  <span class="min-w-0 flex-1 truncate">{{ page.title }}</span>
                  <span class="shrink-0 text-[11px] text-muted-foreground tabular-nums">{{
                    page.authored ? t('profile.pages.authored') : t('profile.pages.revisions', { n: page.revisions })
                  }}</span>
                </RouterLink>
              </li>
            </ul>
            <p
              v-if="profile.pageCount > profile.pages.length"
              class="mt-2 px-1.5 text-[11px] text-muted-foreground"
            >
              {{ t('profile.pages.more', { n: profile.pageCount - profile.pages.length }) }}
            </p>
          </RailSection>

          <RailSection
            :icon="GitPullRequestArrow"
            :title="t('profile.open.title')"
            :preview="openWorkTotal === 0 ? t('profile.open.clear') : t('profile.open.preview', { n: openWorkTotal })"
            :open="rail.open"
            @update:open="rail.open = $event"
          >
            <!-- Zero is an answer here, not an empty state: "nothing open" is
                 what half the people who open this widget came to confirm. -->
            <ul v-if="openWork" class="space-y-1.5 text-sm">
              <li class="flex items-center gap-2">
                <GitPullRequestArrow class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="min-w-0 flex-1">{{ t('profile.open.authored') }}</span>
                <span class="font-medium tabular-nums">{{ openWork.authoredMergeRequests }}</span>
              </li>
              <li class="flex items-center gap-2">
                <ShieldCheck class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="min-w-0 flex-1">{{ t('profile.open.awaiting') }}</span>
                <span class="font-medium tabular-nums">{{ openWork.awaitingTheirReview }}</span>
              </li>
              <li class="flex items-center gap-2">
                <MessageSquare class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="min-w-0 flex-1">{{ t('profile.open.threads') }}</span>
                <span class="font-medium tabular-nums">{{ openWork.unresolvedThreads }}</span>
              </li>
            </ul>
            <RouterLink
              v-if="openWorkTotal > 0"
              :to="`/merge-requests?author=${profile.userId}`"
              class="mt-3 inline-block text-xs text-primary underline-offset-2 hover:underline"
            >{{ t('profile.open.viewMergeRequests') }}</RouterLink>
          </RailSection>

          <RailSection
            :icon="ShieldCheck"
            :title="t('profile.access.title')"
            :preview="profile.role ? t(`role.${profile.role}`) : t('profile.notAMember')"
            :open="rail.access"
            @update:open="rail.access = $event"
          >
            <dl class="space-y-2 text-sm">
              <div class="flex items-baseline gap-2">
                <dt class="min-w-0 flex-1 text-muted-foreground">{{ t('profile.access.role') }}</dt>
                <dd class="font-medium">{{ profile.role ? t(`role.${profile.role}`) : '—' }}</dd>
              </div>
              <div class="flex items-baseline gap-2">
                <dt class="min-w-0 flex-1 text-muted-foreground">{{ t('profile.access.operator') }}</dt>
                <dd class="font-medium">{{ profile.trustedOperator ? t('common.yes') : t('common.no') }}</dd>
              </div>
              <div class="flex items-baseline gap-2">
                <dt class="min-w-0 flex-1 text-muted-foreground">{{ t('profile.access.signIn') }}</dt>
                <dd class="font-medium">
                  {{
                    [
                      profile.hasPassword ? t('profile.access.password') : null,
                      profile.hasApiKey ? t('profile.access.apiKey') : null,
                    ].filter(Boolean).join(' · ') || t('profile.access.none')
                  }}
                </dd>
              </div>
              <div class="flex items-baseline gap-2">
                <dt class="min-w-0 flex-1 text-muted-foreground">{{ t('profile.access.accountCreated') }}</dt>
                <dd class="font-medium">{{ localeDate(profile.createdAt) }}</dd>
              </div>
            </dl>
          </RailSection>
        </aside>
      </div>
    </template>
  </div>
</template>
