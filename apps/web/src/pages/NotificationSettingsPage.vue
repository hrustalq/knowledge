<script setup lang="ts">
/**
 * What the caller wants to hear about, in this workspace (docs/features/22).
 *
 * Per workspace rather than per account, because the answer genuinely differs:
 * somebody may follow every page in the team space they own and want nothing
 * but mentions from the one they were added to last week.
 *
 * Every row saves on its own, like ProfileSettingsPage — a single Save covering
 * both a category toggle and an unrelated switch would make the toggle look
 * unapplied until you pressed something else.
 *
 * Two groups, matching that page's shape so the two settings surfaces read as
 * one system: what reaches you, and what you follow. The auto-watch rule sits
 * with the second, not the first — "commenting starts watching" is a rule about
 * following, and grouping it with the categories left it stranded under a
 * column while the other one stood empty.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { RouterLink } from 'vue-router'
import { Bell, Eye } from 'lucide-vue-next'
import type {
  ListNotificationSubscriptionsResponse,
  NotificationCategory,
  NotificationPreferences,
  NotificationSubscriptionEntry,
} from '@knowledge/contracts'
import { NOTIFICATION_CATEGORIES } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { categoryLook } from '@/components/notifications/notification-ui'

const { t } = useI18n()

const prefs = ref<NotificationPreferences | null>(null)
const subscriptions = ref<NotificationSubscriptionEntry[]>([])
const loading = ref(true)
const saving = ref(false)

const muted = computed(() => new Set(prefs.value?.mutedCategories ?? []))

async function load() {
  loading.value = true
  try {
    const ws = getWorkspaceId()
    const [p, s] = await Promise.all([
      apiFetch<NotificationPreferences>(`/v1/notifications/preferences?workspaceId=${ws}`),
      apiFetch<ListNotificationSubscriptionsResponse>(`/v1/notifications/subscriptions?workspaceId=${ws}`),
    ])
    prefs.value = p
    subscriptions.value = s.subscriptions
  } catch {
    toast.error(t('notifications.settingsLoadFailed'))
  } finally {
    loading.value = false
  }
}

async function save(patch: Partial<Pick<NotificationPreferences, 'mutedCategories' | 'autoWatchOnComment'>>) {
  if (!prefs.value) return
  saving.value = true
  const previous = { ...prefs.value }
  // Applied first: a switch that waits for a round trip before moving reads as
  // a switch that did not register the press.
  prefs.value = { ...prefs.value, ...patch }
  try {
    prefs.value = await apiFetch<NotificationPreferences>('/v1/notifications/preferences', {
      method: 'PUT',
      body: JSON.stringify({ workspaceId: getWorkspaceId(), ...patch }),
    })
  } catch {
    prefs.value = previous
    toast.error(t('notifications.settingsSaveFailed'))
  } finally {
    saving.value = false
  }
}

function toggleCategory(category: NotificationCategory) {
  const next = new Set(muted.value)
  if (next.has(category)) next.delete(category)
  else next.add(category)
  void save({ mutedCategories: [...next] })
}

async function unwatch(entry: NotificationSubscriptionEntry) {
  try {
    await apiFetch('/v1/notifications/subscriptions', {
      method: 'PUT',
      body: JSON.stringify({
        workspaceId: getWorkspaceId(),
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        state: 'default',
      }),
    })
    subscriptions.value = subscriptions.value.filter((s) => s.subjectId !== entry.subjectId)
  } catch {
    toast.error(t('notifications.settingsSaveFailed'))
  }
}

const watching = computed(() => subscriptions.value.filter((s) => s.state === 'watching'))
const mutedSubjects = computed(() => subscriptions.value.filter((s) => s.state === 'muted'))

function linkFor(entry: NotificationSubscriptionEntry): string {
  if (entry.subjectType === 'merge-request') return `/merge-requests/${entry.subjectId}`
  if (entry.subjectType === 'project') return `/settings/projects/${entry.subjectId}`
  return `/documents/${entry.subjectId}`
}

onMounted(load)
</script>

<template>
  <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-5">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('notifications.title') }}</h1>
      <p class="mt-1 text-sm text-muted-foreground">{{ t('notifications.settingsSubtitle') }}</p>
    </div>

    <div v-if="loading" class="grid items-start gap-5 lg:grid-cols-2">
      <Skeleton v-for="i in 2" :key="i" class="h-64 w-full" />
    </div>

    <div v-else class="grid min-w-0 items-start gap-5 lg:grid-cols-2">
      <!-- What arrives -->
      <section class="min-w-0 rounded-xl border bg-card">
        <div class="border-b px-5 py-3.5">
          <h2 class="font-display text-[15px] font-semibold tracking-tight">
            {{ t('notifications.categoriesTitle') }}
          </h2>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ t('notifications.categoriesHint') }}</p>
        </div>

        <ul class="divide-y">
          <li
            v-for="category in NOTIFICATION_CATEGORIES"
            :key="category"
            class="flex items-center gap-3 px-5 py-3"
          >
            <component
              :is="categoryLook(category).icon"
              class="size-4 shrink-0"
              :class="categoryLook(category).class"
            />
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium">{{ t(`notifications.category.${category}`) }}</span>
              <span class="block text-xs text-muted-foreground">
                {{ t(`notifications.categoryHint.${category}`) }}
              </span>
            </span>
            <Button
              :variant="muted.has(category) ? 'outline' : 'default'"
              size="sm"
              class="shrink-0"
              :disabled="saving"
              :aria-pressed="!muted.has(category)"
              @click="toggleCategory(category)"
            >
              {{ muted.has(category) ? t('notifications.off') : t('notifications.on') }}
            </Button>
          </li>
        </ul>
      </section>

      <!-- What the caller follows: the rule that adds things, then the things -->
      <section class="min-w-0 rounded-xl border bg-card">
        <div class="border-b px-5 py-3.5">
          <h2 class="font-display text-[15px] font-semibold tracking-tight">
            {{ t('notifications.watchingTitle') }}
          </h2>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ t('notifications.watchingHint') }}</p>
        </div>

        <ul class="divide-y">
          <li class="flex items-center gap-3 px-5 py-3">
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium">{{ t('notifications.autoWatchTitle') }}</span>
              <span class="block text-xs text-muted-foreground">{{ t('notifications.autoWatchHint') }}</span>
            </span>
            <Button
              :variant="prefs?.autoWatchOnComment ? 'default' : 'outline'"
              size="sm"
              class="shrink-0"
              :disabled="saving"
              :aria-pressed="!!prefs?.autoWatchOnComment"
              @click="save({ autoWatchOnComment: !prefs?.autoWatchOnComment })"
            >
              {{ prefs?.autoWatchOnComment ? t('notifications.on') : t('notifications.off') }}
            </Button>
          </li>

          <li
            v-if="watching.length === 0 && mutedSubjects.length === 0"
            class="px-5 py-4 text-sm text-muted-foreground"
          >
            {{ t('notifications.watchingEmpty') }}
          </li>

          <li
            v-for="entry in [...watching, ...mutedSubjects]"
            :key="`${entry.subjectType}:${entry.subjectId}`"
            class="flex items-center gap-3 px-5 py-3"
          >
            <component :is="entry.state === 'muted' ? Bell : Eye" class="size-4 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1">
              <RouterLink :to="linkFor(entry)" class="block truncate text-sm text-primary underline-offset-2 hover:underline">
                {{ t(`notifications.subject.${entry.subjectType}`) }} · {{ entry.subjectId.slice(0, 8) }}
              </RouterLink>
              <span class="block text-xs text-muted-foreground">
                {{ entry.state === 'muted' ? t('notifications.watch.muted') : t('notifications.watch.watching') }}
              </span>
            </span>
            <Button variant="ghost" size="sm" class="shrink-0" @click="unwatch(entry)">{{ t('notifications.forget') }}</Button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
