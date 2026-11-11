// Memos (#551, docs/features/68): a recording uploaded for transcription,
// private to its uploader, whose analysis proposes merge requests.

/** What an upload may be. The extension decides; the content type is the fallback. */
export const MEMO_FORMATS: ReadonlyArray<{ extension: string; contentTypes: readonly string[] }> = [
  { extension: '.mp3', contentTypes: ['audio/mpeg', 'audio/mp3'] },
  { extension: '.m4a', contentTypes: ['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac'] },
  { extension: '.wav', contentTypes: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'] },
  { extension: '.ogg', contentTypes: ['audio/ogg', 'application/ogg', 'audio/opus'] },
  { extension: '.webm', contentTypes: ['audio/webm'] },
];

/** The extension a recording is stored under, or null when it is not one memos take. */
export function memoExtensionFor(filename: string, contentType: string): string | null {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return (
    MEMO_FORMATS.find((f) => f.extension === ext)?.extension ??
    MEMO_FORMATS.find((f) => type !== '' && f.contentTypes.includes(type))?.extension ??
    null
  );
}

/**
 * `pending` is the reserved row before the bucket confirms the bytes; `failed`
 * keeps the `stage` it failed in, which is what Retry resumes from.
 */
export type MemoStatus = 'pending' | 'uploaded' | 'transcribing' | 'transcribed' | 'analysing' | 'done' | 'failed';

/** One stretch of speech; times in seconds from the start of the recording. */
export interface MemoSegment {
  i: number;
  start: number;
  end: number;
  text: string;
  /** Who is speaking, when the source names them (a Plaud transcript does; our own speech-to-text does not). */
  speaker?: string;
}

/** Where a memo came from: an uploaded recording, or a Plaud recording's own transcript (#864). */
export const MEMO_SOURCES = ['upload', 'plaud'] as const;
export type MemoSource = (typeof MEMO_SOURCES)[number];

/**
 * A moment in a recording as people read it: `12:03`, or `1:02:03` past the
 * hour. One spelling for the merge request links the API writes and the
 * timestamps the memo page shows.
 */
export function memoClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(hh ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Whether this deployment can transcribe, and the variable to set when it cannot. */
export interface MemoTranscriptionState {
  enabled: boolean;
  missing: 'TRANSCRIPTION_PROVIDER' | 'TRANSCRIPTION_BASE_URL' | 'TRANSCRIPTION_API_KEY' | null;
}

export interface MemoInfo {
  memoId: string;
  workspaceId: string;
  projectId: string;
  title: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  language: string | null;
  status: MemoStatus;
  stage: string | null;
  error: string | null;
  /** False once the audio was purged (retention), and always for a Plaud memo — the transcript stays. */
  audioAvailable: boolean;
  source: MemoSource;
  createdAt: string;
  updatedAt: string;
}

export interface MemoListResponse {
  memos: MemoInfo[];
  transcription: MemoTranscriptionState;
  limits: { maxBytes: number; maxMinutes: number };
}

export interface CreateMemoResponse {
  memo: MemoInfo;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string };
}

export interface MemoResponse {
  memo: MemoInfo;
}

/** Why the code refused a proposal the analysis made — shown on the memo page. */
export type MemoDropReason = 'unknown-segment' | 'unknown-page' | 'too-short' | 'duplicate' | 'over-limit';

export interface MemoDropped {
  title: string;
  reason: MemoDropReason;
}

/** A kept proposal, and the merge request it became once published. */
export interface MemoProposal {
  action: 'create' | 'update';
  title: string;
  detail: string;
  documentId: string | null;
  documentTitle: string | null;
  segments: number[];
  mergeRequestId: string | null;
}

/** The steps a memo moves through; a Plaud memo arrives with the first two behind it. */
export const MEMO_STEPS = ['upload', 'transcribe', 'analyse', 'publish'] as const;
export type MemoStep = (typeof MEMO_STEPS)[number];

/** What is happening to a memo right now (#876): the step, whether anything has picked it up, and since when. */
export interface MemoProgress {
  step: MemoStep;
  state: 'waiting' | 'running';
  since: string;
}

/**
 * Derived on read from the memo's status and its secretary run, never stored.
 * Null once the memo is done or failed: the status says the rest. A run that
 * has ended on a memo still `analysing` is waiting for the publisher, which
 * opens its merge requests.
 */
export function memoProgressFor(
  memo: { status: MemoStatus; updatedAt: string },
  run: { status: string; createdAt: string; startedAt: string | null; finishedAt: string | null } | null,
): MemoProgress | null {
  switch (memo.status) {
    case 'pending':
      return { step: 'upload', state: 'running', since: memo.updatedAt };
    case 'uploaded':
      return { step: 'transcribe', state: 'waiting', since: memo.updatedAt };
    case 'transcribing':
      return { step: 'transcribe', state: 'running', since: memo.updatedAt };
    case 'transcribed':
      return { step: 'analyse', state: 'waiting', since: memo.updatedAt };
    case 'analysing':
      if (!run || run.status === 'pending') return { step: 'analyse', state: 'waiting', since: run?.createdAt ?? memo.updatedAt };
      if (run.status === 'running') return { step: 'analyse', state: 'running', since: run.startedAt ?? run.createdAt };
      return { step: 'publish', state: 'waiting', since: run.finishedAt ?? memo.updatedAt };
    default:
      return null;
  }
}

export interface MemoDetailResponse {
  memo: MemoInfo;
  /** Null once the memo is done or failed. */
  progress: MemoProgress | null;
  transcript: MemoSegment[];
  summary: string | null;
  proposals: MemoProposal[];
  dropped: MemoDropped[];
}

// ---------------------------------------------------------------------------
// Plaud import (#864): a person's own Plaud sign-in, the source of memos built
// from Plaud's transcripts.
// ---------------------------------------------------------------------------

// GET /v1/plaud/link
export interface PlaudLinkResponse {
  /** False with `PLAUD_OAUTH_CLIENT_ID` unset or no encryption key: linking is not offered. */
  configured: boolean;
  linked: boolean;
  /** The Plaud account's name as Plaud reports it; shown to its owner only. */
  accountLabel: string | null;
  /** The sign-in lapsed (Plaud keeps it seven days without use): link again. */
  needsReconnect: boolean;
}

/**
 * Which recordings auto-import picks. Sparse: an absent key takes
 * `PLAUD_RULE_DEFAULTS`, and `since` defaults to the day the settings were
 * first saved, so linking never imports a backlog.
 */
export interface PlaudRules {
  /** Only recordings started on or after this day (`YYYY-MM-DD`). */
  since?: string;
  /** Only recordings at least this long. */
  minSeconds?: number;
  /** Only recordings whose Plaud name contains this, ignoring case. */
  nameIncludes?: string;
  /** Never recordings whose Plaud name contains this, ignoring case. */
  nameExcludes?: string;
  /** Only recordings from the device with this serial number. */
  serial?: string;
  /** `ask`: each picked recording waits for the person. `auto`: it is imported as soon as Plaud has transcribed it. */
  confirm?: PlaudConfirmMode;
}
export const PLAUD_CONFIRM_MODES = ['ask', 'auto'] as const;
export type PlaudConfirmMode = (typeof PLAUD_CONFIRM_MODES)[number];
export const PLAUD_RULE_DEFAULTS = { minSeconds: 120, confirm: 'ask' } as const satisfies PlaudRules;

/**
 * `waiting`: picked, but Plaud has not transcribed it (the person does that in
 * the Plaud app). `pending`: transcribed, waiting for the person. `confirmed`:
 * the person said yes ahead of the transcript. `skipped` is final: it is never
 * offered again. `failed` can be confirmed again.
 */
export const PLAUD_IMPORT_STATUSES = ['waiting', 'pending', 'confirmed', 'skipped', 'imported', 'failed'] as const;
export type PlaudImportStatus = (typeof PLAUD_IMPORT_STATUSES)[number];

// GET / PUT /v1/plaud/settings
export interface PlaudSettingsResponse {
  /** Where picked recordings go; null = auto-import is off in this workspace. */
  projectId: string | null;
  /** As saved: sparse. */
  rules: PlaudRules;
  /** What applies once the defaults are filled in. */
  effective: Required<Pick<PlaudRules, 'since' | 'minSeconds' | 'confirm'>>;
  /** The most auto mode imports for one person in a day on this server. */
  maxPerDay: number;
  /**
   * "Transcribe here": our own speech-to-text on a recording Plaud has not transcribed. Off when this server cannot
   * transcribe or the allowance is 0. `remainingSeconds` is what is left of the caller's 30-day allowance.
   */
  transcribe: { enabled: boolean; limitSeconds: number; remainingSeconds: number };
}

export interface PlaudImportEntry {
  id: string;
  /** Plaud's name for the recording. */
  name: string;
  startAt: string | null;
  durationSeconds: number;
  status: PlaudImportStatus;
  /** The memo it became. */
  memoId: string | null;
  error: string | null;
  createdAt: string;
}

// GET /v1/plaud/imports, POST /v1/plaud/imports/confirm | skip
export interface PlaudImportsResponse {
  imports: PlaudImportEntry[];
}

// GET /v1/plaud/authorize
export interface PlaudAuthorizeResponse {
  url: string;
}
