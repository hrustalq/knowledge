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
}

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
  /** False once the audio was purged (retention) — the transcript stays. */
  audioAvailable: boolean;
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

export interface MemoDetailResponse {
  memo: MemoInfo;
  transcript: MemoSegment[];
  summary: string | null;
  proposals: MemoProposal[];
  dropped: MemoDropped[];
}
