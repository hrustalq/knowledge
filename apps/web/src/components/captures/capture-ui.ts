import type { Component } from 'vue'
import {
  BookA,
  CircleHelp,
  Lightbulb,
  ListChecks,
  MessageSquareQuote,
  Ruler,
  Signpost,
  Waypoints,
} from 'lucide-vue-next'
import { CHAT_PLATFORM_NAMES } from '@knowledge/contracts'
import type { CaptureClient, CaptureInfo, CaptureKind, CaptureSession, CaptureStatus, ChatPlatformKind } from '@knowledge/contracts'

/**
 * The captures inbox's vocabulary (issue #73), shared by the inbox rows, the
 * merge-request provenance strip and the assistant's save action.
 *
 * Labels are message keys, resolved at the render site — a module-scope map
 * has no `t` (the MR_PEOPLE_FIELDS shape).
 */

/**
 * One drawn mark per kind. A gotcha is a signpost, not a warning triangle:
 * amber and the alert glyph belong to the indexing lifecycle and to callouts,
 * and a gotcha is something learned, not something wrong.
 */
export const CAPTURE_KIND_ICON: Record<CaptureKind, Component> = {
  decision: Lightbulb,
  gotcha: Signpost,
  convention: Ruler,
  howto: ListChecks,
  glossary: BookA,
  relation: Waypoints,
  answer: MessageSquareQuote,
}

export function captureKindIcon(kind: string): Component {
  return CAPTURE_KIND_ICON[kind as CaptureKind] ?? CircleHelp
}

/**
 * The tabs, each one a stored status. `merged` and `closed` are not tabs: they
 * are the merge request's outcome, read onto a `proposed` row, so they show as
 * that row's badge under Proposed rather than as a place a row moves to.
 */
export const CAPTURE_TABS = ['staged', 'proposed', 'duplicate', 'rejected', 'failed'] as const satisfies readonly CaptureStatus[]
export type CaptureTab = (typeof CAPTURE_TABS)[number]

/** The client's own name, never translated — "Claude Code" is a product. `assistant` and `other` are ours. */
const CLIENT_NAMES: Partial<Record<CaptureClient, string>> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
}

/** A client name, or the message key for the ones that are words rather than products. */
export function clientLabel(client: string, t: (key: string) => string): string {
  const word = client === 'assistant' || client === 'chat' ? client : 'other'
  return CLIENT_NAMES[client as CaptureClient] ?? t(`captures.client.${word}`)
}

/** A chat platform's product name (#82). */
export function platformName(platform: string): string {
  return CHAT_PLATFORM_NAMES[platform as ChatPlatformKind] ?? platform
}

/** A commit as people quote one: the first seven characters. */
export function shortCommit(commit: string | undefined): string | undefined {
  return commit ? commit.slice(0, 7) : undefined
}

/**
 * `owner/repo@abc1234` — where the session was, in the form a reader can paste
 * into a terminal. A remote URL is cut down to its last two path segments.
 */
export function repoAtCommit(session: CaptureSession): string | null {
  const repo = session.repo?.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).slice(-2).join('/')
  const commit = shortCommit(session.commit)
  if (!repo && !commit) return null
  return commit ? `${repo ?? ''}@${commit}` : repo!
}

/**
 * Whether the inbox can decide this row itself. Only a staged term: page and
 * relation captures are decided on their merge request (the API answers 409
 * `capture-not-approvable`), so the row links there instead of offering a
 * button that would only ever fail.
 */
export function isApprovable(capture: CaptureInfo): boolean {
  return capture.state === 'staged' && capture.outcome === 'glossary'
}

/** Reject applies to any staged row; a proposed one is turned down by closing its merge request. */
export function isRejectable(capture: CaptureInfo): boolean {
  return capture.state === 'staged'
}

/** Cosine as a reader can compare it at a glance: two decimals, never a percentage that implies a probability. */
export function formatScore(score: number): string {
  return score.toFixed(2)
}
