/*
 * The Anthropic memory tool's rules (#1009), pure: path validation, the
 * listing and line-number formats, and the edits over a file's text. The
 * strings are the ones `BetaLocalFilesystemMemoryTool` (`@anthropic-ai/sdk`
 * 1.8.0) returns, which the documentation gives as the reference behaviour;
 * the differential e2e compares the two. Where this store differs on purpose,
 * the rule says so:
 *
 * - `create` overwrites a file that exists (the documentation allows it; the
 *   SDK refuses).
 * - Any `..` segment is refused, also one that would resolve inside
 *   `/memories`, also after URL-decoding, also with `\` as the separator. A
 *   path such as `/memoriesX` is outside `/memories` (the SDK maps it inside).
 * - Directories are implied by paths: an emptied directory is gone, and every
 *   directory's size is shown as `4.0K`.
 * - A file view stops past 16,000 characters, as Claude's tool description
 *   says, and says where it stopped.
 * - `str_replace` matches across lines; an omitted `new_str` deletes `old_str`.
 * - Image files (`.png`, `.jpg`, `.jpeg`) are refused: this store holds text.
 *
 * Every thrown `MemoryToolError` becomes the tool result
 * `{ content: 'Error: <message>', is_error: true }`, as the SDK's tool runner
 * turns a handler's throw into one.
 */

export const MEMORY_ROOT = '/memories';
export const MEMORY_TOOL_COMMANDS = ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'] as const;
export type MemoryToolCommandName = (typeof MEMORY_TOOL_COMMANDS)[number];

/** Past this many characters a file view stops: Claude's tool description promises it. */
export const VIEW_MAX_CHARS = 16_000;
/** A canonical path longer than this is refused: it is a unique-index key. */
export const PATH_MAX_CHARS = 1024;
/** Every directory's size in a listing: no row holds one, and 4.0K is what a POSIX directory shows. */
export const DIRECTORY_SIZE = '4.0K';
const LINE_NUMBER_WIDTH = 6;

/** A refusal the model reads as the tool's answer, not a failure of the request. */
export class MemoryToolError extends Error {}

export type MemoryToolCommand =
  | { command: 'view'; path: string; view_range?: number[] }
  | { command: 'create'; path: string; file_text: string }
  | { command: 'str_replace'; path: string; old_str: string; new_str: string }
  | { command: 'insert'; path: string; insert_line: number; insert_text: string }
  | { command: 'delete'; path: string }
  | { command: 'rename'; old_path: string; new_path: string };

/** The command a tool input names, before any field is checked: what decides the role it needs. */
export function commandOf(input: unknown): string | null {
  return input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string' ? (input as { command: string }).command : null;
}

export const isMemoryToolCommand = (value: string | null): value is MemoryToolCommandName => (MEMORY_TOOL_COMMANDS as readonly (string | null)[]).includes(value);

/** A tool input checked field by field. An unknown command gets the SDK's `<command> not implemented`. */
export function readCommand(input: unknown): MemoryToolCommand {
  const command = commandOf(input);
  if (command === null) throw new MemoryToolError('Invalid input: expected an object with a string `command`');
  if (!isMemoryToolCommand(command)) throw new MemoryToolError(`${command} not implemented`);
  const raw = input as Record<string, unknown>;
  const str = (field: string, optional = false): string => {
    const value = raw[field];
    if (value === undefined && optional) return '';
    if (typeof value !== 'string') throw new MemoryToolError(`Invalid input for ${command}: \`${field}\` must be a string`);
    return value;
  };
  const int = (field: string): number => {
    const value = raw[field];
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new MemoryToolError(`Invalid input for ${command}: \`${field}\` must be an integer`);
    return value;
  };
  switch (command) {
    case 'view': {
      const range = raw.view_range;
      if (range !== undefined && range !== null && (!Array.isArray(range) || range.some((n) => typeof n !== 'number' || !Number.isInteger(n)))) {
        throw new MemoryToolError('Invalid input for view: `view_range` must be an array of two integers');
      }
      return { command, path: str('path'), ...(Array.isArray(range) ? { view_range: range as number[] } : {}) };
    }
    case 'create':
      return { command, path: str('path'), file_text: str('file_text') };
    case 'str_replace':
      // `new_str` may be left out: the documentation says `old_str` is then deleted.
      return { command, path: str('path'), old_str: str('old_str'), new_str: str('new_str', true) };
    case 'insert':
      return { command, path: str('path'), insert_line: int('insert_line'), insert_text: str('insert_text') };
    case 'delete':
      return { command, path: str('path') };
    case 'rename':
      return { command, old_path: str('old_path'), new_path: str('new_path') };
  }
}

// --- paths ---------------------------------------------------------------

/** A path as stored: `/memories` for the root, else `/memories/a/b` with no empty, `.` or `..` segment. */
export interface MemoryPath {
  path: string;
  segments: string[];
}

export const isRoot = (p: MemoryPath): boolean => p.segments.length === 0;

