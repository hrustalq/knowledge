import { describe, expect, it } from 'vitest';
import {
  directoryListing,
  editedSnippet,
  fileChunks,
  fileView,
  formatFileSize,
  insertAt,
  memoryPath,
  MemoryToolError,
  readCommand,
  replaceOnce,
  VIEW_MAX_CHARS,
} from '../src/memory/memory-files.js';
import { memoryToolRole } from '../src/memory/memory-files.service.js';

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof MemoryToolError) return e.message;
    throw e;
  }
  throw new Error('expected a refusal');
};

describe('memory tool paths (#1009)', () => {
  it('canonicalises a path under /memories', () => {
    expect(memoryPath('/memories')).toEqual({ path: '/memories', segments: [] });
    expect(memoryPath('/memories/')).toEqual({ path: '/memories', segments: [] });
    expect(memoryPath('/memories//a/./b.md')).toEqual({ path: '/memories/a/b.md', segments: ['a', 'b.md'] });
    expect(memoryPath('/memories/a/').path).toBe('/memories/a');
    // A lone % is part of a name, and so is a backslash that is not traversal.
    expect(memoryPath('/memories/100%.md').path).toBe('/memories/100%.md');
    expect(memoryPath('/memories/a\\b.md').path).toBe('/memories/a\\b.md');
  });

  it('refuses a path outside /memories with the SDK’s string', () => {
    for (const raw of ['', '/', '/etc/passwd', 'memories/a', '../memories/a', '/memoriesX/a', '/Memories/a']) {
      expect(refusal(() => memoryPath(raw))).toBe(`Path must start with /memories, got: ${raw}`);
    }
  });

  it('refuses every traversal form, also one that resolves inside, also encoded or with backslashes', () => {
    for (const raw of [
      '/memories/..',
      '/memories/../secrets.env',
      '/memories/a/../../etc',
      '/memories/a/../b',
      '/memories/..\\secrets',
      '/memories/a\\..\\..\\etc',
      '/memories/%2e%2e%2fsecrets',
      '/memories/%2E%2E/x',
      '/memories/..%2fx',
      '/memories/%252e%252e%252fx',
    ]) {
      expect([raw, refusal(() => memoryPath(raw))]).toEqual([raw, `Path ${raw} would escape /memories directory`]);
    }
    expect(refusal(() => memoryPath('/memories/a%00b'))).toBe('Path /memories/a%00b contains a control character');
    expect(refusal(() => memoryPath(`/memories/${'x'.repeat(1100)}`))).toMatch(/longer than 1024 characters/);
  });
});

describe('memory tool input', () => {
  it('reads each command and refuses a field of the wrong type', () => {
    expect(readCommand({ command: 'view', path: '/memories', view_range: [1, -1] })).toEqual({ command: 'view', path: '/memories', view_range: [1, -1] });
    expect(readCommand({ command: 'str_replace', path: '/memories/a', old_str: 'x' })).toEqual({ command: 'str_replace', path: '/memories/a', old_str: 'x', new_str: '' });
    expect(refusal(() => readCommand({ command: 'teleport' }))).toBe('teleport not implemented');
    expect(refusal(() => readCommand('view'))).toMatch(/expected an object/);
    expect(refusal(() => readCommand({ command: 'create', path: '/memories/a' }))).toBe('Invalid input for create: `file_text` must be a string');
    expect(refusal(() => readCommand({ command: 'insert', path: '/memories/a', insert_line: 1.5, insert_text: '' }))).toBe('Invalid input for insert: `insert_line` must be an integer');
    expect(refusal(() => readCommand({ command: 'view', path: '/memories', view_range: ['1'] }))).toMatch(/view_range/);
  });

  it('asks a viewer for view, an editor or capture key for create, an editor for the rest', () => {
    expect(memoryToolRole('view')).toEqual({ role: 'viewer' });
    expect(memoryToolRole(null)).toEqual({ role: 'viewer' });
    expect(memoryToolRole('create')).toEqual({ role: 'editor', capture: true });
    for (const c of ['str_replace', 'insert', 'delete', 'rename']) expect(memoryToolRole(c)).toEqual({ role: 'editor' });
  });
});

