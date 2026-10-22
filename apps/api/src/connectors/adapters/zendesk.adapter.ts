import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ConnectorCapabilities, ConnectorKind } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import {
  ConnectorRequestError,
  connectorFetch,
  requireConfig,
  trimBaseUrl,
  type ConnectorAdapter,
  type ConnectorContext,
  type ExternalDocument,
  type ExternalRef,
  type HarvestDelivery,
  type HarvestItem,
} from './connector.types.js';

/** A delivery stamped further than this from now is refused as a replay. */
const MAX_AGE_MS = 5 * 60_000;
/** Comments read per ticket: one page, Zendesk's maximum. */
const COMMENTS = 100;

/**
 * `X-Zendesk-Webhook-Signature`: base64 HMAC-SHA256 over the
 * `X-Zendesk-Webhook-Signature-Timestamp` header and the raw body, keyed by
 * the webhook's signing secret.
 */
export function zendeskSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}${rawBody}`).digest('base64');
}

/**
 * Zendesk Support (#383), a **harvest** connector (doc 59): a solved ticket
 * carrying the harvest tag becomes reviewed captures in the name of the agent
 * who solved it. No content moves; `list` and `fetch` are never called.
 *
 * Zendesk has no "ticket solved" event to subscribe to on its own, so the
 * admin builds the trigger: *Ticket status changed to Solved* (and, to save
 * deliveries, *Tags contain the harvest tag*), with a **Notify webhook**
 * action whose JSON body is `ZENDESK_TRIGGER_BODY` (contracts). The webhook points
 * at `/v1/connectors/:id/webhook`; its signing secret is the connector's
 * webhook secret. The credential is `email:api-token`.
 *
 * What is read is every comment, public replies **and** internal notes — the
 * fix usually lives in a note (doc 59). Customers' messages carry PII, which
 * is why the harvest masks before any model reads them.
 */
@Injectable()
export class ZendeskAdapter implements ConnectorAdapter {
  readonly kind: ConnectorKind = 'zendesk';
  readonly capabilities: ConnectorCapabilities = { pull: false, push: false, webhook: true, tree: false, harvest: true };

  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    const { user } = await this.get<{ user?: { name?: string; role?: string } }>(ctx, '/api/v2/users/me.json');
    if (!user?.role || user.role === 'end-user') throw new Error(t('error.connector.zendeskAgentRequired'));
    return { ok: true, detail: user.name };
  }

  // eslint-disable-next-line require-yield
  async *list(): AsyncIterable<ExternalRef> {
    return;
  }

  fetch(): Promise<ExternalDocument> {
    return Promise.reject(new Error(t('error.connector.pullNotSupported', { kind: 'Zendesk' })));
  }

  /** The trigger's body, signed: a ticket now `solved` (or `closed`), by an agent the body names. */
  verifyHarvestDelivery(ctx: ConnectorContext, headers: Record<string, string>, rawBody: string): HarvestDelivery | null {
    const secret = ctx.webhookSecret;
    const signature = headers['x-zendesk-webhook-signature'];
    const timestamp = headers['x-zendesk-webhook-signature-timestamp'];
    if (!secret || !signature || !timestamp) return null;
    const a = Buffer.from(zendeskSignature(secret, timestamp, rawBody));
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const at = Date.parse(timestamp);
    if (!Number.isFinite(at) || Math.abs(Date.now() - at) > MAX_AGE_MS) return null;
    const body = parseJson<ZendeskTriggerBody>(rawBody);
    const ticket = String(body?.ticket_id ?? '').trim();
    const actor = String(body?.updated_by_id ?? '').trim();
    const status = String(body?.status ?? '').trim().toLowerCase();
    // `-1` is Zendesk itself (an automation), never a person.
    if (!/^\d+$/.test(ticket) || !/^\d+$/.test(actor) || (status !== 'solved' && status !== 'closed')) return { item: null };
    return {
      item: {
        externalId: ticket,
        actor: {
          externalId: actor,
          ...(body?.updated_by_name ? { name: String(body.updated_by_name) } : {}),
          ...(body?.updated_by_email ? { email: String(body.updated_by_email) } : {}),
        },
      },
    };
  }

  /** The ticket now and every comment on it, oldest first. */
  async readHarvestItem(ctx: ConnectorContext, externalId: string): Promise<HarvestItem | null> {
    if (!/^\d+$/.test(externalId)) return null;
    try {
      const { ticket } = await this.get<{ ticket?: ZendeskTicket }>(ctx, `/api/v2/tickets/${externalId}.json`);
      if (!ticket) return null;
      // ponytail: one page of 100 comments; follow next_page if longer tickets get harvested
      const { comments } = await this.get<{ comments?: ZendeskComment[] }>(
        ctx,
        `/api/v2/tickets/${externalId}/comments.json?sort_order=asc&per_page=${COMMENTS}`,
      );
      const status = (ticket.status ?? '').toLowerCase();
      return {
        key: `#${externalId}`,
        title: ticket.subject ?? '',
        url: `${zendeskBase(ctx)}/agent/tickets/${externalId}`,
        resolved: status === 'solved' || status === 'closed',
        labels: ticket.tags ?? [],
        messages: (comments ?? [])
          .filter((c) => c.author_id != null && c.body?.trim())
          .map((c) => ({ authorId: String(c.author_id), text: c.body!.trim(), at: new Date(c.created_at ?? 0) })),
      };
    } catch (err) {
      // Deleted, merged away, or not this agent's to read: nothing to harvest.
      if (err instanceof ConnectorRequestError && (err.status === 404 || err.status === 403)) return null;
      throw err;
    }
  }

  private async get<T>(ctx: ConnectorContext, path: string): Promise<T> {
    if (!ctx.credential) throw new Error(t('error.connector.credentialRequired'));
    const [email, token] = splitCredential(ctx.credential);
    const res = await connectorFetch(
      `${zendeskBase(ctx)}${path}`,
      {
        headers: { authorization: `Basic ${Buffer.from(`${email}/token:${token}`).toString('base64')}`, accept: 'application/json' },
        signal: ctx.signal,
      },
      ctx,
    );
    return (await res.json()) as T;
  }
}

function zendeskBase(ctx: Pick<ConnectorContext, 'config'>): string {
  return trimBaseUrl(requireConfig(ctx.config, 'baseUrl'));
}

/** `email:api-token`, split at the first colon — an API token holds none, an email may not. */
function splitCredential(raw: string): [string, string] {
  const at = raw.indexOf(':');
  return at < 0 ? [raw, ''] : [raw.slice(0, at), raw.slice(at + 1)];
}

function parseJson<T>(raw: string): T | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}

interface ZendeskTriggerBody {
  ticket_id?: unknown;
  status?: unknown;
  updated_by_id?: unknown;
  updated_by_name?: unknown;
  updated_by_email?: unknown;
}

interface ZendeskTicket {
  subject?: string;
  status?: string;
  tags?: string[];
}

interface ZendeskComment {
  author_id?: number | null;
  body?: string;
  public?: boolean;
  created_at?: string;
}
