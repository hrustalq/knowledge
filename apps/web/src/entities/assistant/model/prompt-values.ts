import type { AssistantPromptField } from '@knowledge/contracts'

/** Answers keyed by field name: a string for choice/text, an array for checklist. */
export type PromptValues = Record<string, string | string[]>

/**
 * The starting answers for `fields`. The recommended option starts selected,
 * so confirming the suggestion is one Enter; `suggest: false` is the record of
 * an answer, which never shows a suggestion it skipped.
 */
export function blankValues(fields: readonly AssistantPromptField[], suggest = true): PromptValues {
  return Object.fromEntries(
    fields.map((f) => {
      if (f.type === 'text') return [f.name, '']
      const picks = suggest ? f.options.filter((o) => o.recommended).map((o) => o.value) : []
      return [f.name, f.type === 'checklist' ? picks : (picks[0] ?? '')]
    }),
  )
}

/** Enter answers from a radio or checkbox too, which have no implicit submit; a button or a multi-line box keeps its own Enter. */
export function submitOnEnter(e: KeyboardEvent, submit: () => void) {
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement || e.isComposing) return
  e.preventDefault()
  submit()
}
