import { PLAUD_RULE_DEFAULTS, type PlaudRules } from '@knowledge/contracts';
import type { PlaudRecording } from './plaud.service.js';

/** How far back a sweep lists. A recording can reach Plaud days after it was made; older ones are not looked for again. */
// ponytail: a fixed 14-day window instead of a cursor; a device synced later than that is missed until `since` is moved back by hand.
export const LOOKBACK_DAYS = 14;

type Effective = Required<Pick<PlaudRules, 'since' | 'minSeconds' | 'confirm'>> & PlaudRules;

/** The rules with their defaults filled in. `since` defaults to the day the settings were first saved: no backlog. */
export function effectiveRules(rules: PlaudRules, savedAt: Date): Effective {
  return { ...PLAUD_RULE_DEFAULTS, since: savedAt.toISOString().slice(0, 10), ...rules };
}

/** Whether auto-import picks this recording (#864). Pure: the one place the rules are read. */
export function picks(rules: Effective, recording: PlaudRecording): boolean {
  // Plaud's times carry no zone; comparing the date part keeps `since` inclusive whatever the zone.
  if (recording.startAt && recording.startAt.slice(0, 10) < rules.since) return false;
  if (recording.durationSeconds < rules.minSeconds) return false;
  const name = recording.name.toLowerCase();
  if (rules.nameIncludes?.trim() && !name.includes(rules.nameIncludes.trim().toLowerCase())) return false;
  if (rules.nameExcludes?.trim() && name.includes(rules.nameExcludes.trim().toLowerCase())) return false;
  if (rules.serial?.trim() && recording.serial !== rules.serial.trim()) return false;
  return true;
}

/** The first day a sweep asks Plaud for: `since`, but never further back than the lookback. */
export function listFrom(rules: Effective, now: Date): string {
  const floor = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  return rules.since > floor ? rules.since : floor;
}
