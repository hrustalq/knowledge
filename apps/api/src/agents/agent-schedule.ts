import type { AiAgent } from '@prisma/client';
import {
  AGENT_SCHEDULE_KINDS,
  nextScheduledRun,
  type AgentScheduleKind,
  type AgentScheduleSpec,
  type AgentScheduleState,
} from '@knowledge/contracts';

type ScheduleRow = Pick<
  AiAgent,
  | 'scheduleKind'
  | 'scheduleMinutes'
  | 'scheduleTime'
  | 'scheduleWeekdays'
  | 'scheduleTimezone'
  | 'lastRunAt'
  | 'scheduleChangedAt'
>;

/**
 * An `ai_agents` row read as the schedule contracts' predicate takes (#70).
 * The one translation of the columns, shared by the sweeper and the summary,
 * so "when does this run" has one answer on both sides of the API.
 */
export function scheduleOf(row: ScheduleRow): { spec: AgentScheduleSpec; state: AgentScheduleState } {
  return {
    spec: {
      kind: scheduleKindOf(row.scheduleKind),
      minutes: row.scheduleMinutes,
      time: row.scheduleTime,
      weekdays: weekdaysOf(row.scheduleWeekdays),
      timezone: row.scheduleTimezone,
    },
    state: { lastRunAt: row.lastRunAt, changedAt: row.scheduleChangedAt },
  };
}

/** The next run of an enabled schedule, or null. */
export function nextRunOf(row: ScheduleRow & Pick<AiAgent, 'scheduleEnabled'>, now = new Date()): Date | null {
  if (!row.scheduleEnabled) return null;
  const { spec, state } = scheduleOf(row);
  return nextScheduledRun(spec, state, now);
}

/** The column is free text; a value outside the vocabulary reads as the default. */
export function scheduleKindOf(value: string | null): AgentScheduleKind {
  return (AGENT_SCHEDULE_KINDS as readonly string[]).includes(value ?? '') ? (value as AgentScheduleKind) : 'interval';
}

export function weekdaysOf(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6);
}
