import type { AnalyticsSettingsValues } from '@knowledge/contracts';

/** A workspace's own analytics columns on `workspace_settings`; null inherits. */
export interface AnalyticsSettingsRow {
  analyticsEnabled: boolean | null;
  analyticsRetentionDays: number | null;
}

/**
 * What applies (#79): the env is a ceiling, so a workspace may turn recording
 * off and keep rows for less, never turn it on past the env or keep them
 * longer. The settings routes read it; the recorder checks the env before the
 * row, and the retention sweeper spells the same clamp in SQL.
 */
export function effectiveAnalytics(
  ceiling: AnalyticsSettingsValues,
  row: AnalyticsSettingsRow | null | undefined,
): AnalyticsSettingsValues {
  return {
    enabled: ceiling.enabled && (row?.analyticsEnabled ?? true),
    retentionDays: Math.min(row?.analyticsRetentionDays ?? ceiling.retentionDays, ceiling.retentionDays),
  };
}
