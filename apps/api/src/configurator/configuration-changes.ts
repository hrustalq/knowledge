import { z } from 'zod';
import {
  AGENT_SCHEDULE_KINDS,
  AGENT_SCHEDULE_TIME_PATTERN,
  AGENT_TRIGGER_EVENTS,
  CONFIGURATION_CHANGE_KINDS,
  DRIFT_CHECK_MODES,
  isValidTimezone,
  type ConfigurationChangeSpec,
} from '@knowledge/contracts';

/**
 * The one parse of a proposed change (#1250): what the model handed
 * `propose_configuration`, narrowed into a `ConfigurationChangeSpec`. Lives
 * API-side because `@knowledge/contracts` carries no runtime dependency (the
 * blueprint schema's reason). Shape only — whether the agent, project or
 * connector exists and what is there today is the service's question.
 */

const note = z.string().trim().max(2_000).nullish().transform((v) => v || null);
const reason = z.string().trim().max(300).default('');
const uuid = z.uuid();
const timezone = z.string().max(64).refine(isValidTimezone, 'not an IANA timezone');

const schedule = z
  .strictObject({
    kind: z.literal('agent-schedule'),
    agentKey: z.string().min(1).max(80),
    scheduleKind: z.enum(AGENT_SCHEDULE_KINDS),
    scheduleMinutes: z.number().int().min(15).max(20_160).nullish(), // UpdateAiAgentDto's bounds
    scheduleTime: z.string().regex(AGENT_SCHEDULE_TIME_PATTERN, 'HH:MM').nullish(),
    scheduleWeekdays: z.array(z.number().int().min(0).max(6)).max(7).nullish(),
    scheduleTimezone: timezone.nullish(),
    note,
    reason,
  })
  // The rules `AiAgentsService.validateSchedule` applies to an enabled schedule,
  // checked now: a proposal that could never be switched on is not one.
  .refine((s) => s.scheduleKind !== 'interval' || !!s.scheduleMinutes, 'an interval schedule needs scheduleMinutes')
  .refine((s) => s.scheduleKind === 'interval' || !!s.scheduleTime, 'a daily or weekly schedule needs scheduleTime')
  .refine((s) => s.scheduleKind !== 'weekly' || !!s.scheduleWeekdays?.length, 'a weekly schedule needs scheduleWeekdays');

const trigger = z.strictObject({
  kind: z.literal('agent-trigger'),
  agentKey: z.string().min(1).max(80),
  event: z.enum(AGENT_TRIGGER_EVENTS),
  projectId: uuid.nullish(),
  categories: z.array(z.string().trim().min(1).max(64)).max(20).nullish(),
  connectorIds: z.array(uuid).max(20).nullish(),
  branch: z.string().trim().min(1).max(200).nullish(),
  labels: z.array(z.string().trim().min(1).max(50)).max(20).nullish(),
  note,
  reason,
});

const drift = z.strictObject({
  kind: z.literal('connector-drift-check'),
  connectorId: uuid,
  mode: z.enum(DRIFT_CHECK_MODES),
  reason,
});

const change = z.discriminatedUnion('kind', [schedule, trigger, drift]);

export interface ReadChange {
  spec: ConfigurationChangeSpec;
  reason: string;
}

/** A change the parse refused, reported back to the model so it can fix it. */
export interface DroppedChange {
  index: number;
  error: string;
}

/** At most this many changes in one proposal. A reviewer reads every one. */
export const MAX_CHANGES = 20;

/**
 * Read the model's change list. Each item is parsed on its own, so one bad
 * change drops that change, not the proposal. `timezone` is the requester's
 * zone, used when a time-of-day schedule names none.
 */
export function readChanges(raw: unknown, timezone: string | null): { changes: ReadChange[]; dropped: DroppedChange[] } {
  const items = Array.isArray(raw) ? raw : [];
  const changes: ReadChange[] = [];
  const dropped: DroppedChange[] = [];
  items.forEach((item, index) => {
    if (changes.length >= MAX_CHANGES) {
      dropped.push({ index, error: `at most ${MAX_CHANGES} changes` });
      return;
    }
    const parsed = change.safeParse(item);
    if (!parsed.success) {
      const kind = (item as { kind?: unknown })?.kind;
      dropped.push({
        index,
        error: (CONFIGURATION_CHANGE_KINDS as readonly unknown[]).includes(kind)
          ? parsed.error.issues.map((i) => `${i.path.join('.') || kind}: ${i.message}`).join('; ')
          : `kind must be one of ${CONFIGURATION_CHANGE_KINDS.join(', ')}`,
      });
      return;
    }
    changes.push({ spec: toSpec(parsed.data, timezone), reason: parsed.data.reason });
  });
  return { changes, dropped };
}

function toSpec(c: z.infer<typeof change>, timezone: string | null): ConfigurationChangeSpec {
  switch (c.kind) {
    case 'agent-schedule': {
      const interval = c.scheduleKind === 'interval';
      return {
        kind: c.kind,
        agentKey: c.agentKey,
        scheduleKind: c.scheduleKind,
        // Only the fields the kind reads, so the diff never shows a stray value.
        scheduleMinutes: interval ? (c.scheduleMinutes ?? null) : null,
        scheduleTime: interval ? null : (c.scheduleTime ?? null),
        scheduleWeekdays: c.scheduleKind === 'weekly' ? [...new Set(c.scheduleWeekdays)].sort((a, b) => a - b) : null,
        scheduleTimezone: interval ? null : (c.scheduleTimezone ?? timezone),
        scheduleNote: c.note,
      };
    }
    case 'agent-trigger':
      return {
        kind: c.kind,
        agentKey: c.agentKey,
        event: c.event,
        projectId: c.projectId ?? null,
        // Which fields the event keeps is `mergeFilter`'s rule, applied when the change is assessed.
        filter: {
          ...(c.categories?.length ? { categories: c.categories } : {}),
          ...(c.connectorIds?.length ? { connectorIds: c.connectorIds } : {}),
          ...(c.branch ? { branch: c.branch } : {}),
          ...(c.labels?.length ? { labels: c.labels } : {}),
        },
        note: c.note,
      };
    case 'connector-drift-check':
      return { kind: c.kind, connectorId: c.connectorId, mode: c.mode };
  }
}
