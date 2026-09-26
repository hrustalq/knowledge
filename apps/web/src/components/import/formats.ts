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
import { formatBytes, formatList } from '@/lib/format'

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

/** A message key and its parameters — resolved with `t()` at render (docs/features/18). */
export interface Message {
  key: string
  params?: Record<string, string>
}

export interface FileVerdict {
  ok: boolean
  parser?: ImportParserId
  label?: string
  /** Why it was refused — a message, resolved where it is shown. */
  reason?: Message
}

/**
 * The two refusals that must happen before the bytes move. Being told a 40 MB
 * file is the wrong type once it has finished uploading is the rudest thing an
 * import flow can do, so both checks run here and again on the server.
 *
 * Non-component code: no i18n instance here (it is per-app for SSR isolation),
 * so the verdict is a key + params and the component translates it.
 */
export function inspectFile(file: File, maxBytes: number): FileVerdict {
  const format = importFormatFor(file.name, file.type)
  if (!format) {
    const ext = /\.[^.]+$/.exec(file.name)?.[0]
    const formats = formatList(IMPORT_FORMATS.map((f) => f.label), 'disjunction')
    return {
      ok: false,
      reason: ext
        ? { key: 'import.verdict.unsupported', params: { ext, formats } }
        : { key: 'import.verdict.noExtension', params: { formats } },
    }
  }
  if (file.size > maxBytes) {
    return {
      ok: false,
      parser: format.parser,
      label: format.label,
      reason: { key: 'import.verdict.tooLarge', params: { size: formatBytes(file.size), limit: formatBytes(maxBytes) } },
    }
  }
  if (file.size === 0) {
    return { ok: false, parser: format.parser, label: format.label, reason: { key: 'import.verdict.empty' } }
  }
  return { ok: true, parser: format.parser, label: format.label }
}
