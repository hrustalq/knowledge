import type { AiSettingsSource, ExternalAiActionsSettings } from '@knowledge/contracts';

/**
 * Resolve the page menu's external AI actions switch (issue #68).
 *
 * The env flag is a ceiling: a workspace may turn the actions off under an
 * env `true`, never on under an env `false`. `requested` is kept beside
 * `effective` and `source` says `clamped` when the ceiling won, because a
 * silent clamp lies about what the workspace is configured to do — the same
 * shape as `SourcePolicyService.webAccess`.
 */
export function resolveExternalAiActions(
  requested: boolean | null | undefined,
  ceiling: boolean,
): ExternalAiActionsSettings {
  const asked = typeof requested === 'boolean' ? requested : null;
  const effective = asked === null ? ceiling : asked && ceiling;
  const source: AiSettingsSource = asked === null ? 'env' : effective === asked ? 'db' : 'clamped';
  return { requested: asked, ceiling, effective, source };
}
