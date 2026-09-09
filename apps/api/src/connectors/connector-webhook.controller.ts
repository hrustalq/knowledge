import { Controller, Headers, HttpCode, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/access.decorator.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { t } from '../i18n/t.js';
import { ConnectorProducer } from './connector.producer.js';
import { ConnectorsService } from './connectors.service.js';

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
 * that syncs inline is a denial-of-service surface with a public URL.
 */
@Controller('v1/connectors')
export class ConnectorWebhookController {
  constructor(
    private readonly connectors: ConnectorsService,
    private readonly producer: ConnectorProducer,
  ) {}

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

    const adapter = this.connectors.adapterFor(row);
    if (!adapter.verifyWebhook) throw new UnauthorizedException(t('error.connector.webhookNotConfigured'));

    const ctx = await this.connectors.contextFor(row, async () => undefined);
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    const refs = adapter.verifyWebhook(ctx, lowercaseKeys(headers), rawBody);

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
