import { CHAT_COMMANDS, type ChatCommandName } from '@knowledge/contracts'

/** What the composer can offer after `/` (#1249), in catalogue order. */
export const COMPOSER_COMMANDS = (Object.keys(CHAT_COMMANDS) as ChatCommandName[]).filter((name) =>
  (CHAT_COMMANDS[name].surfaces as readonly string[]).includes('web'),
)

/** Commands that take a value, picked from a list after the name. */
export const ARG_COMMANDS: ReadonlySet<ChatCommandName> = new Set(['model', 'agent-key', 'skill', 'page'])

export type SlashState =
  | { step: 'command'; matches: ChatCommandName[] }
  | { step: 'arg'; command: ChatCommandName; query: string }
  | null

/**
 * The draft as the command menu reads it. `/mo` lists the offered commands
 * starting with `mo`, an exact name first; `/model gp` lists models matching
 * `gp`. Anything else (no leading slash, a second line, a name nothing starts
 * with, text after a command that takes none) is null: the draft is sent as typed.
 */
export function slashState(draft: string, offered: readonly ChatCommandName[]): SlashState {
  const m = /^\/([a-z-]*)(?: (.*))?$/.exec(draft)
  if (!m) return null
  const name = m[1] ?? ''
  const arg = m[2]
  const exact = offered.find((c) => c === name)
  if (exact && arg !== undefined) {
    if (ARG_COMMANDS.has(exact)) return { step: 'arg', command: exact, query: arg }
    return arg.trim() ? null : { step: 'command', matches: [exact] }
  }
  if (arg !== undefined) return null
  const matches = offered.filter((c) => c.startsWith(name)).sort((a, b) => Number(b === name) - Number(a === name))
  return matches.length ? { step: 'command', matches } : null
}
