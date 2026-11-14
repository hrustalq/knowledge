import { unzipSync, type UnzipFileInfo, type Unzipped } from 'fflate';

/** `ARCHIVE_MAX_INFLATED_BYTES`'s default, for a reader handed no ceiling. */
export const DEFAULT_ARCHIVE_MAX_INFLATED_BYTES = 536_870_912;

/** An archive that would inflate past its reader's ceiling (#1109). */
export class ArchiveTooLargeError extends Error {
  constructor(readonly max: number) {
    super(`archive would inflate past ${max} bytes`);
  }
}

/**
 * `unzipSync` that inflates at most `maxBytes` in total (#1109), and only the
 * entries `keep` wants. The total is counted from each entry's declared size,
 * before that entry is inflated, so a refusal costs nothing. A header that
 * lies does not help: fflate inflates an entry into a buffer of its declared
 * size and stops there, so memory is bounded by the declared total either way.
 */
export function unzipBounded(bytes: Uint8Array, maxBytes: number, keep: (file: UnzipFileInfo) => boolean = () => true): Unzipped {
  let total = 0;
  return unzipSync(bytes, {
    filter: (file) => {
      if (!keep(file)) return false;
      total += file.originalSize;
      if (total > maxBytes) throw new ArchiveTooLargeError(maxBytes);
      return true;
    },
  });
}
