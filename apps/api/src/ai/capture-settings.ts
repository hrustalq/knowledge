import type { AiSettingsSource, CaptureSettings, CeilingSetting, OverrideSetting } from '@knowledge/contracts';

/** The ai_settings columns this reads; null means inherit. */
export interface CaptureSettingsRow {
  captureEnabled: boolean | null;
  capturePerKeyPerHour: number | null;
  capturePerWorkspacePerDay: number | null;
  captureDedupeThreshold: number | null;
  captureAmendThreshold: number | null;
  captureParentDocumentId: string | null;
}

/** The CAPTURE_* env block: ceilings for the switch and the limits, defaults for the thresholds. */
export interface CaptureEnv {
  enabled: boolean;
  perKeyPerHour: number;
  perWorkspacePerDay: number;
  dedupeThreshold: number;
  amendThreshold: number;
}

/**
 * Resolve a workspace's capture settings (issue #73). Pure, like
 * `resolveExternalAiActions`: the env switch and limits are ceilings — a
 * workspace may ask for less, never more, and `source` says `clamped` when the
 * ceiling won. The thresholds are plain overrides, except that the amend
 * threshold is held at or below the dedupe one, so a page close enough to be
 * a duplicate is always close enough to amend.
 */
export function resolveCaptureSettings(row: CaptureSettingsRow | null | undefined, env: CaptureEnv): CaptureSettings {
  const dedupeThreshold = override(row?.captureDedupeThreshold, env.dedupeThreshold);
  const amend = override(row?.captureAmendThreshold, env.amendThreshold);
  return {
    enabled: ceiling(row?.captureEnabled, env.enabled, (asked, cap) => asked && cap),
    perKeyPerHour: ceiling(row?.capturePerKeyPerHour, env.perKeyPerHour, Math.min),
    perWorkspacePerDay: ceiling(row?.capturePerWorkspacePerDay, env.perWorkspacePerDay, Math.min),
    dedupeThreshold,
    amendThreshold: { ...amend, effective: Math.min(amend.effective, dedupeThreshold.effective) },
    parentDocumentId: row?.captureParentDocumentId ?? null,
  };
}

function ceiling<T>(requested: T | null | undefined, cap: T, narrower: (asked: T, cap: T) => T): CeilingSetting<T> {
  const asked = requested ?? null;
  const effective = asked === null ? cap : narrower(asked, cap);
  const source: AiSettingsSource = asked === null ? 'env' : effective === asked ? 'db' : 'clamped';
  return { requested: asked, ceiling: cap, effective, source };
}

function override<T>(requested: T | null | undefined, fallback: T): OverrideSetting<T> {
  const asked = requested ?? null;
  return { requested: asked, effective: asked ?? fallback, source: asked === null ? 'env' : 'db' };
}
