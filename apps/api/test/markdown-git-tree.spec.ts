import { describe, expect, it } from 'vitest';
import { childPathsOf, dirOf, isIndexPath } from '../src/connectors/adapters/markdown-git.adapter.js';

/**
 * The folder structure was always sitting in `externalId`; `seedFlat` threw it
 * away and every page arrived as a sibling (docs/features/26). These cover the
 * part that is not obvious — a directory with no index file must lift its
 * contents to the nearest ancestor that has one, rather than vanishing them.
 */
const vault = (paths: string[]): Map<string, Uint8Array> =>
  new Map(paths.map((p) => [p, new Uint8Array()]));

describe('markdown-git path tree', () => {
  it('reads a directory off a path', () => {
    expect(dirOf('docs/platform/billing.md')).toBe('docs/platform');
    expect(dirOf('root.md')).toBe('');
  });

  it('recognises the files that make a directory a page', () => {
    expect(isIndexPath('docs/README.md')).toBe(true);
    expect(isIndexPath('docs/index.md')).toBe(true);
    // <dirname>.md — the mkdocs / Obsidian folder-note convention.
    expect(isIndexPath('docs/platform/platform.md')).toBe(true);
    expect(isIndexPath('docs/platform/billing.md')).toBe(false);
  });

  it('hangs a subdirectory off its index file', () => {
    const files = vault([
      'docs/README.md',
      'docs/platform/README.md',
      'docs/platform/billing.md',
    ]);
    expect(childPathsOf('docs', files)).toEqual(['docs/platform/README.md']);
    expect(childPathsOf('docs/platform', files)).toEqual(['docs/platform/billing.md']);
  });

  it('lifts the contents of a directory that has no index file', () => {
    // `notes/` is transparent: its pages belong to `docs`, not to a folder page
    // invented for them.
    const files = vault(['docs/README.md', 'docs/notes/one.md', 'docs/notes/two.md']);
    expect(childPathsOf('docs', files)).toEqual(['docs/notes/one.md', 'docs/notes/two.md']);
  });

  it('lifts through more than one transparent level', () => {
    const files = vault(['README.md', 'a/b/c/deep.md']);
    expect(childPathsOf('', files)).toEqual(['a/b/c/deep.md']);
  });

  it('never yields a directory its own index file as a child', () => {
    const files = vault(['docs/README.md', 'docs/one.md']);
    expect(childPathsOf('docs', files)).toEqual(['docs/one.md']);
  });

  it('treats a flat vault as flat', () => {
    const files = vault(['a.md', 'b.md']);
    expect(childPathsOf('', files)).toEqual(['a.md', 'b.md']);
  });
});
