import { describe, expect, it } from 'vitest';
import type { Principal } from '../src/auth/principal.js';
import { toMeResponse } from '../src/auth/me-response.js';
import { workspaceCreationRefusal } from '../src/auth/workspace-creation.js';

// #1140/#1142: the web offered "New workspace" to everyone, though with signup
// closed only a platform admin may make one (#1091) and a pinned key never may
// (#1092). /me says what the API would do, from the one rule the API asks.
const person = (over: Partial<Principal> = {}): Principal =>
  ({ userId: 'u1', email: 'a@example.test', displayName: 'A', avatarUrl: null, mode: 'session', isAdmin: false, locale: 'en', ...over }) as Principal;

describe('workspaceCreationRefusal', () => {
  it('lets anyone create while signup is open', () => {
    expect(workspaceCreationRefusal(person(), true)).toBeNull();
  });
  it('closes creation to a non-admin when signup is off', () => {
    expect(workspaceCreationRefusal(person(), false)).toBe('closed');
  });
  it('keeps it open to a platform admin and the dev principal', () => {
    expect(workspaceCreationRefusal(person({ isAdmin: true }), false)).toBeNull();
    expect(workspaceCreationRefusal(person({ mode: 'dev' }), false)).toBeNull();
  });
  it('refuses a key pinned to one workspace, admin or not', () => {
    const apiKey = { id: 'k', workspaceId: 'w1' } as Principal['apiKey'];
    expect(workspaceCreationRefusal(person({ mode: 'api-key', isAdmin: true, apiKey }), true)).toBe('pinned');
  });
});

describe('toMeResponse.canCreateWorkspace', () => {
  it('follows the rule', () => {
    expect(toMeResponse(person(), [], false, false).canCreateWorkspace).toBe(false);
    expect(toMeResponse(person(), [], false, true).canCreateWorkspace).toBe(true);
    expect(toMeResponse(person({ isAdmin: true }), [], false, false).canCreateWorkspace).toBe(true);
  });
});
