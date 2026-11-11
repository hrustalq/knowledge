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
   * Scribe's words (#878), in place of `segments`: the stitcher segments them
   * itself, once it has cut what this piece shares with its neighbours (#893).
   */
  words?: ScribeWord[];
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

/** A piece's spoken words on the recording's clock. */
function spoken(chunk: ChunkTranscript): Array<{ start: number; end: number; speaker?: string }> {
  return (chunk.words ?? []).flatMap((w) =>
    w.type === 'word' && typeof w.start === 'number' && typeof w.end === 'number'
      ? [{ start: chunk.offset + w.start, end: chunk.offset + w.end, ...(typeof w.speaker_id === 'string' && w.speaker_id ? { speaker: w.speaker_id } : {}) }]
      : [],
  );
}

/**
 * Where two overlapping pieces hand over (#893): the middle of the longest
 * pause the earlier one heard in the middle half of their shared stretch, so a
 * word lands on one side however the two clocks disagree. No pause there: the
 * stretch's middle.
 */
function seamBetween(before: ChunkTranscript, after: ChunkTranscript): number {
  const [from, to] = [after.offset, before.offset + before.duration];
  const [lo, hi] = [from + (to - from) / 4, to - (to - from) / 4];
  let [seam, widest] = [(from + to) / 2, 0];
  const words = spoken(before);
  for (let i = 1; i < words.length; i++) {
    const [end, start] = [words[i - 1]!.end, words[i]!.start];
    if (start - end > widest && (end + start) / 2 >= lo && (end + start) / 2 <= hi) {
      [seam, widest] = [(end + start) / 2, start - end];
    }
  }
  return seam;
}

/**
 * The later piece's voices onto the earlier piece's (#893): two ids are one
 * person when they say the same words at the same moment of the shared
 * stretch. One-to-one, the longest agreement first; a voice silent there
 * matches nothing.
 */
function matchVoices(before: ChunkTranscript, after: ChunkTranscript): Map<string, string> {
  const to = before.offset + before.duration;
  const earlier = spoken(before).filter((w) => w.speaker && w.end > after.offset);
  const together = new Map<string, number>();
  for (const w of spoken(after)) {
    if (!w.speaker || w.start >= to) continue;
    for (const p of earlier) {
      const both = Math.min(w.end, p.end) - Math.max(w.start, p.start);
      const pair = `${w.speaker}\n${p.speaker}`;
      if (both > 0) together.set(pair, (together.get(pair) ?? 0) + both);
    }
  }
  const match = new Map<string, string>();
  const taken = new Set<string>();
  for (const [pair] of [...together].sort((a, b) => b[1] - a[1])) {
    const [later, was] = pair.split('\n') as [string, string];
    if (match.has(later) || taken.has(was)) continue;
    match.set(later, was);
    taken.add(was);
  }
  return match;
}

/**
 * One transcript from the chunks, in order: each segment's times shifted by
 * its chunk's start, empty speech dropped, and every text masked by one
 * masker, so a value spoken twice keeps one placeholder (doc 59's rule). A
 * server that returns text without segments still yields one segment per
 * chunk. The unmasked text never leaves this function.
 *
 * Scribe pieces that overlap (#893) are cut at `seamBetween`, so no word is
 * kept twice, and a later piece's voice takes the earlier one's number when
 * `matchVoices` pairs them. Any other voice gets a new number.
 */
export function stitchTranscript(
  chunks: ChunkTranscript[],
  /** Names the n-th anonymous voice, in the memo's language. */
  voice: (n: number) => string = (n) => `Speaker ${n}`,
): { segments: MemoSegment[]; language: string | null } {
  const mask = createMasker();
  const segments: MemoSegment[] = [];
  let voices = 0;
  // seams[i]: where chunk i takes over from chunk i - 1, when the two overlap.
  const seams = chunks.map((chunk, i) => {
    const before = chunks[i - 1];
    return before?.words?.length && chunk.words?.length && chunk.offset < before.offset + before.duration
      ? seamBetween(before, chunk)
      : undefined;
  });
  let previous = new Map<string, string>();
  for (const [index, chunk] of chunks.entries()) {
    const numbered = new Map<string, string>();
    const match = seams[index] === undefined ? new Map<string, string>() : matchVoices(chunks[index - 1]!, chunk);
    const speakerOf = (raw: string | undefined): string | undefined => {
      const name = raw?.trim();
      if (!name || !chunk.anonymousSpeakers) return name;
      if (!numbered.has(name)) numbered.set(name, previous.get(match.get(name) ?? '') ?? voice((voices += 1)));
      return numbered.get(name);
    };
    const [from, to] = [seams[index] ?? -Infinity, seams[index + 1] ?? Infinity];
    const parts = chunk.words?.length
      ? scribeSegments(chunk.words.filter((w) => typeof w.start !== 'number' || (chunk.offset + w.start >= from && chunk.offset + w.start < to)))
      : chunk.segments.length
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
    previous = numbered;
  }
  return { segments, language: chunks.find((c) => c.language)?.language ?? null };
}

const round = (seconds: number) => Math.round(seconds * 100) / 100;
