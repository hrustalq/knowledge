import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ConnectorCapabilities, ConnectorKind } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import {
  ConnectorRequestError,
  connectorFetch,
  optionalConfig,
  type ConnectorAdapter,
  type ConnectorContext,
  type ExternalDocument,
  type ExternalRef,
  type HarvestDelivery,
  type HarvestItem,
} from './connector.types.js';

/** Each data region is its own API host. */
const API_HOSTS: Record<string, string> = {
  us: 'https://api.intercom.io',
  eu: 'https://api.eu.intercom.io',
  au: 'https://api.au.intercom.io',
};
const API_VERSION = '2.11';
/** The parts a person wrote: replies and internal notes. Assignments, closes and bots' parts say nothing. */
const SPOKEN_PARTS = new Set(['comment', 'note']);

/** `X-Hub-Signature`: `sha1=` and the hex HMAC-SHA1 of the raw body, keyed by the app's client secret. */
export function intercomSignature(secret: string, rawBody: string): string {
  return `sha1=${createHmac('sha1', secret).update(rawBody).digest('hex')}`;
}

/** Intercom bodies are HTML; a harvest reads text. */
export function intercomText(html: string | null | undefined): string {
  return (html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Intercom (#384), a **harvest** connector (doc 59): a conversation an admin
 * closes while it carries the harvest tag becomes reviewed captures in that
 * admin's name. No content moves; `list` and `fetch` are never called.
 *
 * The admin's Intercom app (Developer Hub) subscribes its webhook to
 * `conversation.admin.closed` at `/v1/connectors/:id/webhook`; the app's
 * **client secret** is the connector's webhook secret, and its access token
 * the credential. The region picks the API host.
 *
 * Intercom signs the body only — there is no signed timestamp to bound a
 * replay with. That is safe here: the claim is once per conversation, and the
 * sweeper re-reads the conversation before anything is harvested, so a
 * replayed delivery can neither harvest twice nor harvest something open.
 *
 * What is read is the opening message, every reply and every admin note —
 * customers' messages carry PII, which is why the harvest masks first.
 */
@Injectable()
export class IntercomAdapter implements ConnectorAdapter {
  readonly kind: ConnectorKind = 'intercom';
  readonly capabilities: ConnectorCapabilities = { pull: false, push: false, webhook: true, tree: false, harvest: true };

  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    const me = await this.get<{ name?: string; app?: { name?: string } }>(ctx, '/me');
    return { ok: true, detail: [me.app?.name, me.name].filter(Boolean).join(' · ') || undefined };
  }

  // eslint-disable-next-line require-yield
  async *list(): AsyncIterable<ExternalRef> {
    return;
  }

  fetch(): Promise<ExternalDocument> {
    return Promise.reject(new Error(t('error.connector.pullNotSupported', { kind: 'Intercom' })));
  }

  /** `conversation.admin.closed`, signed; who closed it is the author of its last `close` part. */
  verifyHarvestDelivery(ctx: ConnectorContext, headers: Record<string, string>, rawBody: string): HarvestDelivery | null {
    const secret = ctx.webhookSecret;
    const signature = headers['x-hub-signature'];
    if (!secret || !signature) return null;
    const a = Buffer.from(intercomSignature(secret, rawBody));
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const body = parseJson<IntercomNotification>(rawBody);
    const conversation = body?.data?.item;
    if (body?.topic !== 'conversation.admin.closed' || !conversation?.id) return { item: null };
    const close = [...(conversation.conversation_parts?.conversation_parts ?? [])].reverse().find((p) => p.part_type === 'close');
    const author = close?.author;
    if (author?.type !== 'admin' || !author.id) return { item: null };
    return {
      item: {
        externalId: String(conversation.id),
        actor: {
          externalId: String(author.id),
          ...(author.name ? { name: author.name } : {}),
          ...(author.email ? { email: author.email } : {}),
        },
      },
    };
  }

  /** The conversation now: closed or not, its tags, and what people said in it, oldest first. */
  async readHarvestItem(ctx: ConnectorContext, externalId: string): Promise<HarvestItem | null> {
    if (!/^\d+$/.test(externalId)) return null;
    let conversation: IntercomConversation;
    try {
      conversation = await this.get<IntercomConversation>(ctx, `/conversations/${externalId}`);
    } catch (err) {
      // Deleted, or not this token's to read: nothing to harvest.
      if (err instanceof ConnectorRequestError && (err.status === 404 || err.status === 403)) return null;
      throw err;
    }
    const opening = conversation.source;
    const parts = [
      ...(opening?.author?.id && opening.author.type !== 'bot'
        ? [{ authorId: String(opening.author.id), html: opening.body, at: conversation.created_at }]
        : []),
      // ponytail: the parts the conversation returns (Intercom caps them at 500); page if longer threads get harvested
      ...(conversation.conversation_parts?.conversation_parts ?? [])
        .filter((p) => SPOKEN_PARTS.has(p.part_type ?? '') && p.author?.id && p.author.type !== 'bot')
        .map((p) => ({ authorId: String(p.author!.id), html: p.body, at: p.created_at })),
    ];
    const messages = parts
      .map((p) => ({ authorId: p.authorId, text: intercomText(p.html), at: new Date((p.at ?? 0) * 1000) }))
      .filter((m) => m.text)
      .sort((x, y) => x.at.getTime() - y.at.getTime());
    const app = await this.get<{ app?: { id_code?: string } }>(ctx, '/me').catch(() => null);
    return {
      key: `#${externalId}`,
      title: conversation.title || opening?.subject || messages[0]?.text.split('\n')[0]?.slice(0, 80) || '',
      url: app?.app?.id_code ? `https://app.intercom.com/a/inbox/${app.app.id_code}/inbox/conversation/${externalId}` : '',
      resolved: conversation.state === 'closed',
      labels: (conversation.tags?.tags ?? []).flatMap((tag) => (tag.name ? [tag.name] : [])),
      messages,
    };
  }

  private async get<T>(ctx: ConnectorContext, path: string): Promise<T> {
    if (!ctx.credential) throw new Error(t('error.connector.credentialRequired'));
    const host = API_HOSTS[optionalConfig(ctx.config, 'region') ?? 'us'] ?? API_HOSTS.us;
    const res = await connectorFetch(
      `${host}${path}`,
      {
        headers: { authorization: `Bearer ${ctx.credential}`, accept: 'application/json', 'intercom-version': API_VERSION },
        signal: ctx.signal,
      },
      ctx,
    );
    return (await res.json()) as T;
  }
}

function parseJson<T>(raw: string): T | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}

interface IntercomAuthor {
  id?: string | number;
  type?: string;
  name?: string;
  email?: string;
}

interface IntercomPart {
  part_type?: string;
  body?: string | null;
  created_at?: number;
  author?: IntercomAuthor | null;
}

interface IntercomConversation {
  id?: string | number;
  title?: string | null;
  state?: string;
  created_at?: number;
  source?: { subject?: string; body?: string | null; author?: IntercomAuthor | null } | null;
  tags?: { tags?: Array<{ name?: string }> };
  conversation_parts?: { conversation_parts?: IntercomPart[] };
}

interface IntercomNotification {
  topic?: string;
  data?: { item?: IntercomConversation };
}
