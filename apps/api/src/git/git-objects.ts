import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/**
 * Git object bytes in plain Node (#636, docs/features/71 "The protocol"). A
 * commit's SHA is a pure function of these bytes, which is why they live here
 * rather than in whatever `git fast-import` would write.
 */
export type GitObjectType = 'commit' | 'tree' | 'blob';

export interface GitObject {
  type: GitObjectType;
  body: Buffer;
}

export function hashObject(type: GitObjectType, body: Buffer): string {
  return createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}

/** Git's tree order: byte order of names, a directory compared as `name/`. */
export function treeBody(entries: { mode: '100644' | '40000'; name: string; sha: string }[]): Buffer {
  const key = (e: (typeof entries)[number]) => Buffer.from(e.mode === '40000' ? `${e.name}/` : e.name);
  const sorted = [...entries].sort((a, b) => Buffer.compare(key(a), key(b)));
  return Buffer.concat(sorted.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex')]));
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3 };

/** A version-2 pack of whole (undeltified) objects, for `git index-pack --stdin`. */
export function writePack(objects: GitObject[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0);
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts = [head];
  for (const { type, body } of objects) {
    let size = body.length;
    const bytes = [(TYPE_CODE[type] << 4) | (size & 15)];
    size >>= 4;
    while (size > 0) {
      bytes[bytes.length - 1] |= 0x80;
      bytes.push(size & 0x7f);
      size >>= 7;
    }
    parts.push(Buffer.from(bytes), deflateSync(body));
  }
  const pack = Buffer.concat(parts);
  return Buffer.concat([pack, createHash('sha1').update(pack).digest()]);
}

/**
 * Whether git accepts `name` under `refs/heads/` or `refs/tags/`
 * (`git check-ref-format`). Branch and tag names are free text here, so a
 * name git refuses is left out of the advertisement rather than breaking it.
 */
export function isValidRefName(name: string): boolean {
  if (!name || name === '@' || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f~^:?*[\\]|\.\.|@\{|\/\//.test(name)) return false;
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}
