import type { Component } from 'vue'
import {
  AtSign,
  FileText,
  GitPullRequestArrow,
  MessageSquare,
  Play,
  UserPlus,
} from 'lucide-vue-next'
import type { NotificationCategory, NotificationEntry } from '@knowledge/contracts'
import { NOTIFICATION_CATEGORIES } from '@knowledge/contracts'

/**
 * How an inbox row presents itself (docs/features/22).
 *
 * `label` values are message keys, not text: this is a module and cannot call
 * useI18n() — the `mrIcon` convention (docs/features/18).
 */
export interface NotificationLook {
  icon: Component
  /** Tailwind colour class for the icon. */
  class: string
  /** i18n key for the category name. */
  label: string
}

const LOOKS: Record<NotificationCategory, NotificationLook> = {
  mention: { icon: AtSign, class: 'text-amber-500', label: 'notifications.category.mention' },
  review: { icon: GitPullRequestArrow, class: 'text-emerald-500', label: 'notifications.category.review' },
  comment: { icon: MessageSquare, class: 'text-sky-500', label: 'notifications.category.comment' },
  document: { icon: FileText, class: 'text-violet-500', label: 'notifications.category.document' },
  job: { icon: Play, class: 'text-muted-foreground', label: 'notifications.category.job' },
}

/** Reasons worth an icon of their own, because they are addressed at a person. */
const REASON_LOOKS: Record<string, NotificationLook> = {
  assigned: { icon: UserPlus, class: 'text-emerald-500', label: 'notifications.reason.assigned' },
}

/** The look of a category itself, for a legend or a settings list. */
export function categoryLook(category: NotificationCategory): NotificationLook {
  return LOOKS[category]
}

export function notificationLook(entry: NotificationEntry): NotificationLook {
  const byReason = REASON_LOOKS[entry.reason]
  if (byReason) return byReason
  return entry.category ? LOOKS[entry.category] : LOOKS.job
}

/** The tab strip: every category, plus the two pseudo-tabs. */
export const NOTIFICATION_TABS = [
  { key: 'all', label: 'notifications.tab.all' },
  { key: 'unread', label: 'notifications.tab.unread' },
  ...NOTIFICATION_CATEGORIES.map((c) => ({ key: c, label: LOOKS[c].label })),
] as const
export type NotificationTab = (typeof NOTIFICATION_TABS)[number]['key']

/**
 * Where a row goes when clicked.
 *
 * Derived rather than stored: a notification outlives the routes that rendered
 * it, and a URL frozen into the database in September is a dead link the first
 * time a page moves. The subject decides — a review row opens the merge request
 * on the discussion that prompted it, everything else opens the page.
 */
export function notificationLink(entry: NotificationEntry): string | null {
  if (entry.subjectType === 'merge-request' && entry.subjectId) {
    const thread = typeof entry.metadata.threadId === 'string' ? entry.metadata.threadId : null
    return `/merge-requests/${entry.subjectId}${thread ? `?thread=${thread}` : ''}`
  }
  if (entry.type.startsWith('workflow-')) {
    return entry.subjectId ? `/workflows/${entry.subjectId}` : '/workflows'
  }
  if (entry.type.startsWith('agent.run.')) return '/settings/ai?tab=runs'
  if (entry.type.startsWith('connector.run.')) return '/settings/connectors?tab=runs'
  if (entry.type.startsWith('import.')) return entry.documentId ? `/documents/${entry.documentId}` : '/upload'
  if (entry.documentId) return `/documents/${entry.documentId}`
  return null
}

/**
 * The message key describing what happened.
 *
 * Keyed on the event type so an unknown one can fall back to itself via
 * `labelFor` rather than rendering a raw key at the reader (the `category`
 * precedent in lib/labels.ts).
 */
export function notificationMessageKey(entry: NotificationEntry): string {
  // A directed reason describes the row better than the event that carried it:
  // "mentioned you" beats "commented", and an assignment arrives on an event
  // type that means nothing on its own.
  if (entry.reason === 'mention') return 'notifications.event.mention'
  if (entry.reason === 'assigned') return 'notifications.event.assigned'
  if (entry.reason === 'review-requested') return 'notifications.event.reviewRequested'
  return `notifications.event.${entry.type}`
}
