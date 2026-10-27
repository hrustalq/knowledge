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

/** Whether this deployment can transcribe, and the variable to set when it cannot. */
export interface MemoTranscriptionState {
  enabled: boolean;
  missing: 'TRANSCRIPTION_PROVIDER' | 'TRANSCRIPTION_BASE_URL' | null;
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

export interface MemoDetailResponse {
  memo: MemoInfo;
  transcript: MemoSegment[];
  summary: string | null;
}
