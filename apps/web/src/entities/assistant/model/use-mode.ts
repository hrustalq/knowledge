import { useStorage } from '@vueuse/core'
import type { AssistantChatMode } from '@knowledge/contracts'

/**
 * Ask vs Agent, shared by everything that can change it.
 *
 * It started as composer-local state, which was fine while the composer's
 * toggle was the only way to set it. It is not: a mode-switch prompt in the
 * transcript flips it too, and two copies of "which mode is this chat in"
 * would disagree the moment either moved. One ref, persisted the way it
 * always was.
 *
 * Module-level state is safe here despite SSR: `useStorage` never reads
 * localStorage on the server, so the server-side ref stays at its default for
 * every request and nothing can leak between them.
 */
export const assistantMode = useStorage<AssistantChatMode>('kn_assistant_mode', 'ask')

/**
 * The agents the server picks by mode (researcher for Ask, author for Agent).
 * The agent picker and `/agent-key` offer only the workspace's own beside them.
 */
export const MODE_AGENT_KEYS: ReadonlySet<string> = new Set(['researcher', 'author'])
