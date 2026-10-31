import type { MemoSegment } from '@knowledge/contracts';
import { createMasker } from '../chat/harvest-mask.js';

/** One chunk's answer from the speech server, as `verbose_json` shapes it. */
export interface ChunkTranscript {
  /** Where the chunk starts in the whole recording, seconds. */
  offset: number;
  /** The chunk's own length, for a server that answers without segments. */
  duration: number;
  language: string | null;
  segments: Array<{ start: number; end: number; text: string }>;
  /** The whole chunk's text — the fallback when `segments` is empty. */
  text: string;
  /** What the server billed for this chunk, when it says (gen-api does). */
  cost?: number;
}

/**
 * One transcript from the chunks, in order: each segment's times shifted by
 * its chunk's start, empty speech dropped, and every text masked by one
 * masker, so a value spoken twice keeps one placeholder (doc 59's rule). A
 * server that returns text without segments still yields one segment per
 * chunk. The unmasked text never leaves this function.
 */
export function stitchTranscript(chunks: ChunkTranscript[]): { segments: MemoSegment[]; language: string | null } {
  const mask = createMasker();
  const segments: MemoSegment[] = [];
  for (const chunk of chunks) {
    const parts = chunk.segments.length
      ? chunk.segments
      : [{ start: 0, end: chunk.duration, text: chunk.text }];
    for (const part of parts) {
      const text = part.text.trim();
      if (!text) continue;
      segments.push({
        i: segments.length,
        start: round(chunk.offset + part.start),
        end: round(chunk.offset + Math.max(part.end, part.start)),
        text: mask(text),
      });
    }
  }
  return { segments, language: chunks.find((c) => c.language)?.language ?? null };
}

const round = (seconds: number) => Math.round(seconds * 100) / 100;
