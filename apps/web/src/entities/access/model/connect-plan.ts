/**
 * The Connect AI wizard's decisions (#1225), pure so a spec can pin them.
 *
 * The person answers in their own terms (who they are, what the agent will
 * do); this turns that into what the server understands: a key scope, the
 * toolsets worth limiting a key to, and which steps of the wizard apply.
 * Every derived value is a default, so the wizard keeps an explicit override
 * (`null` = follow the answers) and a later answer never undoes one.
 */
import type { ApiKeyScope, McpToolset } from '@knowledge/contracts'

export const CONNECT_ROLES = ['developer', 'writer', 'reviewer', 'qa', 'explorer'] as const
export type ConnectRole = (typeof CONNECT_ROLES)[number]

export const CONNECT_WORKFLOWS = ['ask', 'code', 'author', 'review', 'capture', 'qa'] as const
export type ConnectWorkflow = (typeof CONNECT_WORKFLOWS)[number]

export const CONNECT_STEPS = ['role', 'client', 'workflow', 'key', 'preferences', 'configure', 'skill', 'verify'] as const
export type ConnectStep = (typeof CONNECT_STEPS)[number]

const ROLE_WORKFLOWS: Record<ConnectRole, ConnectWorkflow[]> = {
  developer: ['ask', 'code', 'capture'],
  writer: ['ask', 'author'],
  reviewer: ['ask', 'review'],
  qa: ['ask', 'qa'],
  explorer: ['ask'],
}

/** Besides `core`, which the server always adds to a list. */
const WORKFLOW_TOOLSETS: Record<ConnectWorkflow, McpToolset[]> = {
  ask: ['graph'],
  code: ['code', 'api-reference', 'graph'],
  author: ['authoring', 'quality', 'drafts'],
  review: ['review', 'quality', 'conflicts'],
  capture: ['captures'],
  qa: ['qa', 'api-reference'],
}

/** Workflows that write: opening a merge request, running a suite from the platform. */
const WRITES: ConnectWorkflow[] = ['author', 'review', 'qa']

export function workflowsFor(role: ConnectRole): ConnectWorkflow[] {
  return [...ROLE_WORKFLOWS[role]]
}

/** The narrowest scope that can do every chosen workflow. */
export function scopeFor(workflows: readonly ConnectWorkflow[]): ApiKeyScope {
  if (workflows.some((w) => WRITES.includes(w))) return 'write'
  return workflows.includes('capture') ? 'capture' : 'read'
}

/** The toolsets the chosen workflows use, in catalogue order of first mention. */
export function toolsetsFor(workflows: readonly ConnectWorkflow[]): McpToolset[] {
  return [...new Set(workflows.flatMap((w) => WORKFLOW_TOOLSETS[w]))]
}

export interface StepInput {
  /** The server takes API keys (AUTH_MODE=api-key); dev mode has none to create. */
  needsKey: boolean
  /** The chosen client, once there is one: can its skill install as a stack, and does it have a capture kit. */
  client: { stackable: boolean; captureKit: string | null } | null
  workflows: readonly ConnectWorkflow[]
}

/**
 * The steps that apply, in order. Only the key step depends on the server, so
 * the count never moves under the person while they answer: Preferences stays
 * even when there is nothing to choose, and says so (`hasPreferences`).
 */
export function stepsFor({ needsKey }: { needsKey: boolean }): ConnectStep[] {
  return CONNECT_STEPS.filter((step) => step !== 'key' || needsKey)
}

/** Whether Preferences has anything to ask for this client and these workflows. */
export function hasPreferences({ client, workflows }: Omit<StepInput, 'needsKey'>): boolean {
  return !!client && (client.stackable || (!!client.captureKit && workflows.includes('capture')))
}
