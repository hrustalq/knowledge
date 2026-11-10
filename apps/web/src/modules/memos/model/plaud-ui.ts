import type { PlaudImportEntry, PlaudRules } from '@knowledge/contracts'

/**
 * Plaud auto-import (#864): how the queue reads. Three groups, in the order a
 * person acts on them — what waits for their yes, what a retry could fix, and
 * what only Plaud can move (a transcript the person starts in the Plaud app).
 * Imported and skipped rows are settled and not shown.
 */
export interface PlaudQueue {
  /** Transcribed by Plaud, waiting for a yes. */
  ready: PlaudImportEntry[]
  /** An import that was refused; its reason is on the row. */
  failed: PlaudImportEntry[]
  /** No Plaud transcript yet, whether or not the person already said yes. */
  waiting: PlaudImportEntry[]
}

export function groupPlaudImports(imports: readonly PlaudImportEntry[]): PlaudQueue {
  return {
    ready: imports.filter((i) => i.status === 'pending'),
    failed: imports.filter((i) => i.status === 'failed'),
    waiting: imports.filter((i) => i.status === 'waiting' || i.status === 'confirmed'),
  }
}

/** The rules as a form holds them: minutes, and strings that may be blank. */
export interface PlaudRulesForm {
  projectId: string | null
  since: string
  minMinutes: string
  nameIncludes: string
  nameExcludes: string
  serial: string
  confirm: 'ask' | 'auto'
}

export function toRulesForm(projectId: string | null, rules: PlaudRules, effective: { since: string; minSeconds: number; confirm: 'ask' | 'auto' }): PlaudRulesForm {
  return {
    projectId,
    // The defaults are shown as values: a blank date field would not say that nothing older is taken.
    since: rules.since ?? effective.since,
    minMinutes: String(Math.round(((rules.minSeconds ?? effective.minSeconds) / 60) * 10) / 10),
    nameIncludes: rules.nameIncludes ?? '',
    nameExcludes: rules.nameExcludes ?? '',
    serial: rules.serial ?? '',
    confirm: rules.confirm ?? effective.confirm,
  }
}

/** Sparse on the way out: a blank field is "no rule", so it is not sent. Null when the length is not a number. */
export function fromRulesForm(form: PlaudRulesForm): PlaudRules | null {
  const minutes = Number(form.minMinutes.replace(',', '.'))
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) return null
  const text = (value: string) => (value.trim() ? value.trim() : undefined)
  return {
    ...(form.since ? { since: form.since } : {}),
    minSeconds: Math.round(minutes * 60),
    ...(text(form.nameIncludes) ? { nameIncludes: text(form.nameIncludes) } : {}),
    ...(text(form.nameExcludes) ? { nameExcludes: text(form.nameExcludes) } : {}),
    ...(text(form.serial) ? { serial: text(form.serial) } : {}),
    confirm: form.confirm,
  }
}
