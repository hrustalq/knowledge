import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Request } from 'express';
import { AGENT_WEBHOOK_HEADERS, AGENT_WEBHOOK_PAYLOAD_MAX_CHARS } from '@knowledge/contracts';
import { Public } from '../auth/access.decorator.js';
import { verifyHmacSha256 } from '../common/hmac.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { AgentTriggerService, type TriggerSkip } from '../agents/agent-trigger.service.js';
import { AgentTriggersService } from './agent-triggers.service.js';

/** What a sender may use as a delivery id: it becomes `agent_runs.subject_key`. */
const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export interface AgentWebhookResponse {
  runId: string | null;
  /** Why nothing started — the trigger is off, the delivery was already seen, a guard held. */
  skipped?: TriggerSkip;
}

/**
 * A signed inbound webhook per agent trigger (#70): any system that can sign a
 * request can start an agent run.
 *
 * `@Public()` because the sender has no session; the trigger's own secret is
 * the authentication, the ConnectorWebhookController arrangement. The order of
 * the checks is the point:
 *
 *   1. the kill switch and the trigger exist — a 404 either way, so a probe
 *      learns nothing about which ids are real;
 *   2. the body is within `AGENT_WEBHOOK_MAX_BYTES` — before hashing it, so an
 *      unauthenticated caller cannot make the API hash megabytes;
 *   3. the signature, over `<timestamp>.<raw body>` — the timestamp is signed,
 *      so the replay window in step 4 cannot be dodged by rewriting a header;
 *   4. the timestamp is within `AGENT_WEBHOOK_TOLERANCE_SECONDS`;
 *   5. the delivery id — `webhook:<id>` is the run's subject, and
 *      `AgentTriggerService` refuses a subject it has started before.
 *
 * Then one `fire`, inline: at most one insert and one enqueue, the model work
 * is the worker's. Everything past step 5 — the trigger off, the owner over
 * budget, the cap reached — is still a 202, with the reason, because the
 * delivery was authentic and retrying it will not change the answer.
 */
@Controller('v1/ai/agents/triggers')
export class AgentWebhookController {
  private readonly enabled: boolean;
  private readonly maxBytes: number;
  private readonly toleranceSeconds: number;

  constructor(
    private readonly configured: AgentTriggersService,
    private readonly triggers: AgentTriggerService,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('AGENT_TRIGGERS_ENABLED', { infer: true }) === true;
    this.maxBytes = Number(config.get('AGENT_WEBHOOK_MAX_BYTES', { infer: true }) ?? 65_536);
    this.toleranceSeconds = Number(config.get('AGENT_WEBHOOK_TOLERANCE_SECONDS', { infer: true }) ?? 300);
  }

  @Post(':id/webhook')
  @Public()
  @HttpCode(202)
  @ApiExcludeEndpoint()
  async receive(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers() headers: Record<string, string>,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<AgentWebhookResponse> {
    const found = this.enabled ? await this.configured.forWebhook(id) : null;
    if (!found) throw new NotFoundException(t('error.ai.agentTriggerNotFound', { id }));
    const { trigger, secret } = found;

    const raw = req.rawBody ?? Buffer.alloc(0);
    if (raw.length > this.maxBytes) {
      throw new PayloadTooLargeException(t('error.ai.agentWebhookTooLarge', { max: this.maxBytes }));
    }

    if (!secret) throw new UnauthorizedException(t('error.ai.agentWebhookNotConfigured'));

    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const timestamp = lower[AGENT_WEBHOOK_HEADERS.timestamp] ?? '';
    const body = raw.toString('utf8');
    if (!/^\d{1,12}$/.test(timestamp) || !verifyHmacSha256(`${timestamp}.${body}`, secret, lower[AGENT_WEBHOOK_HEADERS.signature] ?? '')) {
      throw new UnauthorizedException(t('error.ai.agentWebhookBadSignature'));
    }
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > this.toleranceSeconds) {
      throw new UnauthorizedException(t('error.ai.agentWebhookStale', { seconds: this.toleranceSeconds }));
    }

    const deliveryId = lower[AGENT_WEBHOOK_HEADERS.delivery] ?? '';
    if (!DELIVERY_ID.test(deliveryId)) {
      throw new BadRequestException(t('error.ai.agentWebhookDeliveryId'));
    }

    const outcome = await this.triggers.fire(trigger, {
      workspaceId: trigger.workspaceId,
      event: { type: 'webhook', source: 'webhook', deliveryId },
      subjectKey: `webhook:${deliveryId}`,
      projectId: trigger.projectId,
      ...(body ? { payload: body.slice(0, AGENT_WEBHOOK_PAYLOAD_MAX_CHARS) } : {}),
    });
    return outcome.started ? { runId: outcome.runId } : { runId: null, skipped: outcome.reason };
  }
}
