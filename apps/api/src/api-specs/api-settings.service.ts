import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  API_TRY_MAX_REQUEST_BYTES,
  API_TRY_PROXY_MODES,
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

  async get(workspaceId: string): Promise<ApiSettingsResponse> {
    const row = await this.prisma.workspaceSettings.findUnique({ where: { workspaceId } });
    return {
      workspaceId,
      tryProxy: this.tryProxy(row?.apiTryProxyMode),
      tryLimits: {
        timeoutMs: this.config.get('API_TRY_TIMEOUT_MS', { infer: true }),
        maxRequestBytes: API_TRY_MAX_REQUEST_BYTES,
        maxResponseBytes: this.config.get('API_TRY_MAX_RESPONSE_BYTES', { infer: true }),
        perMinute: this.config.get('API_TRY_RATE_PER_MINUTE', { infer: true }),
      },
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
    return this.get(workspaceId);
  }
}
