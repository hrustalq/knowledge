import type { Principal } from './principal.js';

/**
 * May this caller make a new workspace? Asked by `WorkspacesService.create`
 * and answered on /me as `canCreateWorkspace`, so the web offers the action
 * only where the API would take it (#1142).
 *
 * - `pinned`: a key pinned to one workspace stays there; a new tenant is outside its pin (#1092).
 * - `closed`: making a workspace makes its creator an admin there (#1091). With
 *   signup closed, accounts are handed out by an operator, and so are tenants.
 */
export function workspaceCreationRefusal(principal: Principal, signupEnabled: boolean): 'pinned' | 'closed' | null {
  if (principal.apiKey?.workspaceId) return 'pinned';
  if (!principal.isAdmin && principal.mode !== 'dev' && !signupEnabled) return 'closed';
  return null;
}