/**
 * The canonical path `raw` names, or a refusal. The prefix is checked first,
 * as the SDK does, so `../x` is "must start with /memories" and
 * `/memories/../x` is "would escape".
 */
export function memoryPath(raw: string): MemoryPath {
  if (raw !== MEMORY_ROOT && !raw.startsWith(`${MEMORY_ROOT}/`)) throw new MemoryToolError(`Path must start with /memories, got: ${raw}`);
  for (const form of decodedForms(raw)) {
    if (form.split(/[/\\]/).includes('..')) throw new MemoryToolError(`Path ${raw} would escape /memories directory`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(form)) throw new MemoryToolError(`Path ${raw} contains a control character`);
  }
  const segments = raw.slice(MEMORY_ROOT.length).split('/').filter((s) => s !== '' && s !== '.');
  const path = segments.length ? `${MEMORY_ROOT}/${segments.join('/')}` : MEMORY_ROOT;
  if (path.length > PATH_MAX_CHARS) throw new MemoryToolError(`Path ${raw} is longer than ${PATH_MAX_CHARS} characters`);
  return { path, segments };
}

/** `raw` and each URL-decoding of it, until decoding changes nothing: `%252e%252e` is still `..`. */
function decodedForms(raw: string): string[] {
  const forms = [raw];
  for (let i = 0; i < 4; i++) {
    const last = forms[forms.length - 1]!;
    let next: string;
    try {
      next = decodeURIComponent(last);
    } catch {
      // A lone `%` is a character of the name, not an encoding.
      break;
    }
    if (next === last) break;
    forms.push(next);
  }
  return forms;
}

/** The paths strictly above `p`, root excluded: what must not be a file for `p` to exist. */
export function ancestorsOf(p: MemoryPath): string[] {
  return p.segments.slice(0, -1).map((_, i) => `${MEMORY_ROOT}/${p.segments.slice(0, i + 1).join('/')}`);
}

/** Whether `child` lies under the directory `parent` (canonical paths). */
export const isUnder = (child: string, parent: string): boolean => child.startsWith(`${parent}/`);

export const isImagePath = (path: string): boolean => /\.(png|jpe?g)$/i.test(path);

/** The honest answer for an image: nothing in this store can show one. */
export const imageRefused = (raw: string): MemoryToolError => new MemoryToolError(`${raw} is an image file. This memory store holds text files only`);

// --- reads ---------------------------------------------------------------

/** The SDK's human-readable size: `0B`, `512B`, `1.5K`, `2M`. */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B', 'K', 'M', 'G'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = bytes / Math.pow(k, i);
  return (size % 1 === 0 ? size.toString() : size.toFixed(1)) + sizes[i];
}

const numbered = (line: string, n: number) => `${String(n).padStart(LINE_NUMBER_WIDTH, ' ')}\t${line}`;

/**
 * A directory listed two levels deep, as the SDK lists one: names sorted per
 * directory, hidden items and `node_modules` skipped (and not entered), a
 * directory followed by what it holds. `files` are the files under `dir`
 * (canonical paths, sizes in bytes); `shown` is the path as the caller wrote it.
 */
export function directoryListing(shown: string, dir: MemoryPath, files: ReadonlyArray<{ path: string; size: number }>): string {
  type Node = { size: number | null; children: Map<string, Node> };
  const root: Node = { size: null, children: new Map() };
  for (const f of files) {
    const rel = f.path.slice(dir.path.length + 1).split('/');
    let node = root;
    rel.forEach((name, i) => {
      const last = i === rel.length - 1;
      let next = node.children.get(name);
      if (!next) node.children.set(name, (next = { size: last ? f.size : null, children: new Map() }));
      node = next;
    });
  }
  const lines = [`${DIRECTORY_SIZE}\t${shown}`];
  const walk = (node: Node, prefix: string, depth: number) => {
    for (const name of [...node.children.keys()].sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const child = node.children.get(name)!;
      const rel = prefix ? `${prefix}/${name}` : name;
      if (child.size === null) {
        lines.push(`${DIRECTORY_SIZE}\t${shown}/${rel}/`);
        if (depth < 2) walk(child, rel, depth + 1);
      } else {
        lines.push(`${formatFileSize(child.size)}\t${shown}/${rel}`);
      }
    }
  };
  walk(root, '', 1);
  return `Here're the files and directories up to 2 levels deep in ${shown}, excluding hidden items and node_modules:\n${lines.join('\n')}`;
}

/**
 * A file with 6-wide, 1-indexed line numbers. `view_range` is `[start, end]`,
 * `end` -1 for the last line, read as the SDK reads it. Past
 * `VIEW_MAX_CHARS` of text the view stops at a whole line and says so.
 */
