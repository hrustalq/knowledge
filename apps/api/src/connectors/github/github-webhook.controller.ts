import { Controller, Headers, HttpCode, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Connector } from '@prisma/client';
import type { RepoEventType } from '@knowledge/contracts';
import { Public } from '../../auth/access.decorator.js';
import type { Env } from '../../config/env.js';
import { t } from '../../i18n/t.js';
import { safeJson, verifyHubSignature } from '../webhook-payload.js';
import { ConnectorsService } from '../connectors.service.js';
import { ConnectorWorkItemsService } from '../connector-work-items.service.js';
import { toWorkItem } from './github-issues.service.js';

/**
 * The App-level webhook (docs/features/32).
 *
 * Feature 30 left this out with a stated reason — "an App-level webhook has no
 * way to know which connector an event belongs to" — and that reason turned out
 * to be wrong. Every delivery carries `installation.id` and
 * `repository.full_name`, which together name exactly the connectors configured
 * against that installation and that repository. So this reverses that decision
 * rather than working around it, and the per-connector hook at
 * `/v1/connectors/:id/webhook` stays exactly as it was: it authenticates a
 * repository hook somebody configured by hand, this authenticates GitHub
 * delivering for a whole installation, and a repository can have both.
 *
 * `@Public()` for the reason the other one is: the caller is GitHub and has no
 * session. Authentication is the App's own HMAC over the **raw** body, which is
 * why `rawBody: true` is set in `main.ts` — Express has parsed and discarded the
 * original bytes by the time a handler runs, and re-serialising the parsed
 * object would not reproduce them byte for byte.
 *
 * Unlike the per-connector hook this one does its work inline rather than
 * enqueueing, and that is a deliberate difference: that hook starts a *sync*,
 * which is unbounded work and therefore a denial-of-service surface behind a
 * public URL. This one writes one row and publishes one frame per delivery,
 * bounded by the number of connectors on one repository.
 */
@Controller('v1/connectors/github')
export class GithubWebhookController {
  private readonly logger = new Logger(GithubWebhookController.name);
  private readonly secret: string;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly connectors: ConnectorsService,
    private readonly workItems: ConnectorWorkItemsService,
  ) {
    this.secret = this.config.get('GITHUB_APP_WEBHOOK_SECRET', { infer: true }).trim();
  }

  @Post('webhook')
  @Public()
  @HttpCode(202)
  @ApiExcludeEndpoint()
  async receive(
    @Headers() headers: Record<string, string>,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ accepted: boolean; handled: number }> {
    // No secret configured means the feature is off, and an unsigned delivery is
    // refused rather than trusted — the same shape as GITHUB_APP_ID being empty.
    if (!this.secret) throw new UnauthorizedException(t('error.connector.webhookNotConfigured'));

    const lower = lowercaseKeys(headers);
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    if (!verifyHubSignature(lower, rawBody, this.secret)) {
      // Answering 401 without having touched anything is the point of verifying first.
      throw new UnauthorizedException(t('error.connector.webhookInvalidSignature'));
    }

    const payload = safeJson(rawBody);
    const event = lower['x-github-event'] ?? '';
    if (!payload || !event) return { accepted: true, handled: 0 };

    const connectors = await this.connectorsFor(payload);
    if (connectors.length === 0) return { accepted: true, handled: 0 };

    let handled = 0;
    for (const row of connectors) {
      try {
        if (await this.dispatch(row, event, payload)) handled += 1;
      } catch (err) {
        // One connector's failure must not cost the others their delivery, and a
        // 500 back to GitHub would have it retry the whole fan-out.
        this.logger.warn(`github webhook ${event} failed for connector ${row.id}: ${(err as Error).message}`);
      }
    }
    return { accepted: true, handled };
  }

  // --- internals ---

  /**
   * The connectors this delivery is about.
   *
   * The lookup itself lives on ConnectorsService, which owns connector rows:
   * a controller holding PrismaService is a write with no service to wrap in a
   * transaction when it grows a second statement, and `make deps` enforces that.
   */
  private async connectorsFor(payload: Record<string, any>): Promise<Connector[]> {
    const installationId = payload.installation?.id;
    const fullName: unknown = payload.repository?.full_name;
    if (installationId === undefined || typeof fullName !== 'string') return [];
    return this.connectors.forGithubDelivery(String(installationId), fullName);
  }

  /** Map one delivery onto our vocabulary and record it. Returns false for events we ignore. */
  private async dispatch(row: Connector, event: string, payload: Record<string, any>): Promise<boolean> {
    const action: string = typeof payload.action === 'string' ? payload.action : '';

    if (event === 'issues') {
      const type = ISSUE_ACTIONS[action];
      if (!type || !payload.issue) return false;
      await this.workItems.applyDelivery(row, type, toWorkItem(payload.issue));
      return true;
    }

    if (event === 'issue_comment') {
      // Only `created`: an edited or deleted comment has not moved the work on,
      // and a flow that fired on every edit would fire on typo fixes.
      if (action !== 'created' || !payload.issue) return false;
      await this.workItems.applyDelivery(row, 'repo.issue.commented', toWorkItem(payload.issue));
      return true;
    }

    if (event === 'pull_request') {
      const pr = payload.pull_request;
      if (!pr) return false;
      // A merged pull request arrives as action `closed` with `merged: true`.
      // Splitting them here is what makes "done" and "abandoned" different
      // events downstream rather than one event nobody can filter.
      let type: RepoEventType | null = null;
      if (action === 'opened' || action === 'reopened') type = 'repo.pull-request.opened';
      else if (action === 'closed') type = pr.merged ? 'repo.pull-request.merged' : 'repo.pull-request.closed';
      if (!type) return false;
      // `toWorkItem` discriminates on a nested `pull_request` key, which a pull
      // request *payload* does not have — it is the pull request. Re-nesting the
      // one field it reads keeps a single state mapping for both shapes.
      await this.workItems.applyDelivery(row, type, toWorkItem({ ...pr, pull_request: { merged_at: pr.merged_at } }));
      return true;
    }

    if (event === 'push') {
      const ref: string = typeof payload.ref === 'string' ? payload.ref : '';
      await this.workItems.publishBare(row, 'repo.push', ref.replace(/^refs\/heads\//, '') || ref);
      return true;
    }

    if (event === 'release' && action === 'published') {
      const name: unknown = payload.release?.name ?? payload.release?.tag_name;
      await this.workItems.publishBare(row, 'repo.release.published', typeof name === 'string' ? name : '');
      return true;
    }

    // `installation`, `installation_repositories`, `ping`, `projects_v2_item`
    // and everything else: accepted and ignored. Board membership is read on
    // demand in one batched GraphQL query rather than reconstructed from an
    // event that names a card node id we would have to resolve back to an issue.
    return false;
  }
}

const ISSUE_ACTIONS: Record<string, RepoEventType | undefined> = {
  opened: 'repo.issue.opened',
  closed: 'repo.issue.closed',
  reopened: 'repo.issue.reopened',
  assigned: 'repo.issue.assigned',
  unassigned: 'repo.issue.assigned',
  labeled: 'repo.issue.labeled',
  unlabeled: 'repo.issue.labeled',
};

/** Node lowercases incoming header names, but a signature check should not bet on it. */
function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}
