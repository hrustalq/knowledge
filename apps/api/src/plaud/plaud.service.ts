import { Injectable } from '@nestjs/common';
import { PlaudOauthService } from './plaud-oauth.service.js';
import { PlaudError, plaudTool } from './plaud.client.js';

/** A recording as Plaud lists it. Times are Plaud's: `duration` in milliseconds. */
export interface PlaudRecording {
  id: string;
  name: string;
  /** When the recording started, ISO without a zone; `created_at` is when it reached Plaud. */
  startAt: string | null;
  durationSeconds: number;
  /** The device it was recorded on, when Plaud says. */
  serial: string | null;
}

/** One utterance of Plaud's transcript, in seconds. */
export interface PlaudUtterance {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

/** Plaud's own ceiling on a transcript page. */
const PAGE = 500;
// ponytail: 40 pages = 20,000 utterances, far past MEMO_MAX_MINUTES of speech; raise with that limit.
const MAX_PAGES = 40;
const LIST_PAGE = 100;
// ponytail: 5 pages = 500 recordings inside the lookback window; more than that in two weeks is not a person's device.
const MAX_LIST_PAGES = 5;

/**
 * Reads a person's Plaud recordings as that person (#864). Every call dials
 * with their own sign-in; a token Plaud refuses is refreshed once, and a
 * sign-in that cannot be refreshed reads as not linked.
 */
@Injectable()
export class PlaudService {
  constructor(private readonly oauth: PlaudOauthService) {}

  /** Null when the person has no usable Plaud sign-in. */
  async recording(userId: string, fileId: string): Promise<PlaudRecording | null> {
    const file = await this.call<RawFile>(userId, 'get_file', { file_id: fileId });
    if (file === null) return null;
    return toRecording(file);
  }

  /**
   * The person's recordings started on or after `from` (`YYYY-MM-DD`), newest
   * first. Null when they have no usable sign-in.
   */
  async list(userId: string, from: string): Promise<PlaudRecording[] | null> {
    const out = new Map<string, PlaudRecording>();
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const answer = await this.call<{ data?: RawFile[] }>(userId, 'list_files', { date_from: from, page, page_size: LIST_PAGE });
      if (answer === null) return null;
      if (!Array.isArray(answer.data)) throw new PlaudError('Plaud answered in a shape this version does not read');
      const before = out.size;
      for (const file of answer.data) out.set(String(file.id), toRecording(file));
      // A short page is the last one; a page that adds nothing means paging was ignored.
      if (answer.data.length < LIST_PAGE || out.size === before) break;
    }
    return [...out.values()];
  }

  /** Whether Plaud has a transcript for it yet: one utterance is asked for, not the transcript. Null = no usable sign-in. */
  async transcribed(userId: string, fileId: string): Promise<boolean | null> {
    const answer = await this.call<TranscriptPage>(userId, 'get_transcript', { file_id: fileId, limit: 1 });
    if (answer === null) return null;
    const segments = Array.isArray(answer) ? answer : answer.segments;
    return Array.isArray(segments) && segments.length > 0;
  }

  /**
   * The raw transcript, every page of it. Empty when Plaud has not transcribed
   * the recording: that is the person's act in the Plaud app, never ours.
   */
  async transcript(userId: string, fileId: string): Promise<PlaudUtterance[] | null> {
    const out: PlaudUtterance[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const answer = await this.call<TranscriptPage>(userId, 'get_transcript', { file_id: fileId, limit: PAGE, ...(cursor ? { cursor } : {}) });
      if (answer === null) return null;
      // A recording with no transcript answers with a bare empty list.
      const segments = (Array.isArray(answer) ? answer : answer.segments) as RawSegment[] | undefined;
      if (!Array.isArray(segments)) throw new PlaudError('Plaud answered in a shape this version does not read');
      for (const s of segments) {
        if (typeof s?.content !== 'string' || typeof s.start_time !== 'number') continue;
        out.push({
          start: s.start_time / 1000,
          end: (typeof s.end_time === 'number' ? s.end_time : s.start_time) / 1000,
          text: s.content,
          ...(typeof s.speaker === 'string' && s.speaker ? { speaker: s.speaker } : {}),
        });
      }
      cursor = Array.isArray(answer) ? undefined : (answer.next_cursor ?? undefined);
      if (!cursor) break;
    }
    return out;
  }

  private async call<T>(userId: string, tool: string, args: Record<string, unknown>): Promise<T | null> {
    const token = await this.oauth.tokenFor(userId);
    if (!token) return null;
    try {
      return await plaudTool<T>(token, tool, args);
    } catch (err) {
      if (!(err instanceof PlaudError) || !err.unauthorized) throw err;
      const renewed = await this.oauth.tokenFor(userId, token);
      return renewed ? plaudTool<T>(renewed, tool, args) : null;
    }
  }
}

interface RawFile {
  id?: string;
  name?: string;
  start_at?: string | null;
  duration?: number;
  serial_number?: string | null;
}

function toRecording(file: RawFile): PlaudRecording {
  if (typeof file?.id !== 'string' || typeof file.duration !== 'number') throw new PlaudError('Plaud answered in a shape this version does not read');
  return {
    id: file.id,
    name: typeof file.name === 'string' ? file.name : '',
    startAt: file.start_at ?? null,
    durationSeconds: Math.round(file.duration / 1000),
    serial: file.serial_number ?? null,
  };
}

interface RawSegment {
  content?: string;
  start_time?: number;
  end_time?: number;
  speaker?: string;
}
type TranscriptPage = unknown[] | { segments?: RawSegment[]; next_cursor?: string | null };
