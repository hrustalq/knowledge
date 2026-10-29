import type { AssistantThreadSummary } from '@knowledge/contracts'

/**
 * What a chat is called on screen.
 *
 * The server names an untitled thread after its opening message, so a null
 * title normally means "nothing has been said yet" — but a thread created and
 * then answered in another tab can reach this list with a preview and no
 * title, and falling through to the preview keeps that row readable instead
 * of showing a third "New chat".
 */
export function threadLabel(thread: AssistantThreadSummary): string {
  return thread.title ?? thread.lastMessagePreview?.split('\n')[0]?.trim() ?? 'New chat'
}
