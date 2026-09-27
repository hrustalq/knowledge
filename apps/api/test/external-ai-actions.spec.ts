import { describe, expect, it } from 'vitest';
import { resolveExternalAiActions } from '../src/ai/external-ai-actions.js';

// Issue #68: AI_EXTERNAL_ACTIONS_ENABLED is a ceiling, never a default a
// workspace can widen, and a clamp is reported rather than hidden.
describe('resolveExternalAiActions', () => {
  it('inherits the ceiling when the workspace has no opinion', () => {
    expect(resolveExternalAiActions(null, true)).toEqual({ requested: null, ceiling: true, effective: true, source: 'env' });
    expect(resolveExternalAiActions(undefined, false)).toEqual({
      requested: null,
      ceiling: false,
      effective: false,
      source: 'env',
    });
  });

  it('lets a workspace turn the actions off under an open ceiling', () => {
    expect(resolveExternalAiActions(false, true)).toEqual({ requested: false, ceiling: true, effective: false, source: 'db' });
  });

  it('never lets a workspace turn them on under a closed ceiling, and says so', () => {
    expect(resolveExternalAiActions(true, false)).toEqual({
      requested: true,
      ceiling: false,
      effective: false,
      source: 'clamped',
    });
  });

  it('reports an agreeing override as db', () => {
    expect(resolveExternalAiActions(true, true).source).toBe('db');
    expect(resolveExternalAiActions(false, false).source).toBe('db');
  });
});
