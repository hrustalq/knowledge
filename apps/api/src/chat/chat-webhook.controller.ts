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
 * `@Public()` because the caller is Telegram, not a session; what
 * authenticates it is the shared secret the platform echoes on every delivery,
 * checked against the stored hash before anything else is read. A wrong
 * secret is a 401 that touched nothing.
 *
 * The handler answers at once — Telegram redelivers what it thinks timed out,
 * and Slack allows three seconds — and the work continues detached in
 * {@link ChatAnswersService.receive}, which owns its own failures. A verified
 * delivery the bot has nothing to say to is still a 200: a non-2xx would only
 * make the platform retry it.
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
  ): Promise<{ ok: true }> {
    if (!this.enabled) throw new NotFoundException(t('error.chat.disabled'));
    const row = await this.integrations.find(id);
    if (!row || !row.enabled) throw new NotFoundException(t('error.chat.integrationNotFound', { id }));

    const adapter = this.registry.get(row.kind);
    const raw = {
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      body: req.rawBody?.toString('utf8') ?? '',
    };
    if (!adapter.verifyInbound(raw, row.inboundSecretHash)) {
      // The integration id and nothing else: the body is unauthenticated input.
      this.logger.warn({ msg: 'chat delivery refused: bad secret', integrationId: id });
      throw new UnauthorizedException(t('error.chat.invalidSecret'));
    }
    for (const inbound of adapter.parseInbound(raw, row.botUsername)) void this.answers.receive(row, inbound);
    return { ok: true };
  }
}
