import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  API_TRY_MAX_REQUEST_BYTES,
  API_TRY_PROXY_MODES,
  resolveApiBreakingChangePolicy,
  resolveApiTestRunner,
  type ApiBreakingChangePolicy,
  type ApiTestRunnerSettings,
  type ApiSettingsResponse,
  type ApiTryProxyMode,
  type ApiTryProxySettings,
  type UpdateApiSettingsRequest,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { SourcePolicyService } from '../ai/source-policy.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * A workspace's API reference settings (#78), in the sparse
 * `workspace_settings` row: `null` inherits, so an empty table is the env.
 *
 * The try-it proxy mode is clamped to API_TRY_PROXY_MODE, never widened by
 * it — the shape of web research's WEB_ACCESS_MODE (docs/features/25), and the
 * response carries both what was asked for and what applies, because a clamp
 * the settings page does not show is a lie about the configuration.
 *
 * The breaking-change policy (phase 6) has no env ceiling: `null` is `warn`,
 * and the merge gate reads it through `ApiSpecDiffService.breakingPolicy`,
 * which resolves it with the same contracts function.
 *
 * The server runner (#483, phase 5) is off unless API_TEST_RUNNER_MODE and the
 * workspace both say on; the worker reads it again before every run.
 */
@Injectable()
export class ApiSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly sourcePolicies: SourcePolicyService,
  ) {}

  get ceiling(): ApiTryProxyMode {
    return this.config.get('API_TRY_PROXY_MODE', { infer: true });
  }

  /** The narrower of the request and the ceiling; `off` is narrowest. */
  tryProxy(requested: string | null | undefined): ApiTryProxySettings {
    const ceiling = this.ceiling;
    const asked = API_TRY_PROXY_MODES.includes(requested as ApiTryProxyMode) ? (requested as ApiTryProxyMode) : null;
    const rank = (m: ApiTryProxyMode) => API_TRY_PROXY_MODES.indexOf(m);
    const effective = asked === null ? ceiling : rank(asked) <= rank(ceiling) ? asked : ceiling;
    return { requested: asked, ceiling, effective, source: asked === null ? 'env' : effective === asked ? 'db' : 'clamped' };
  }

  async effectiveTryMode(workspaceId: string): Promise<ApiTryProxyMode> {
    const row = await this.prisma.workspaceSettings.findUnique({ where: { workspaceId }, select: { apiTryProxyMode: true } });
    return this.tryProxy(row?.apiTryProxyMode).effective;
  }

  async testRunner(workspaceId: string): Promise<ApiTestRunnerSettings> {
    const row = await this.prisma.workspaceSettings.findUnique({ where: { workspaceId }, select: { apiTestRunner: true } });
    return resolveApiTestRunner(row?.apiTestRunner, this.config.get('API_TEST_RUNNER_MODE', { infer: true }));
  }

  async get(workspaceId: string): Promise<ApiSettingsResponse> {
    const row = await this.prisma.workspaceSettings.findUnique({ where: { workspaceId } });
    return {
      workspaceId,
      tryProxy: this.tryProxy(row?.apiTryProxyMode),
      breakingChanges: {
        requested: (row?.apiBreakingChangePolicy as ApiBreakingChangePolicy | null | undefined) ?? null,
        effective: resolveApiBreakingChangePolicy(row?.apiBreakingChangePolicy),
      },
      tryLimits: {
        timeoutMs: this.config.get('API_TRY_TIMEOUT_MS', { infer: true }),
        maxRequestBytes: API_TRY_MAX_REQUEST_BYTES,
        maxResponseBytes: this.config.get('API_TRY_MAX_RESPONSE_BYTES', { infer: true }),
        perMinute: this.config.get('API_TRY_RATE_PER_MINUTE', { infer: true }),
      },
      testRunner: resolveApiTestRunner(row?.apiTestRunner, this.config.get('API_TEST_RUNNER_MODE', { infer: true })),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  async update(workspaceId: string, patch: UpdateApiSettingsRequest, actorId?: string): Promise<ApiSettingsResponse> {
    if (patch.apiTryProxyMode !== undefined) {
      // An allowlist with nothing on it is a proxy that refuses everything and
      // reads as broken, so it is refused here, as web research refuses it.
      await this.sourcePolicies.assertModeSavable(workspaceId, patch.apiTryProxyMode);
      await this.prisma.workspaceSettings.upsert({
        where: { workspaceId },
        create: { workspaceId, apiTryProxyMode: patch.apiTryProxyMode, updatedBy: actorId ?? null },
        update: { apiTryProxyMode: patch.apiTryProxyMode, updatedBy: actorId ?? null },
      });
    }
    if (patch.apiBreakingChangePolicy !== undefined) {
      await this.prisma.workspaceSettings.upsert({
        where: { workspaceId },
        create: { workspaceId, apiBreakingChangePolicy: patch.apiBreakingChangePolicy, updatedBy: actorId ?? null },
        update: { apiBreakingChangePolicy: patch.apiBreakingChangePolicy, updatedBy: actorId ?? null },
      });
    }
    if (patch.apiTestRunner !== undefined) {
      await this.prisma.workspaceSettings.upsert({
        where: { workspaceId },
        create: { workspaceId, apiTestRunner: patch.apiTestRunner, updatedBy: actorId ?? null },
        update: { apiTestRunner: patch.apiTestRunner, updatedBy: actorId ?? null },
      });
    }
    return this.get(workspaceId);
  }
}
