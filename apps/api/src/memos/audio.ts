import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Ten minutes of 16 kHz mono mp3 at 32 kbit/s is ≈ 2.4 MB, far under any server's upload cap. */
export const CHUNK_SECONDS = 600;

/**
 * The longest piece for a server that returns text without timestamps
 * (gen-api's `gen-stt`, #584): each piece is one segment, so this is how
 * finely a proposal can point into the recording.
 */
export const SHORT_CHUNK_SECONDS = 60;

/** The recording's length, from its container — what the length ceiling is enforced on. */
export async function probeSeconds(path: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('ffprobe found no audio duration');
  return seconds;
}

/** Cut every `CHUNK_SECONDS`: for a server that times its own segments. */
export function fixedCuts(seconds: number): number[] {
  const cuts: number[] = [];
  for (let at = CHUNK_SECONDS; at < seconds; at += CHUNK_SECONDS) cuts.push(at);
  return cuts;
}

/** The middle of every pause ffmpeg's `silencedetect` hears, in order. */
export async function detectPauses(path: string): Promise<number[]> {
  const { stderr } = await run(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', path, '-af', 'silencedetect=noise=-30dB:d=0.3', '-f', 'null', '-'],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return parsePauses(stderr);
}

export function parsePauses(log: string): number[] {
  const pauses: number[] = [];
  let start: number | null = null;
  for (const [, kind, value] of log.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    if (kind === 'start') start = Math.max(0, Number(value));
    else if (start !== null) {
      pauses.push((start + Number(value)) / 2);
      start = null;
    }
  }
  return pauses;
}

/**
 * Cut points no more than `max` apart, each at the latest pause in the second
 * half of its window, so a piece ends between words; a window with no pause
 * is cut hard at `max`.
 */
export function pauseCuts(pauses: number[], seconds: number, max = SHORT_CHUNK_SECONDS): number[] {
  const cuts: number[] = [];
  let from = 0;
  while (seconds - from > max) {
    const [half, end] = [from + max / 2, from + max];
    from = pauses.filter((p) => p > half && p <= end).at(-1) ?? end;
    cuts.push(from);
  }
  return cuts;
}

/**
 * Normalise to 16 kHz mono mp3 and cut at `cuts`, in order, with each piece's
 * offset into the recording and its length. Any input ffmpeg reads works, so
 * the speech server only ever sees one format.
 */
export async function splitAudio(
  input: string,
  dir: string,
  cuts: number[],
  seconds: number,
): Promise<Array<{ path: string; offset: number; duration: number }>> {
  await run(
    'ffmpeg',
    [
      '-v', 'error',
      '-i', input,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k',
      '-f', 'segment',
      // With neither flag the segment muxer cuts every 2 s.
      ...(cuts.length ? ['-segment_times', cuts.join(',')] : ['-segment_time', String(Math.ceil(seconds) + 1)]),
      '-reset_timestamps', '1',
      join(dir, 'chunk-%04d.mp3'),
    ],
  );
  const offsets = [0, ...cuts];
  const names = (await readdir(dir)).filter((n) => /^chunk-\d{4}\.mp3$/.test(n)).sort();
  return names.map((name, index) => ({
    path: join(dir, name),
    offset: offsets[index]!,
    duration: (offsets[index + 1] ?? seconds) - offsets[index]!,
  }));
}
