import { Controller, Headers, HttpCode, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/access.decorator.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { ConnectorProducer } from './connector.producer.js';
import { ConnectorsService } from './connectors.service.js';
import { REPO_CONNECTOR_KINDS } from './code-research/repo-snapshot.service.js';
import { DriftTriggerService } from './drift/drift-trigger.service.js';
import {
  isPullRequestEvent,
  readMergedDelivery,
  readPullRequestDelivery,
  verifyRepoDelivery,
} from './drift/pull-request-delivery.js';
import { readRepoPushDelivery, safeJson } from './webhook-payload.js';
import { ConnectorWorkItemsService } from './connector-work-items.service.js';
import { TrackerRegistry } from './tracker-registry.service.js';
import { ConnectorHarvestSweeper } from './harvest/connector-harvest.sweeper.js';

/**
 * Inbound webhooks from external systems (docs/features/19).
 *
 * `@Public()` on purpose: the caller is Confluence or GitHub, which has no
 * session. Authentication is the connector's own HMAC secret verified by its
 * adapter over the **raw** body — hence `rawBody: true` in main.ts, since
 * Express has already parsed and discarded the original bytes by the time a
 * handler runs, and re-serialising the parsed object would not reproduce them.
 *
 * The handler does no work beyond verifying and enqueueing: a webhook endpoint
 * that syncs inline is a denial-of-service surface with a public URL. The one
 * exception in shape is a pull or merge request on a repository connector,
 * which queues a drift check (docs/features/35) instead of a sync — still one
 * insert at most, and the model work is the worker's.
 */
@Controller('v1/connectors')
export class ConnectorWebhookController {
  constructor(
    private readonly connectors: ConnectorsService,
    private readonly producer: ConnectorProducer,
    private readonly drift: DriftTriggerService,
    private readonly trackers: TrackerRegistry,
    private readonly workItems: ConnectorWorkItemsService,
    private readonly harvests: ConnectorHarvestSweeper,
    config: ConfigService<Env, true>,
  ) {
    this.debounceMs = config.get('WIKI_PUSH_DEBOUNCE_MS', { infer: true });
  }

  private readonly debounceMs: number;

  @Post(':id/webhook')
  @Public()
  @HttpCode(202)
  @ApiExcludeEndpoint()
  async receive(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers() headers: Record<string, string>,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ accepted: boolean; runId: string | null }> {
    const row = await this.connectors.require(id);
    if (!row.enabled || !row.webhookSecret) {
      throw new UnauthorizedException(t('error.connector.webhookNotConfigured'));
    }

    const ctx = await this.connectors.contextFor(row, async () => undefined);
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    const lower = lowercaseKeys(headers);

    // A harvest connector (#382, doc 59): a resolved item is claimed, and the
    // API-side sweeper reads and harvests it. Nothing else to do here — a
    // harvest kind moves no content.
    const adapter = this.connectors.adapterFor(row);
    if (adapter.verifyHarvestDelivery) {
      const delivery = adapter.verifyHarvestDelivery(ctx, lower, rawBody);
      if (delivery === null) throw new UnauthorizedException(t('error.connector.webhookInvalidSignature'));
      if (delivery.item) await this.harvests.claim(row, delivery.item);
      return { accepted: true, runId: null };
    }

    // A tracker delivery (#424): a ticket changed. Written to the work-item
    // projection, which the sync sweeper reads on its next tick. A ticket
    // event is nothing else's business, and a Jira connector with no JQL is a
    // tracker only, so neither goes on to start a sync.
    const tracker = this.trackers.trackerFor(row);
    if (tracker?.verifyWebhook && ctx.webhookSecret) {
      const delivery = tracker.verifyWebhook(row, ctx.webhookSecret, lower, rawBody);
      if (delivery === null) throw new UnauthorizedException(t('error.connector.webhookInvalidSignature'));
      if (delivery.item) {
        await this.workItems.applyTrackerDelivery(row, delivery.item, delivery.actorId, await this.workItems.watchLabels(row));
        if (row.kind !== 'jira') return { accepted: true, runId: null };
      }
      if (row.kind === 'jira' && !String((row.config as { jql?: unknown } | null)?.jql ?? '').trim()) {
        return { accepted: true, runId: null };
      }
    }

    // A pull or merge request is not content moving, so it is not the
    // adapter's to verify (docs/features/35): `codebase` names no units from a delivery,
    // and `markdown-git`'s would read the missing `commits` as nothing to sync.
    // Verified here with the same secret, then handed to the drift check —
    // which does its own bounded work and never starts a sync.
    if (REPO_CONNECTOR_KINDS.has(row.kind)) {
      const payload = safeJson(rawBody);
      if (isPullRequestEvent(lower, payload)) {
        if (!ctx.webhookSecret || !verifyRepoDelivery(lower, rawBody, ctx.webhookSecret)) {
          throw new UnauthorizedException(t('error.connector.webhookInvalidSignature'));
        }
        const delivery = readPullRequestDelivery(lower, payload);
        if (delivery) return { accepted: true, runId: await this.drift.request(row, delivery) };
        // A merge is not a change to check but a fact about pages already
        // checked (docs/features/39): it starts no run, it moves their flags.
        const merged = readMergedDelivery(lower, payload);
        if (merged) await this.drift.merged(row, merged);
        return { accepted: true, runId: null };
      }
    }

    // A push or a release on a codebase connector regenerates its wiki
    // (docs/features/46): verified with the same secret, then one unscoped,
    // debounced run — or nothing, when the connector did not ask for it or the
    // push was to another branch. The adapter is not asked to name units,
    // because a push names files and units are not knowable from files.
    if (row.kind === 'codebase') {
      if (!ctx.webhookSecret || !verifyRepoDelivery(lower, rawBody, ctx.webhookSecret)) {
        throw new UnauthorizedException(t('error.connector.webhookInvalidSignature'));
      }
      const push = readRepoPushDelivery(lower, safeJson(rawBody));
      const run = push ? await this.connectors.queueRepoPush(row, push) : null;
      if (run) await this.producer.enqueue(run.id, { delayMs: this.debounceMs });
      return { accepted: true, runId: run?.id ?? null };
    }

    if (!adapter.verifyWebhook) throw new UnauthorizedException(t('error.connector.webhookNotConfigured'));

    const refs = adapter.verifyWebhook(ctx, lower, rawBody);

    // null = the signature did not verify. Answering 401 without touching
    // anything else is the whole point of doing verification first.
    if (refs === null) throw new UnauthorizedException(t('error.connector.webhookInvalidSignature'));
    // Verified, but nothing to sync (a ping or a handshake).
    if (refs.length === 0) return { accepted: true, runId: null };

    // A burst of edits produces a burst of webhooks, so the ids coalesce into a
    // run that is still queued rather than being refused — a running run's scope
    // is already frozen and would silently drop them.
    const run = await this.connectors.queueWebhookRefs(row, refs.map((r) => r.externalId));
    if (!run) return { accepted: true, runId: null };
    await this.producer.enqueue(run.id);
    return { accepted: true, runId: run.id };
  }
}

/** Node lowercases incoming header names, but a signature check should not bet on it. */
function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}
