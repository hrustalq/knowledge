import type { ExportFormat } from '@knowledge/contracts'

/**
 * Whether a format can be asked for (docs/features/45), from the formats the
 * deployment reports — `/v1/exports/capabilities` in the app, a share's
 * download offer in the reader (#161). Before that answer arrives, ZIP and
 * HTML are assumed and PDF is not, since only PDF needs a service.
 */
export function exportFormatAvailable(formats: Record<ExportFormat, boolean> | null | undefined, format: ExportFormat): boolean {
  return formats?.[format] ?? format !== 'pdf'
}
