import { Injectable, Logger } from '@nestjs/common';
import type { Connector } from '@prisma/client';
import { driftCheckMode, GITHUB_INSTALLATION_CONFIG_KEY, type ConnectorGithubAccessResponse } from '@knowledge/contracts';
import { activePurposes, eventRows, permissionRows } from './github-access.js';
import { GithubAppService } from './github-app.service.js';
import { GithubOauthService } from './github-oauth.service.js';

/**
 * One connector's standing with GitHub, for the access card (docs/features/36).
 *
 * Three questions, answered together because a person fixing one needs the
 * other two in view: what the installation has granted, against what the App
 * asks for and what this connector's features need; which GitHub account the
 * viewer is linked as; and where to go to change either.
 *
 * API-only and read-only. Every GitHub call is as the App (its JWT) — the grants
 * are the installation's, not the viewer's — so the card works for an admin
 * who has never linked a GitHub account. Nothing throws: a GitHub hiccup is an
 * `error` on the card, the `GithubBrowseService` envelope.
 */
@Injectable()
export class GithubAccessService {
  private readonly logger = new Logger(GithubAccessService.name);

  constructor(
    private readonly app: GithubAppService,
    private readonly oauth: GithubOauthService,
  ) {}

  async forConnector(row: Connector, userId: string): Promise<ConnectorGithubAccessResponse> {
    const config = (row.config ?? {}) as Record<string, unknown>;
    const installationId =
      typeof config[GITHUB_INSTALLATION_CONFIG_KEY] === 'string' ? String(config[GITHUB_INSTALLATION_CONFIG_KEY]).trim() : '';
    const auth: ConnectorGithubAccessResponse['auth'] = installationId ? 'app' : row.credential ? 'token' : 'none';

    const base: ConnectorGithubAccessResponse = {
      configured: this.app.configured && this.oauth.configured,
      auth,
      installation: null,
      appSettingsUrl: null,
      permissions: [],
      events: [],
      identity: null,
      reconnectUrl: null,
    };
    if (!base.configured) return base;

    // The viewer's identity and the way back through OAuth. The state carries
    // this page as its return path, so the callback lands the person here.
    const identity = await this.oauth.identityFor(userId);
    if (identity) {
      base.identity = {
        login: identity.githubLogin,
        avatarUrl: identity.githubAvatarUrl,
        usable: (await this.oauth.tokenFor(userId)) !== null,
      };
    }
    const state = this.oauth.sign(row.workspaceId, userId, `/settings/connectors/${row.id}`);
    base.reconnectUrl = state ? this.oauth.authorizeUrl(state, this.oauth.redirectUri(), { selectAccount: true }) : null;

    if (auth !== 'app') return base;

    try {
      const [grant, registration] = await Promise.all([
        this.app.installationGrant(installationId),
        this.app.registration(),
      ]);
      base.appSettingsUrl = registration?.settingsUrl ?? null;
      if (!grant) {
        // Uninstalled, or the App can no longer see it: the connector's syncs
        // are failing for the same reason, and this is where it gets said.
        return { ...base, error: 'GitHub no longer knows this installation — it may have been uninstalled.' };
      }
      const active = activePurposes({
        kind: row.kind,
        direction: row.direction,
        driftCheck: driftCheckMode(config),
      });
      return {
        ...base,
        installation: { ...grant.account, settingsUrl: grant.settingsUrl },
        permissions: permissionRows(grant.permissions, registration?.permissions ?? {}, active),
        events: eventRows(grant.events, registration?.events ?? [], active),
        ...(registration ? {} : { error: 'The App registration could not be read, so pending and missing cannot be told apart.' }),
      };
    } catch (err) {
      this.logger.warn(`github access for connector ${row.id} failed: ${(err as Error).message}`);
      return { ...base, error: (err as Error).message.slice(0, 200) };
    }
  }
}
