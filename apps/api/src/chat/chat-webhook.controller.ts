import { Controller, Headers, HttpCode, Logger, NotFoundException, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/access.decorator.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { ChatAdapterRegistry } from './adapters/chat-adapter.registry.js';
import { ChatAnswersService } from './chat-answers.service.js';
import { ChatIntegrationsService } from './chat-integrations.service.js';

/**
 * Deliveries from a messenger (issue #71).
 *
 * `@Public()` because the caller is a messenger, not a session. What
 * authenticates it is the adapter's check, before anything else is read: the
 * shared secret Telegram echoes on every delivery, or the signature a Time
 * button carries in its context. A failed check is a 401 that touched nothing.
 *
 * The handler answers at once — Telegram redelivers what it thinks timed out —
 * and the work continues detached in {@link ChatAnswersService.receive}, which
 * owns its own failures. A verified delivery the bot has nothing to say to is
 * still a 200: a non-2xx would only make the platform retry it.
 *
 * The one wait: a Time button press is answered in this response (the note
 * shown to the presser), so the adapter holds it until the core acknowledges
 * the press — `respondToAction`, bounded by the adapter. Time's messages never
 * come here; they arrive over the bot's websocket (`ChatSocketSupervisor`).
 */
@Controller('v1/chat')
export class ChatWebhookController {
  private readonly logger = new Logger(ChatWebhookController.name);
  private readonly enabled: boolean;

  constructor(
    private readonly integrations: ChatIntegrationsService,
    private readonly registry: ChatAdapterRegistry,
    private readonly answers: ChatAnswersService,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('CHAT_ENABLED', { infer: true });
  }

  @Post(':id/webhook')
  @Public()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async receive(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers() headers: Record<string, string>,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<unknown> {
    if (!this.enabled) throw new NotFoundException(t('error.chat.disabled'));
    const row = await this.integrations.find(id);
    if (!row || !row.enabled) throw new NotFoundException(t('error.chat.integrationNotFound', { id }));

    const adapter = this.registry.get(row.kind);
    const raw = {
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      body: req.rawBody?.toString('utf8') ?? '',
    };
    if (!adapter.verifyInbound(raw, row.inboundSecretHash, this.integrations.context(row))) {
      // The integration id and nothing else: the body is unauthenticated input.
      this.logger.warn({ msg: 'chat delivery refused: bad secret', integrationId: id });
      throw new UnauthorizedException(t('error.chat.invalidSecret'));
    }
    const replies: Array<Promise<unknown>> = [];
    for (const inbound of adapter.parseInbound(raw, row.botUsername)) {
      const handled = this.answers.receive(row, inbound);
      if (inbound.action && adapter.respondToAction) replies.push(adapter.respondToAction(inbound, handled));
    }
    // One press per delivery is all a platform sends; the first reply is the response.
    const [reply] = await Promise.all(replies);
    return reply ?? { ok: true };
  }
}
