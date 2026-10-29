import { defineStore } from 'pinia'
import type {
  NotificationCategory,
  NotificationEntry,
  NotificationUnreadCountResponse,
} from '@knowledge/contracts'
import { api, apiQueryOptions, bindStoreQuery, fetchApi } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'

/**
 * The caller's inbox (docs/features/22).
 *
 * A store rather than a per-component query because two surfaces read the same
 * answer and one of them is always mounted: the topbar bell needs the unread
 * count on every page, and the panel needs the newest rows the moment it opens.
 * Fetching per component would mean the badge refetching on every navigation.
 *
 * Scoped to the workspace, not the project: you are told about a page because
 * you watch it, and switching project does not stop that being true. There is
 * deliberately no `rescope()` here as the glossary and workflow rosters have —
 * those follow the project, and switching workspace reloads the page outright
 * (see stores/workspaces.ts), so this store is rebuilt from nothing anyway.
 */
export const useNotificationsStore = defineStore('notifications', {
  state: () => ({
    entries: [] as NotificationEntry[],
    unreadCount: 0,
    counts: emptyCounts(),
    loaded: false,
    /**
     * Why the first page failed, or null. Kept apart from `entries` so a failed
     * load is never drawn as an empty inbox: "No notifications" tells the reader
     * nothing is waiting, when all we know is that we could not ask.
     */
    error: null as unknown,
    /** In-flight fetch, so the bell and the panel share one request. */
    pending: null as Promise<void> | null,
    nextCursor: null as string | null,
  }),
  getters: {
    unread(state): NotificationEntry[] {
      return state.entries.filter((e) => e.readAt === null)
    },
    hasUnread(state): boolean {
      return state.unreadCount > 0
    },
  },
  actions: {
    async ensureLoaded() {
      if (this.loaded) return
      if (this.pending) return this.pending
      this.pending = this.fetchPage().finally(() => (this.pending = null))
      return this.pending
    },

    /**
     * The badge alone.
     *
     * Separate from `ensureLoaded` because it is what a live event triggers, and
     * refetching the whole panel on every notification would throw away the
     * reader's scroll position in a list they may be part-way through.
     */
    async refreshCount() {
      if (import.meta.env.SSR) return
      try {
        // Bound, so the `notification.created` live rule re-reads it too.
        await bindStoreQuery<NotificationUnreadCountResponse>(
          this,
          'count',
          this.queryClient,
          apiQueryOptions('/v1/notifications/unread-count', { query: { workspaceId: getWorkspaceId() } }),
          (res) => {
            this.unreadCount = res.count
            this.counts = { ...emptyCounts(), ...res.counts }
          },
          { fresh: true },
        )
      } catch {
        // A badge that fails to load is not worth telling anybody about.
      }
    },

    async fetchPage(cursor?: string) {
      try {
        const res = await fetchApi(
          this.queryClient,
          '/v1/notifications',
          { query: { workspaceId: getWorkspaceId(), limit: 20, ...(cursor ? { cursor } : {}) } },
          { fresh: true },
        )
        this.entries = cursor ? [...this.entries, ...res.entries] : res.entries
        this.nextCursor = res.nextCursor
        this.unreadCount = res.unreadCount
        this.counts = { ...emptyCounts(), ...res.counts }
        this.error = null
        this.loaded = true
      } catch (error) {
        // A failed next page keeps the rows already on screen; the button that
        // asked for it is still there to ask again.
        if (!cursor) {
          this.entries = []
          this.error = error
        }
        this.loaded = true
      }
    },

    async loadMore() {
      if (this.nextCursor) await this.fetchPage(this.nextCursor)
    },

    async refresh() {
      this.loaded = false
      await this.ensureLoaded()
    },

    /**
     * Mark rows read, locally first.
     *
     * The row is already on screen and the reader has just clicked it, so
     * waiting for a round trip to grey it out would make the app feel like it
     * had not registered the click. A failed request is reconciled by the next
     * `refreshCount`, which a live event or a panel open will trigger anyway.
     */
    async markRead(ids: string[]) {
      const pending = ids.filter((id) => this.entries.some((e) => e.id === id && e.readAt === null))
      if (pending.length === 0) return
      const at = new Date().toISOString()
      for (const entry of this.entries) {
        if (pending.includes(entry.id)) entry.readAt = at
      }
      this.unreadCount = Math.max(0, this.unreadCount - pending.length)
      try {
        await api.post('/v1/notifications/read', { body: { workspaceId: getWorkspaceId(), ids: pending } })
      } finally {
        await this.refreshCount()
      }
    },

    async markAllRead(category?: NotificationCategory) {
      const at = new Date().toISOString()
      for (const entry of this.entries) {
        if (entry.readAt === null && (!category || entry.category === category)) entry.readAt = at
      }
      try {
        await api.post('/v1/notifications/read', { body: { workspaceId: getWorkspaceId(), all: true, category } })
      } finally {
        await this.refreshCount()
      }
    },
  },
})

function emptyCounts(): Record<NotificationCategory, number> {
  return { mention: 0, review: 0, comment: 0, document: 0, verification: 0, access: 0, job: 0 }
}
