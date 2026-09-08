/**
 * What the picker offers, and how a chosen file is described back to the user.
 *
 * The routing itself is not defined here — it lives in `importFormatFor` in the
 * contracts package, shared with the server's reserve guard and the worker's
 * parser registry. This file only adds the presentation the browser needs:
 * an icon, an accept string, and the two refusals worth making before an upload
 * starts rather than after it finishes.
 */
import {
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  Presentation,
  type LucideIcon,
} from 'lucide-vue-next'
import { IMPORT_FORMATS, importFormatFor, type ImportParserId } from '@knowledge/contracts'

export const PARSER_ICONS: Record<ImportParserId, LucideIcon> = {
  pdf: FileType2,
  docx: FileText,
  pptx: Presentation,
  html: FileCode2,
  tabular: FileSpreadsheet,
  structured: FileCode2,
  plaintext: FileText,
  ocr: FileImage,
}

/** `accept` for the file input: extensions and content types the server takes. */
export const ACCEPT_ATTR = IMPORT_FORMATS.flatMap((f) => [...f.extensions, ...f.contentTypes]).join(',')

export interface FileVerdict {
  ok: boolean
  parser?: ImportParserId
  label?: string
  /** Why it was refused — written to be shown as-is. */
  reason?: string
}

/**
 * The two refusals that must happen before the bytes move. Being told a 40 MB
 * file is the wrong type once it has finished uploading is the rudest thing an
 * import flow can do, so both checks run here and again on the server.
 */
export function inspectFile(file: File, maxBytes: number): FileVerdict {
  const format = importFormatFor(file.name, file.type)
  if (!format) {
    const ext = /\.[^.]+$/.exec(file.name)?.[0]
    return {
      ok: false,
      reason: ext
        ? `${ext} files can’t be imported yet. Try ${spokenList(IMPORT_FORMATS.map((f) => f.label))}.`
        : `That file has no extension, so there’s no way to tell what it is. Try ${spokenList(IMPORT_FORMATS.map((f) => f.label))}.`,
    }
  }
  if (file.size > maxBytes) {
    return {
      ok: false,
      parser: format.parser,
      label: format.label,
      reason: `That file is ${formatBytes(file.size)} — the limit is ${formatBytes(maxBytes)}.`,
    }
  }
  if (file.size === 0) {
    return { ok: false, parser: format.parser, label: format.label, reason: 'That file is empty.' }
  }
  return { ok: true, parser: format.parser, label: format.label }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function spokenList(values: string[]): string {
  const unique = [...new Set(values)]
  if (unique.length <= 1) return unique[0] ?? ''
  return `${unique.slice(0, -1).join(', ')} or ${unique[unique.length - 1]}`
}
