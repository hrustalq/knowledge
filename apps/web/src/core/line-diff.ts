import type { DiffHunk, DiffLine } from '@knowledge/contracts'

/**
 * A line diff in the shape the API's compare endpoint returns.
 *
 * The server already diffs *revisions* (Phase 2, via the `diff` package), and
 * every diff the product shows until now has been between two things that exist
 * in Postgres. A staged connector item (docs/features/26) is neither: it is
 * markdown that has not been written yet, against a page head that has. There
 * is no revision id to compare, so there is no endpoint to call.
 *
 * Rather than add a diffing dependency to the web — or an endpoint that takes
 * two bodies, which is a compare endpoint that cannot cache — this produces
 * `DiffHunk[]` locally and `DiffView` renders it exactly as it renders a real
 * comparison. The output shape is the contract, so the two stay honest.
 *
 * Myers is deliberately not implemented here. Trimming the common prefix and
 * suffix collapses the realistic case — a page whose middle paragraph changed —
 * to a few lines either side, and a plain LCS table over what is left is both
 * shorter to read and easy to bound. Past that bound the honest answer is "this
 * side was replaced", which is also what a reviewer would conclude from a diff
 * where every line is marked.
 */

/** Above this, an LCS table stops being worth building; say "replaced" instead. */
const MAX_CELLS = 4_000_000

export interface LineDiff {
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  // An empty document is zero lines, not one empty one. `''.split('\n')` gives
  // `['']`, which would show a phantom deleted line against every new page —
  // exactly the `create` case, where there is nothing to delete.
  if (normalized === '') return []
  const lines = normalized.split('\n')
  // A trailing newline is a line terminator, not an empty final line: without
  // this every file ending in "\n" shows a phantom last line in the diff.
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The edit script, as a flat run of lines with no hunking yet. */
function editScript(before: string[], after: string[]): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 1
  let newNo = 1

  // Common prefix — emitted as context, and never enters the table.
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) {
    out.push({ kind: 'context', old: oldNo++, new: newNo++, text: before[head]! })
    head++
  }

  // Common suffix, measured but emitted last.
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }

  const a = before.slice(head, before.length - tail)
  const b = after.slice(head, after.length - tail)

  if (a.length * b.length > MAX_CELLS) {
    // Too big to align meaningfully: report the block as replaced.
    for (const text of a) out.push({ kind: 'deleted', old: oldNo++, text })
    for (const text of b) out.push({ kind: 'added', new: newNo++, text })
  } else if (a.length === 0 || b.length === 0) {
    for (const text of a) out.push({ kind: 'deleted', old: oldNo++, text })
    for (const text of b) out.push({ kind: 'added', new: newNo++, text })
  } else {
    // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
    const width = b.length + 1
    const lcs = new Uint32Array((a.length + 1) * width)
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i * width + j] =
          a[i] === b[j]
            ? lcs[(i + 1) * width + j + 1]! + 1
            : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        out.push({ kind: 'context', old: oldNo++, new: newNo++, text: a[i]! })
        i++
        j++
      } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
        out.push({ kind: 'deleted', old: oldNo++, text: a[i]! })
        i++
      } else {
        out.push({ kind: 'added', new: newNo++, text: b[j]! })
        j++
      }
    }
    while (i < a.length) out.push({ kind: 'deleted', old: oldNo++, text: a[i++]! })
    while (j < b.length) out.push({ kind: 'added', new: newNo++, text: b[j++]! })
  }

  for (let k = before.length - tail; k < before.length; k++) {
    out.push({ kind: 'context', old: oldNo++, new: newNo++, text: before[k]! })
  }
  return out
}

/** Group the edit script into hunks with `context` unchanged lines around each change. */
export function lineDiff(before: string, after: string, context = 3): LineDiff {
  const lines = editScript(splitLines(before), splitLines(after))

  const additions = lines.filter((l) => l.kind === 'added').length
  const deletions = lines.filter((l) => l.kind === 'deleted').length
  if (additions === 0 && deletions === 0) return { hunks: [], additions, deletions }

  // Which lines a hunk must include: every change, plus its context either side.
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.kind === 'context') return
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) {
      keep[k] = true
    }
  })

  const hunks: DiffHunk[] = []
  let run: DiffLine[] = []
  const flush = () => {
    if (!run.length) return
    const oldNumbers = run.filter((l) => l.old !== undefined).map((l) => l.old!)
    const newNumbers = run.filter((l) => l.new !== undefined).map((l) => l.new!)
    hunks.push({
      // An all-added hunk has no old lines at all; `0` is what a unified diff
      // header carries there, not the previous line's number.
      oldStart: oldNumbers[0] ?? 0,
      oldLines: oldNumbers.length,
      newStart: newNumbers[0] ?? 0,
      newLines: newNumbers.length,
      lines: run,
    })
    run = []
  }
  keep.forEach((wanted, index) => {
    if (wanted) run.push(lines[index]!)
    else flush()
  })
  flush()

  return { hunks, additions, deletions }
}
