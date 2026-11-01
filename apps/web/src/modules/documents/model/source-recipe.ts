import type { DocumentSourceRecipeState, SourceCheckFailure, SourceRecipe, SourceRecipeRule } from '@knowledge/contracts'

/**
 * Extraction recipes (#674, phase 2), the web's half: what needs a person's
 * attention, and the form's working copy. The server's `readRecipe` is the
 * validator; this only keeps half-typed rows out of a preview request.
 */

/** What the Source widget and the review page lead with, most urgent first. */
export type RecipeAttention = 'held' | 'proposal' | 'changed' | null

export function recipeAttention(state: DocumentSourceRecipeState | undefined): RecipeAttention {
  if (!state) return null
  if (state.heldAt) return 'held'
  if (state.proposal) return 'proposal'
  if (state.structureChangedAt) return 'changed'
  return null
}

export function emptyRecipe(): SourceRecipe {
  return { content: [], strip: [], headings: {}, landmarks: [], rules: [] }
}

export function cloneRecipe(recipe: SourceRecipe | null | undefined): SourceRecipe {
  // JSON, not structuredClone: the recipe arrives inside a reactive query result, and a Proxy will not clone.
  return recipe ? (JSON.parse(JSON.stringify({ ...emptyRecipe(), ...recipe })) as SourceRecipe) : emptyRecipe()
}

/** A blank rule of a kind, for Add rule and for switching a row's kind. */
export function blankRule(kind: SourceRecipeRule['kind']): SourceRecipeRule {
  return kind === 'drop-section' ? { kind, heading: '' } : { kind, from: '', to: '' }
}

/** The recipe as sent: blank selectors and unfinished rules left out. */
export function cleanRecipe(recipe: SourceRecipe): SourceRecipe {
  const list = (items: string[]) => items.map((s) => s.trim()).filter(Boolean)
  return {
    content: list(recipe.content),
    strip: list(recipe.strip),
    headings: Object.fromEntries(Object.entries(recipe.headings).filter(([, level]) => !!level)),
    landmarks: list(recipe.landmarks),
    rules: recipe.rules.filter((r) =>
      r.kind === 'drop-section' ? !!r.heading.trim() : r.kind === 'rename-heading' ? !!r.from.trim() && !!r.to.trim() : !!r.from.trim(),
    ),
  }
}

/**
 * The checks this recipe is held to, in the order the review lists them:
 * the same rule as the server's `checkExtraction` — landmarks when it names
 * any, headings standing in for them when it does not.
 */
export function appliedChecks(recipe: SourceRecipe): SourceCheckFailure[] {
  return ['no-content', recipe.landmarks.length > 0 ? 'landmark' : 'headings', 'words']
}
