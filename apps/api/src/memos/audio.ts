import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Ten minutes of 16 kHz mono mp3 at 32 kbit/s is ≈ 2.4 MB, far under any server's upload cap. */
export const CHUNK_SECONDS = 600;

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

/**
 * Normalise to 16 kHz mono mp3 and cut into `CHUNK_SECONDS` pieces, in order,
 * with each piece's offset into the recording. Any input ffmpeg reads works,
 * so the speech server only ever sees one format.
 */
export async function splitAudio(input: string, dir: string): Promise<Array<{ path: string; offset: number }>> {
  await run(
    'ffmpeg',
    [
      '-v', 'error',
      '-i', input,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k',
      '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-reset_timestamps', '1',
      join(dir, 'chunk-%04d.mp3'),
    ],
  );
  const names = (await readdir(dir)).filter((n) => /^chunk-\d{4}\.mp3$/.test(n)).sort();
  return names.map((name, index) => ({ path: join(dir, name), offset: index * CHUNK_SECONDS }));
}
