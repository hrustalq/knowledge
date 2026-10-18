import { vi } from 'vitest';
import { AuthPolicyService } from '../src/auth/auth-policy.service.js';

/**
 * An `AuthPolicyService` for a workspace with no sign-in policy (#75 phase 4):
 * nothing enforced, no enforced domain, nobody break-glass. What an empty
 * `workspace_settings` table produces, so specs written before the policy
 * existed keep testing exactly what they tested.
 */
export const noAuthPolicy = {
  enforce: async () => undefined,
  enforcedDomainFor: async () => null,
  isBreakGlass: () => false,
  invalidate: () => undefined,
  providersFor: async () => [],
} as unknown as AuthPolicyService;

export const ENFORCING_PROVIDER = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Corp SSO' };

/**
 * A real `AuthPolicyService` over a fake store where every workspace enforces
 * SSO through `ENFORCING_PROVIDER` — for the surfaces (REST, MCP, the live
 * socket) that must all meet the same check without knowing it exists.
 */
export function enforcingPolicy(settings: Record<string, unknown> = {}, env: Record<string, unknown> = {}) {
  const prisma = {
    workspaceSettings: {
      findUnique: vi.fn(async () => ({
        ssoEnforced: true,
        allowApiKeys: null,
        allowPasswordForAdmins: null,
        sessionMaxAgeHours: null,
        updatedAt: new Date(),
        ...settings,
      })),
    },
    identityProvider: { findMany: vi.fn(async () => [ENFORCING_PROVIDER]) },
  };
  const config = { get: (k: string) => ({ AUTH_SSO_ENABLED: true, AUTH_MODE: 'api-key', AUTH_SESSION_TTL_HOURS: 720, ...env })[k] };
  const audit = { record: vi.fn(async () => undefined) };
  return { policy: new AuthPolicyService(prisma as never, config as never, audit as never), prisma, audit };
}
