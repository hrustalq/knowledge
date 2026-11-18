// Labels for the errors section (#1240). `process` and `source` are free-text
// columns: a value the catalogue does not know is shown as written.
import type { OpsProcessKind } from '@knowledge/contracts'

type Translate = { t: (key: string) => string; te: (key: string) => boolean }

/** A row written before processes were recorded, or by a process with no beacon (MCP stdio, a script), has none. */
export const processLabel = (p: OpsProcessKind | null, { t, te }: Translate): string =>
  p === null ? t('admin.errors.processNone') : te(`admin.monitoring.kinds.${p}`) ? t(`admin.monitoring.kinds.${p}`) : p

export const sourceLabel = (source: string, { t, te }: Translate): string =>
  te(`admin.errors.source.${source}`) ? t(`admin.errors.source.${source}`) : source

export const levelLabel = (level: string, { t, te }: Translate): string =>
  te(`admin.errors.level.${level}`) ? t(`admin.errors.level.${level}`) : level
