import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PublishingSettingsOverride,
  PublishingSettingsResponse,
  PublishingSettingsValues,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * A workspace's publishing switches (docs/features/43, issue #77).
 *
 * The row is a sparse override of a code default that is `false` for anything
 * public, so an empty table reproduces "nothing is public" exactly. Above it
 * sits PUBLIC_SHARING_ENABLED, a ceiling rather than a default: with it off,
 * no workspace setting turns sharing on, and the settings page shows both the
 * switch and why it does nothing.
 */
@Injectable()
export class PublishingSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  ceiling(): PublishingSettingsResponse['ceiling'] {
    return {
      sharingEnabled: this.config.get('PUBLIC_SHARING_ENABLED', { infer: true }),
      maxTtlDays: this.config.get('SHARE_LINK_MAX_TTL_DAYS', { infer: true }),
    };
  }

  async override(workspaceId: string): Promise<PublishingSettingsOverride> {
    const row = await this.prisma.publishingSettings.findUnique({ where: { workspaceId } });
    return {
      allowShareLinks: row?.allowShareLinks ?? null,
      allowPasswordlessShares: row?.allowPasswordlessShares ?? null,
    };
  }

  async effective(workspaceId: string): Promise<PublishingSettingsValues> {
    const override = await this.override(workspaceId);
    return {
      allowShareLinks: this.ceiling().sharingEnabled && (override.allowShareLinks ?? false),
      allowPasswordlessShares: override.allowPasswordlessShares ?? false,
    };
  }

  async get(workspaceId: string): Promise<PublishingSettingsResponse> {
    const [override, effective] = await Promise.all([this.override(workspaceId), this.effective(workspaceId)]);
    return { workspaceId, effective, override, ceiling: this.ceiling() };
  }

  /** Write the sparse row. Every key is optional; `null` resets that key to the code default. */
  async update(workspaceId: string, patch: Partial<PublishingSettingsOverride>): Promise<PublishingSettingsResponse> {
    const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    await this.prisma.publishingSettings.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
    return this.get(workspaceId);
  }
}
