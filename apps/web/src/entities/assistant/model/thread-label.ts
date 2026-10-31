import type { AssistantThreadSummary } from '@knowledge/contracts'

/**
 * What a chat is called on screen.
 *
 * The server names an untitled thread after its opening message, so a null
 * title normally means "nothing has been said yet" — but a thread created and
 * then answered in another tab can reach this list with a preview and no
 * title, and falling through to the preview keeps that row readable.
 *
 * `untitled` is the caller's translated "Untitled chat" (#651). It used to be
 * a hard-coded English "New chat" — the New chat button's own words, so an
 * empty row read as a second button.
 */
export function threadLabel(thread: AssistantThreadSummary, untitled: string): string {
  return thread.title ?? (thread.lastMessagePreview?.split('\n')[0]?.trim() || untitled)
}
