import type { MemoSegment } from '@knowledge/contracts';
import { createMasker } from '../chat/harvest-mask.js';

/** One chunk's answer from the speech server, as `verbose_json` shapes it. */
export interface ChunkTranscript {
  /** Where the chunk starts in the whole recording, seconds. */
  offset: number;
  /** The chunk's own length, for a server that answers without segments. */
  duration: number;
  language: string | null;
  segments: Array<{ start: number; end: number; text: string; speaker?: string }>;
  /** The whole chunk's text — the fallback when `segments` is empty. */
  text: string;
  /** What the server billed for this chunk, when it says (gen-api does). */
  cost?: number;
  /**
   * `speaker` is the server's own id for a voice (`speaker_0`), good only
   * inside this chunk (#878), not a name: the stitcher numbers such voices
   * across the recording.
   */
  anonymousSpeakers?: boolean;
}

/** One word of a Scribe answer (gen-api `speech-to-text`), as measured on a real call. */
export interface ScribeWord {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  type?: unknown;
  speaker_id?: unknown;
}

/** A segment this long ends at the next sentence end, so a monologue stays citable. */
const SEGMENT_SECONDS = 20;
/** Silence this long starts a new segment even for the same voice. */
const GAP_SECONDS = 2;

/**
 * Words into segments (#878): a new one when the voice changes, after a long
 * pause, or at a sentence end once the segment has run long. Anything that is
 * not a spoken word or the spacing between words (an audio event) is dropped.
 */
export function scribeSegments(words: ScribeWord[]): ChunkTranscript['segments'] {
  const out: Array<{ start: number; end: number; text: string; speaker?: string }> = [];
  let last: (typeof out)[number] | undefined;
  for (const w of words) {
    if (typeof w.text !== 'string' || (w.type !== 'word' && w.type !== 'spacing')) continue;
    if (w.type === 'spacing') {
      if (last) last.text += w.text;
      continue;
    }
    if (typeof w.start !== 'number' || typeof w.end !== 'number') continue;
    const speaker = typeof w.speaker_id === 'string' && w.speaker_id ? w.speaker_id : undefined;
    const full = last && last.end - last.start >= SEGMENT_SECONDS && /[.!?…]\s*$/.test(last.text);
    if (!last || last.speaker !== speaker || w.start - last.end >= GAP_SECONDS || full) {
      last = { start: w.start, end: w.end, text: w.text, ...(speaker ? { speaker } : {}) };
      out.push(last);
    } else {
      last.text += w.text;
      last.end = w.end;
    }
  }
  return out;
}

/**
 * One transcript from the chunks, in order: each segment's times shifted by
 * its chunk's start, empty speech dropped, and every text masked by one
 * masker, so a value spoken twice keeps one placeholder (doc 59's rule). A
 * server that returns text without segments still yields one segment per
 * chunk. The unmasked text never leaves this function.
 */
export function stitchTranscript(
  chunks: ChunkTranscript[],
  /** Names the n-th anonymous voice, in the memo's language. */
  voice: (n: number) => string = (n) => `Speaker ${n}`,
): { segments: MemoSegment[]; language: string | null } {
  const mask = createMasker();
  const segments: MemoSegment[] = [];
  let voices = 0;
  for (const chunk of chunks) {
    // ponytail: a voice is numbered per chunk, so one person in a recording past SPEAKER_CHUNK_SECONDS
    // gets a second number in the next hour. Match voices across an overlap when long recordings are common.
    const numbered = new Map<string, string>();
    const speakerOf = (raw: string | undefined): string | undefined => {
      const name = raw?.trim();
      if (!name || !chunk.anonymousSpeakers) return name;
      if (!numbered.has(name)) numbered.set(name, voice((voices += 1)));
      return numbered.get(name);
    };
    const parts = chunk.segments.length
      ? chunk.segments
      : [{ start: 0, end: chunk.duration, text: chunk.text, speaker: undefined }];
    for (const part of parts) {
      const text = part.text.trim();
      if (!text) continue;
      segments.push({
        i: segments.length,
        start: round(chunk.offset + part.start),
        end: round(chunk.offset + Math.max(part.end, part.start)),
        text: mask(text),
        // A name can be an address or a number as easily as speech can.
        ...(speakerOf(part.speaker) ? { speaker: mask(speakerOf(part.speaker)!) } : {}),
      });
    }
  }
  return { segments, language: chunks.find((c) => c.language)?.language ?? null };
}

const round = (seconds: number) => Math.round(seconds * 100) / 100;
