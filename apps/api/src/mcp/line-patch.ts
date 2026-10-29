/** One replacement of `knowledge_patch_document` (#603), in the base text's 1-based line numbers. */
export interface LineEdit {
  /** First line replaced. `lineCount + 1` appends. */
  startLine: number;
  /** Last line replaced, inclusive. `startLine - 1` inserts before `startLine` without replacing. */
  endLine: number;
  /** The new lines; an empty string deletes the range. */
  content: string;
}

/**
 * Apply line-range edits to `text`. Every edit numbers lines as they are in
 * `text` — not as an earlier edit left them — so an agent can number all its
 * changes off the one read. Overlapping ranges are refused: their order would
 * decide the result, and the agent cannot see that order.
 */
export function applyLineEdits(text: string, edits: readonly LineEdit[]): string {
  // A trailing newline ends the last line rather than opening an empty one.
  const trailing = text.endsWith('\n');
  const lines = text === '' ? [] : (trailing ? text.slice(0, -1) : text).split('\n');

  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  let previousEnd = 0;
  for (const e of sorted) {
    if (e.startLine < 1 || e.startLine > lines.length + 1) {
      throw new Error(`startLine ${e.startLine} is outside the page: it has ${lines.length} lines (use ${lines.length + 1} to append).`);
    }
    if (e.endLine < e.startLine - 1 || e.endLine > lines.length) {
      throw new Error(`endLine ${e.endLine} must be between ${e.startLine - 1} (insert) and ${lines.length}.`);
    }
    if (e.startLine <= previousEnd) {
      throw new Error(`Edits overlap at line ${e.startLine}: give each line to one edit.`);
    }
    previousEnd = Math.max(previousEnd, e.endLine);
  }

  // Bottom-up, so an edit never shifts the lines of one still to apply.
  for (const e of sorted.reverse()) {
    lines.splice(e.startLine - 1, e.endLine - e.startLine + 1, ...(e.content === '' ? [] : e.content.replace(/\n$/, '').split('\n')));
  }
  return lines.length === 0 ? '' : lines.join('\n') + (trailing ? '\n' : '');
}