describe('memory tool formats', () => {
  it('formats sizes as the SDK does', () => {
    expect([0, 1, 1023, 1024, 1536, 1048576, 1_300_000].map(formatFileSize)).toEqual(['0B', '1B', '1023B', '1K', '1.5K', '1M', '1.2M']);
  });

  it('lists two levels deep, sorted per directory, skipping hidden items and node_modules', () => {
    const files = [
      { path: '/memories/b.md', size: 1536 },
      { path: '/memories/a/x.md', size: 10 },
      { path: '/memories/a/deep/y.md', size: 5 },
      { path: '/memories/a/deep/more/z.md', size: 5 },
      { path: '/memories/.hidden', size: 1 },
      { path: '/memories/.git/config', size: 1 },
      { path: '/memories/node_modules/x', size: 1 },
      { path: '/memories/B.md', size: 0 },
    ];
    expect(directoryListing('/memories', memoryPath('/memories'), files)).toBe(
      [
        "Here're the files and directories up to 2 levels deep in /memories, excluding hidden items and node_modules:",
        '4.0K\t/memories',
        '0B\t/memories/B.md',
        '4.0K\t/memories/a/',
        '4.0K\t/memories/a/deep/',
        '10B\t/memories/a/x.md',
        '1.5K\t/memories/b.md',
      ].join('\n'),
    );
    expect(directoryListing('/memories/a/', memoryPath('/memories/a'), files.filter((f) => f.path.startsWith('/memories/a/')))).toBe(
      [
        "Here're the files and directories up to 2 levels deep in /memories/a/, excluding hidden items and node_modules:",
        '4.0K\t/memories/a/',
        '4.0K\t/memories/a//deep/',
        '4.0K\t/memories/a//deep/more/',
        '5B\t/memories/a//deep/y.md',
        '10B\t/memories/a//x.md',
      ].join('\n'),
    );
  });

  it('shows a file with 6-wide line numbers and honours view_range', () => {
    expect(fileView('/memories/a', 'one\ntwo\nthree')).toBe("Here's the content of /memories/a with line numbers:\n     1\tone\n     2\ttwo\n     3\tthree");
    expect(fileView('/memories/a', 'one\ntwo\nthree', [2, -1])).toBe("Here's the content of /memories/a with line numbers:\n     2\ttwo\n     3\tthree");
    expect(fileView('/memories/a', 'one\ntwo\nthree', [0, 1])).toBe("Here's the content of /memories/a with line numbers:\n     1\tone");
    expect(fileView('/memories/a', '')).toBe("Here's the content of /memories/a with line numbers:\n     1\t");
  });

  it('stops a view past 16,000 characters at a whole line and says where', () => {
    const line = 'x'.repeat(99);
    const content = Array.from({ length: 300 }, () => line).join('\n');
    const view = fileView('/memories/big', content);
    // 160 lines of 99 characters plus their newlines are 15,999 characters.
    expect(view).toContain('   160\t');
    expect(view).not.toContain('   161\t');
    expect(view.endsWith('\n[Truncated: past 16,000 characters the view stops at line 160 of 300. Use view_range to read from line 161.]')).toBe(true);
    const longer = Array.from({ length: 400 }, () => line).join('\n');
    expect(fileView('/memories/big', longer, [161, -1])).toContain('the view stops at line 320 of 400. Use view_range to read from line 321.]');
    const oneLine = fileView('/memories/wide', 'y'.repeat(VIEW_MAX_CHARS + 10));
    expect(oneLine).toContain(`     1\t${'y'.repeat(VIEW_MAX_CHARS)}\n[Truncated`);
    expect(oneLine).toContain('cut short');
  });
});

describe('memory tool edits', () => {
  it('replaces text that appears on one line and answers with the SDK’s snippet', () => {
    const { content, line } = replaceOnce('/memories/a', 'l1\nl2\nfoo bar\nl4\nl5\nl6', 'foo', 'baz');
    expect(content).toBe('l1\nl2\nbaz bar\nl4\nl5\nl6');
    expect(editedSnippet(content, line)).toBe(
      'The memory file has been edited. Here is the snippet showing the change (with line numbers):\n     1\tl1\n     2\tl2\n     3\tbaz bar\n     4\tl4\n     5\tl5',
    );
  });

  it('refuses text that is missing or on several lines, naming the lines', () => {
    expect(refusal(() => replaceOnce('/memories/a', 'a\nb', 'zz', 'y'))).toBe('No replacement was performed, old_str `zz` did not appear verbatim in /memories/a.');
    expect(refusal(() => replaceOnce('/memories/a', 'x\ny\nx', 'x', 'y'))).toBe('No replacement was performed. Multiple occurrences of old_str `x` in lines: 1, 3. Please ensure it is unique');
  });

  it('agrees with the SDK on two hits on one line, and matches across lines', () => {
    expect(replaceOnce('/memories/a', 'aa', 'a', 'b')).toEqual({ content: 'ba', line: 0 });
    expect(replaceOnce('/memories/a', 'one\ntwo\nthree', 'two\nthree', '2,3')).toEqual({ content: 'one\n2,3', line: 1 });
    expect(replaceOnce('/memories/a', 'only', '', '>')).toEqual({ content: '>only', line: 0 });
    expect(refusal(() => replaceOnce('/memories/a', 'a\nb', '', '>'))).toMatch(/in lines: 1, 2/);
  });

  it('inserts after line 0 to n, dropping one trailing newline', () => {
    expect(insertAt('a\nb', 0, 'top\n')).toBe('top\na\nb');
    expect(insertAt('a\nb', 2, 'end')).toBe('a\nb\nend');
    expect(insertAt('a\nb', 1, 'x\ny\n\n')).toBe('a\nx\ny\n\nb');
    expect(insertAt('', 1, 'z')).toBe('\nz');
    expect(refusal(() => insertAt('a\nb', 3, 'x'))).toBe('Invalid `insert_line` parameter: 3. It should be within the range of lines of the file: [0, 2]');
    expect(refusal(() => insertAt('a', -1, 'x'))).toMatch(/: -1\. .*\[0, 1\]/);
  });
});

describe('memory file recall chunks', () => {
  it('packs whole lines, splits a long one, drops blank chunks and keeps within the item ceiling', () => {
    expect(fileChunks('', 100)).toEqual([]);
    expect(fileChunks('\n  \n', 100)).toEqual([]);
    expect(fileChunks('a\nb', 100)).toEqual(['a\nb']);
    const lines = Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(99, '.'));
    const chunks = fileChunks(lines.join('\n'), 100);
    expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    expect(chunks.join('\n')).toBe(lines.join('\n'));
    expect(fileChunks('z'.repeat(4500), 100).map((c) => c.length)).toEqual([2000, 2000, 500]);
    expect(fileChunks('w'.repeat(10_000), 2).map((c) => c.length)).toEqual([5000, 5000]);
  });
});
