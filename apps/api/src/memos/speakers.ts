import type { MemoSegment, MemoSpeaker } from '@knowledge/contracts';

/**
 * Matching a memo's speakers to people (#880). Pure: the rules are here so
 * the memo read, the write that confirms a match and the secretary's prompt
 * cannot disagree about who a label is.
 *
 * A match is the uploader's act and is stored only on their memo
 * (`memos.speakers`). What is "remembered" is derived on read from their
 * earlier memos in the same project, never stored a second time.
 */

/** `{ label: userId | null }`: null is "I looked, this is nobody here", which also silences a remembered match. */
export type SpeakerChoices = Record<string, string | null>;

/**
 * A voice this server numbered (`error.memo.speaker`, en and ru). "Speaker 1"
 * in one recording is not "Speaker 1" in the next, so such a label is never
 * remembered or guessed from a name.
 */
const NUMBERED_VOICE = /^(Speaker|Участник) \d+$/;
export const isNumberedVoice = (label: string): boolean => NUMBERED_VOICE.test(label);

/** The labels a transcript uses, in the order they first speak. */
export function speakerLabels(segments: readonly MemoSegment[]): string[] {
  return [...new Set(segments.flatMap((s) => (s.speaker ? [s.speaker] : [])))];
}

export function readChoices(value: unknown): SpeakerChoices {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => v === null || typeof v === 'string'),
  ) as SpeakerChoices;
}

export interface SpeakerInput {
  labels: readonly string[];
  /** This memo's own choices. */
  chosen: SpeakerChoices;
  /** The uploader's earlier memos in the same project, newest first. */
  earlier: readonly SpeakerChoices[];
  /** Who may be matched at all: the workspace's members, by id. */
  members: ReadonlyMap<string, string>;
  /** Triage's guesses from what was said, `{ label: userId }`: only ever a suggestion. */
  guessed?: Readonly<Record<string, string>>;
}

/**
 * Each label with who it is. `userId` is a match that holds (chosen here, or
 * remembered from the newest earlier memo that says); `suggestedUserId` is a
 * guess from the label itself, shown as a guess and used for nothing until
 * the uploader confirms it. A user who is no longer a member is dropped from
 * all three.
 */
export function resolveSpeakers(input: SpeakerInput): MemoSpeaker[] {
  const member = (id: string | null | undefined) => (id && input.members.has(id) ? id : null);
  return input.labels.map((label) => {
    if (label in input.chosen) return { label, userId: member(input.chosen[label]), source: 'confirmed', suggestedUserId: null };
    const guessed = member(input.guessed?.[label]);
    // A numbered voice is never remembered or read as a name; what was said on this recording can still point at someone.
    if (isNumberedVoice(label)) return { label, userId: null, source: null, suggestedUserId: guessed };
    const before = input.earlier.find((choices) => label in choices);
    const remembered = member(before?.[label]);
    if (remembered) return { label, userId: remembered, source: 'remembered', suggestedUserId: null };
    return { label, userId: null, source: null, suggestedUserId: byName(label, input.members) ?? guessed };
  });
}

/** One member whose name is the label, or whose first name is and nobody else's: an ambiguous name suggests nobody. */
function byName(label: string, members: ReadonlyMap<string, string>): string | null {
  const wanted = fold(label);
  if (!wanted) return null;
  const hits = (test: (name: string) => boolean) => [...members].filter(([, name]) => test(fold(name))).map(([id]) => id);
  const exact = hits((name) => name === wanted);
  if (exact.length === 1) return exact[0]!;
  const first = hits((name) => name.split(' ')[0] === wanted);
  return first.length === 1 ? first[0]! : null;
}
const fold = (text: string) => text.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');

/** What the secretary is told: only matches that hold, as names. */
export function identifiedSpeakers(speakers: readonly MemoSpeaker[], members: ReadonlyMap<string, string>): Array<{ label: string; name: string }> {
  return speakers.flatMap((s) => (s.userId && members.has(s.userId) ? [{ label: s.label, name: members.get(s.userId)!.slice(0, 80) }] : []));
}

/** The reads `resolveSpeakers` needs, shared by the API's memo read and the worker's secretary run. */
export async function loadSpeakers(
  prisma: {
    memo: { findMany(args: object): Promise<Array<{ speakers: unknown }>> };
    workspaceMember: { findMany(args: object): Promise<Array<{ userId: string }>> };
    user: { findMany(args: object): Promise<Array<{ id: string; displayName: string }>> };
  },
  memo: { id: string; workspaceId: string; projectId: string; createdBy: string; speakers: unknown; transcript: unknown; triage?: unknown },
): Promise<{ speakers: MemoSpeaker[]; members: Map<string, string> }> {
  const labels = speakerLabels(Array.isArray(memo.transcript) ? (memo.transcript as MemoSegment[]) : []);
  if (!labels.length) return { speakers: [], members: new Map() };
  const [earlier, rows] = await Promise.all([
    prisma.memo.findMany({
      where: { workspaceId: memo.workspaceId, projectId: memo.projectId, createdBy: memo.createdBy, id: { not: memo.id }, NOT: { speakers: { equals: null } } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { speakers: true },
    }),
    prisma.workspaceMember.findMany({ where: { workspaceId: memo.workspaceId }, select: { userId: true }, take: 2000 }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, displayName: true } });
  const members = new Map(users.map((u) => [u.id, u.displayName]));
  return {
    speakers: resolveSpeakers({
      labels,
      chosen: readChoices(memo.speakers),
      earlier: earlier.map((m) => readChoices(m.speakers)),
      members,
      guessed: readChoices((memo.triage as { speakers?: unknown } | null)?.speakers) as Record<string, string>,
    }),
    members,
  };
}