export function fileView(shown: string, content: string, viewRange?: number[]): string {
  const lines = content.split('\n');
  let display = lines;
  let start = 1;
  if (viewRange && viewRange.length === 2) {
    const from = Math.max(1, viewRange[0]!) - 1;
    const to = viewRange[1] === -1 ? lines.length : viewRange[1];
    display = lines.slice(from, to);
    start = from + 1;
  }
  let kept = display;
  let note = '';
  if (display.join('\n').length > VIEW_MAX_CHARS) {
    // -1: the first line brings no newline before it.
    let used = -1;
    let count = 0;
    while (count < display.length && used + 1 + display[count]!.length <= VIEW_MAX_CHARS) used += 1 + display[count++]!.length;
    // A first line longer than the whole budget is shown cut, so the view is never empty.
    kept = count ? display.slice(0, count) : [display[0]!.slice(0, VIEW_MAX_CHARS)];
    const last = start + Math.max(count, 1) - 1;
    note = `\n[Truncated: past ${VIEW_MAX_CHARS.toLocaleString('en-US')} characters the view stops at line ${last} of ${lines.length}${count ? '' : ', cut short'}. Use view_range to read from line ${last + 1}.]`;
  }
  return `Here's the content of ${shown} with line numbers:\n${kept.map((line, i) => numbered(line, i + start)).join('\n')}${note}`;
}

export const pathMissing = (shown: string): MemoryToolError => new MemoryToolError(`The path ${shown} does not exist. Please provide a valid path.`);
export const notAFile = (shown: string): MemoryToolError => new MemoryToolError(`The path ${shown} is not a file.`);

// --- edits ---------------------------------------------------------------

/**
 * `str_replace` over a file's text. `old_str` must occur on exactly one line:
 * the SDK reports the lines it was found on, and so does this. Unlike the
 * SDK's per-line match, an `old_str` spanning lines is found too; for one
 * without a newline the two agree. The first occurrence is replaced.
 * Returns the new text and the (0-based) line the change starts on.
 */
export function replaceOnce(shown: string, content: string, oldStr: string, newStr: string): { content: string; line: number } {
  const lines = matchLines(content, oldStr);
  if (lines.length === 0) throw new MemoryToolError(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${shown}.`);
  if (lines.length > 1) throw new MemoryToolError(`No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lines.join(', ')}. Please ensure it is unique`);
  return { content: content.replace(oldStr, () => newStr), line: lines[0]! - 1 };
}

/** The 1-based lines an occurrence of `needle` starts on, each once, ascending. An empty needle is on every line, as `''.includes` has it. */
function matchLines(content: string, needle: string): number[] {
  const count = content.split('\n').length;
  if (!needle) return Array.from({ length: count }, (_, i) => i + 1);
  const found = new Set<number>();
  for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + 1)) found.add(content.slice(0, at).split('\n').length);
  return [...found].sort((a, b) => a - b);
}

/** What `str_replace` answers: two lines either side of the change, numbered, from the text as stored. */
export function editedSnippet(content: string, line: number): string {
  const lines = content.split('\n');
  const from = Math.max(0, line - 2);
  const to = Math.min(lines.length, line + 3);
  const snippet = lines.slice(from, to).map((l, i) => numbered(l, from + i + 1));
  return `The memory file has been edited. Here is the snippet showing the change (with line numbers):\n${snippet.join('\n')}`;
}

/** `insert`: `text` (one trailing newline dropped) after line `at`, 0 for the top; `at` runs 0 to the line count. */
export function insertAt(content: string, at: number, text: string): string {
  const lines = content.split('\n');
  if (at < 0 || at > lines.length) {
    throw new MemoryToolError(`Invalid \`insert_line\` parameter: ${at}. It should be within the range of lines of the file: [0, ${lines.length}]`);
  }
  lines.splice(at, 0, text.replace(/\n$/, ''));
  return lines.join('\n');
}

// --- recall --------------------------------------------------------------

/** Characters per recall chunk, at most, unless a file needs bigger ones to stay within the retain item ceiling. */
export const FILE_CHUNK_CHARS = 2_000;

/**
 * A file's text cut for recall: whole lines packed up to the chunk size, a
 * longer line split, blank chunks dropped. Never more than `maxChunks`: a
 * file that would need more is cut into equal slices instead.
 */
export function fileChunks(content: string, maxChunks: number): string[] {
  const size = Math.max(FILE_CHUNK_CHARS, Math.ceil(content.length / maxChunks));
  const chunks: string[] = [];
  let current = '';
  for (const line of content.split('\n')) {
    const piece = current ? `${current}\n${line}` : line;
    if (piece.length <= size) {
      current = piece;
      continue;
    }
    if (current) chunks.push(current);
    current = line;
    while (current.length > size) {
      chunks.push(current.slice(0, size));
      current = current.slice(size);
    }
  }
  if (current) chunks.push(current);
  const kept = chunks.filter((c) => c.trim());
  if (kept.length <= maxChunks) return kept;
  return Array.from({ length: Math.ceil(content.length / size) }, (_, i) => content.slice(i * size, (i + 1) * size)).filter((c) => c.trim());
}

/** The document id a file's recall chunks share: a retain of it replaces them all. Distinct from the graph's `graph:` prefix. */
export const FILE_DOCUMENT_PREFIX = 'file:';
export const fileDocumentId = (path: string): string => `${FILE_DOCUMENT_PREFIX}${path}`;
