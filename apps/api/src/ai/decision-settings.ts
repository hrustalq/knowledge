import {
  DECISION_DEFAULT_MODEL,
  DECISION_SITES,
  DECISION_THRESHOLDS,
  type DecisionSettings,
  type DecisionSite,
} from '@knowledge/contracts';

/** The ai_settings columns this reads; null means the code default. */
export interface DecisionSettingsRow {
  decisionArbiterThreshold: number | null;
  decisionCitationThreshold: number | null;
  decisionHarvestThreshold: number | null;
  decisionTunedModel: string | null;
}

export const DECISION_THRESHOLD_COLUMN = {
  arbiter: 'decisionArbiterThreshold',
  citation: 'decisionCitationThreshold',
  harvest: 'decisionHarvestThreshold',
} as const satisfies Record<DecisionSite, keyof DecisionSettingsRow>;

/**
 * A workspace's decision thresholds (#530): each a sparse override of
 * DECISION_THRESHOLDS. Pure, like `resolveCaptureSettings`. `available` is the
 * DECISION_PROVIDER ceiling, reported so the settings screen can say a saved
 * route is not honoured rather than clamp it silently.
 */
export function resolveDecisionSettings(row: DecisionSettingsRow | null | undefined, available: boolean): DecisionSettings {
  const thresholds = {} as DecisionSettings['thresholds'];
  for (const site of DECISION_SITES) {
    const requested = row?.[DECISION_THRESHOLD_COLUMN[site]] ?? null;
    thresholds[site] = { requested, effective: requested ?? DECISION_THRESHOLDS[site] };
  }
  return { available, thresholds, tunedOn: row?.decisionTunedModel ?? DECISION_DEFAULT_MODEL };
}
