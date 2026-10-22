import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ConnectorCapabilities, ConnectorKind } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import {
  ConnectorRequestError,
  connectorFetch,
  type ConnectorAdapter,
  type ConnectorContext,
  type ExternalDocument,
  type ExternalRef,
  type HarvestDelivery,
  type HarvestItem,
} from './connector.types.js';

const LINEAR_API = 'https://api.linear.app/graphql';
/** Linear's own advice: refuse a delivery stamped more than a minute away. */
const MAX_AGE_MS = 60_000;
/** How Linear names an issue that is gone or not readable by the key. */
const NOT_FOUND_RE = /ENTITY_NOT_FOUND|not found/i;
/** Comments read per issue: one page, Linear's maximum. */
const COMMENTS = 250;

/** `Linear-Signature`: the hex HMAC-SHA256 of the raw body, keyed by the webhook's signing secret. */
export function linearSignature(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Linear (#382), a **harvest** connector (doc 59): no content moves either
 * way — `pull` and `push` are false, so `list` and `fetch` are never called —
 * and its only job is to say when an issue was completed, by whom, and what
 * was said on it.
 *
 * The webhook is created in Linear (Settings → API → Webhooks) on **Issues**,
 * pointed at `/v1/connectors/:id/webhook`, and its signing secret is pasted
 * as the connector's webhook secret. The credential is a personal API key,
 * sent bare in `Authorization` as Linear asks; it must be able to read the
 * teams whose issues are harvested.
 */
@Injectable()
export class LinearAdapter implements ConnectorAdapter {
  readonly kind: ConnectorKind = 'linear';
  readonly capabilities: ConnectorCapabilities = { pull: false, push: false, webhook: true, tree: false, harvest: true };

  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    const { viewer } = await this.query<{ viewer?: { name?: string; organization?: { name?: string } } }>(
      ctx,
      '{ viewer { name organization { name } } }',
    );
    return { ok: true, detail: [viewer?.organization?.name, viewer?.name].filter(Boolean).join(' · ') || undefined };
  }

  // eslint-disable-next-line require-yield
  async *list(): AsyncIterable<ExternalRef> {
    return;
  }

  fetch(): Promise<ExternalDocument> {
    return Promise.reject(new Error(t('error.connector.pullNotSupported', { kind: 'Linear' })));
  }

  /**
   * An `Issue` update whose state changed, by a user. Whether the new state
   * is a completed one, and whether the issue carries the label, is read
   * fresh by {@link readHarvestItem}: the payload's issue shape is not one
   * Linear documents, and a stale delivery must not decide anything.
   */
  verifyHarvestDelivery(ctx: ConnectorContext, headers: Record<string, string>, rawBody: string): HarvestDelivery | null {
    const secret = ctx.webhookSecret;
    const signature = headers['linear-signature'];
    if (!secret || !signature || !/^[0-9a-f]{64}$/i.test(signature)) return null;
    const a = Buffer.from(linearSignature(secret, rawBody), 'hex');
    const b = Buffer.from(signature, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const body = parseJson<LinearWebhook>(rawBody);
    if (!body || typeof body.webhookTimestamp !== 'number' || Math.abs(Date.now() - body.webhookTimestamp) > MAX_AGE_MS) return null;
    const actor = body.actor;
    const changedState = !!body.updatedFrom && 'stateId' in body.updatedFrom;
    if (body.type !== 'Issue' || body.action !== 'update' || !changedState || !body.data?.id || actor?.type !== 'user' || !actor.id) {
      return { item: null };
    }
    return {
      item: {
        externalId: body.data.id,
        actor: { externalId: actor.id, ...(actor.name ? { name: actor.name } : {}), ...(actor.email ? { email: actor.email } : {}) },
      },
    };
  }

  /** The issue now: completed or not, its labels, and its description and comments as a thread. */
  async readHarvestItem(ctx: ConnectorContext, externalId: string): Promise<HarvestItem | null> {
    const { issue } = await this.query<{ issue?: LinearIssue | null }>(
      ctx,
      `query($id: String!) { issue(id: $id) {
        identifier title url description createdAt
        creator { id }
        state { type }
        labels { nodes { name } }
        comments(first: ${COMMENTS}) { nodes { body createdAt user { id } } }
      } }`,
      { id: externalId },
    ).catch((err: unknown) => {
      // Gone, or not this key's to read: nothing to harvest, not a failure to retry.
      // Linear says so as a GraphQL error, with or without a non-2xx status.
      if ((err instanceof LinearError && err.notFound) || (err instanceof ConnectorRequestError && NOT_FOUND_RE.test(err.message))) return { issue: null };
      throw err;
    });
    if (!issue) return null;
    const messages = [
      ...(issue.description?.trim() && issue.creator?.id ? [{ authorId: issue.creator.id, text: issue.description.trim(), at: new Date(issue.createdAt ?? 0) }] : []),
      ...(issue.comments?.nodes ?? [])
        .filter((c) => c.body?.trim() && c.user?.id)
        .map((c) => ({ authorId: c.user!.id!, text: c.body!.trim(), at: new Date(c.createdAt ?? 0) })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    return {
      key: issue.identifier ?? externalId,
      title: issue.title ?? '',
      url: issue.url ?? '',
      resolved: issue.state?.type === 'completed',
      labels: (issue.labels?.nodes ?? []).flatMap((l) => (l.name ? [l.name] : [])),
      messages,
    };
  }

  private async query<T>(ctx: ConnectorContext, query: string, variables?: Record<string, unknown>): Promise<T> {
    if (!ctx.credential) throw new Error(t('error.connector.credentialRequired'));
    const res = await connectorFetch(
      LINEAR_API,
      {
        method: 'POST',
        headers: { authorization: ctx.credential, 'content-type': 'application/json' },
        body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
        signal: ctx.signal,
      },
      ctx,
    );
    const json = (await res.json()) as { data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> };
    if (json.errors?.length) {
      const [first] = json.errors;
      throw new LinearError(`linear: ${first.message ?? 'error'}`, NOT_FOUND_RE.test(`${first.extensions?.code ?? ''} ${first.message ?? ''}`));
    }
    return (json.data ?? {}) as T;
  }
}

class LinearError extends Error {
  constructor(
    message: string,
    readonly notFound: boolean,
  ) {
    super(message);
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

interface LinearWebhook {
  action?: string;
  type?: string;
  actor?: { id?: string; type?: string; name?: string; email?: string } | null;
  data?: { id?: string };
  updatedFrom?: Record<string, unknown>;
  webhookTimestamp?: number;
}

interface LinearIssue {
  identifier?: string;
  title?: string;
  url?: string;
  description?: string | null;
  createdAt?: string;
  creator?: { id?: string } | null;
  state?: { type?: string } | null;
  labels?: { nodes?: Array<{ name?: string }> };
  comments?: { nodes?: Array<{ body?: string; createdAt?: string; user?: { id?: string } | null }> };
}
