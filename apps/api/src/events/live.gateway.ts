import { HttpException, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { Subscription } from 'rxjs';
import type { WebSocket, Server } from 'ws';
import {
  errorCodeForStatus,
  type ApiErrorPayload,
  type KnowledgeEvent,
  type LiveClientMessage,
  type LiveServerMessage,
  type LiveTrackingConfig,
} from '@knowledge/contracts';
import { AccessService } from '../auth/access.service.js';
import { TokenAuthService } from '../auth/token-auth.service.js';
import type { Principal } from '../auth/principal.js';
import type { Env } from '../config/env.js';
import { EventsSubscriber } from './events.subscriber.js';
import { LiveVisibility } from './live-visibility.js';
import { DEFAULT_LOCALE, type Locale } from '@knowledge/contracts';
import { localeFromRequest } from '../i18n/locale.js';
import { t, withLocale } from '../i18n/t.js';
import { bindTrace, startTrace, withTrace } from '@knowledge/observability';

interface SocketState {
  principal: Principal;
  /** workspaceId → tracking config (ACL-checked at subscribe time). */
  subscriptions: Map<string, LiveTrackingConfig>;
  alive: boolean;
}

/** 'prefix.*' glob or exact match against an event type. */
function matchesType(pattern: string, type: string): boolean {
  return pattern === '*' || pattern === type || (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1)));
}

/**
 * Live tracked-entity updates (WS twin of the SSE feed, docs/features/04):
 * one Redis-fed stream fanned out per socket, filtered by BOTH access control
 * (viewer role per subscribed workspace, checked in PG before the
 * subscription exists — same deny-by-default stance as GraphService — and,
 * per frame, page restrictions through `LiveVisibility`, #76) and
 * tracking configuration (server-side LIVE_TRACKED_EVENTS allowlist ∩ the
 * client's per-subscription events/documents filters). Auth mirrors SSE:
 * ?token=<kn_|ks_> on the upgrade URL, resolved by TokenAuthService because
 * APP_GUARDs never run on WS upgrades. All errors are strict ApiErrorPayload
 * envelopes inside {type:'error'} frames; auth failures also close the socket
 * (4401). Lives in EventsApiModule — worker/MCP never load it.
 */
@WebSocketGateway({ path: '/v1/events/ws' })
export class LiveGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(LiveGateway.name);
  private readonly state = new Map<WebSocket, SocketState>();
  private readonly serverTracked: string[];
  private readonly maxSubscriptions: number;
  private readonly enabled: boolean;
  /** Per-socket language, resolved from the upgrade request (docs/features/18). */
  private readonly locales = new Map<WebSocket, Locale>();
  private eventsSub?: Subscription;
  private heartbeat?: NodeJS.Timeout;
  /** Frames are judged one at a time, so a slow ACL read never reorders them. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    config: ConfigService<Env, true>,
    private readonly tokenAuth: TokenAuthService,
    private readonly access: AccessService,
    private readonly events: EventsSubscriber,
    private readonly visibility: LiveVisibility,
  ) {
    this.enabled = config.get('LIVE_WS_ENABLED', { infer: true });
    this.serverTracked = config
      .get('LIVE_TRACKED_EVENTS', { infer: true })
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.maxSubscriptions = config.get('LIVE_WS_MAX_SUBSCRIPTIONS', { infer: true });
  }

  afterInit(_server: Server): void {
    // Single upstream subscription; per-socket filtering happens in fanOut.
    this.eventsSub = this.events.all().subscribe((event) => {
      this.queue = this.queue.then(() => this.fanOut(event)).catch((e: unknown) => {
        this.logger.warn(`Live fan-out failed: ${(e as Error)?.message ?? String(e)}`);
      });
    });
    this.heartbeat = setInterval(() => {
      for (const [socket, st] of this.state) {
        if (!st.alive) { socket.terminate(); continue; }
        st.alive = false;
        socket.ping();
      }
    }, 30_000);
    this.heartbeat.unref();
  }

  async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    // Middleware never runs on an upgrade, so there is no I18nContext here:
    // resolve once from the upgrade request and keep it on the socket.
    const locale = localeFromRequest(request);
    this.locales.set(socket, locale);
    if (!this.enabled) {
      this.sendError(socket, 503, t('ws.disabled', undefined, locale));
      socket.close(4503, 'live updates disabled');
      return;
    }
    // Listen before the first await. A client that subscribes from `onopen`
    // sends while the token is still being resolved below, and `ws` drops a
    // frame that arrives with no listener — no reply, no error (#75). Frames
    // wait on `ready` and run in arrival order once it settles; if
    // authentication fails they are discarded with the socket.
    let authenticated!: (ok: boolean) => void;
    const ready = new Promise<boolean>((resolve) => (authenticated = resolve));
    // Raw protocol (contracts LiveClientMessage) — @SubscribeMessage's
    // {event,data} envelope is skipped on purpose so browser clients can
    // speak plain JSON.
    // One wrap at the entry point: every t() inside handleMessage — including
    // those in AccessService — then answers in this socket's language.
    // One trace scope per message, for the same reason there is one withLocale
    // wrap here: an upgrade runs no middleware, so nothing upstream has opened
    // either scope. A message is the unit of work a request would have been.
    socket.on('message', (raw) => {
      const text = raw.toString();
      void ready.then((ok) => {
        if (!ok) return;
        return withTrace(
          startTrace('ws', {
            route: '/v1/events/ws',
            userId: this.state.get(socket)?.principal.userId,
          }),
          () => withLocale(locale, () => this.handleMessage(socket, text)),
        );
      });
    });
    socket.on('pong', () => {
      const st = this.state.get(socket);
      if (st) st.alive = true;
    });

    const url = new URL(request.url ?? '/', 'http://localhost');
    const header = request.headers['authorization'];
    const bearer = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : undefined;
    const token = bearer ?? (url.searchParams.get('token') || undefined);
    try {
      // withLocale so exceptions thrown deep inside tokenAuth come back
      // translated — their ambient t() has no request context out here.
      const principal = await withLocale(locale, () => this.tokenAuth.resolve(token));
      if (this.tokenAuth.blocksUnverified(principal)) {
        authenticated(false);
        socket.close(4403, 'email unverified');
        return;
      }
      this.state.set(socket, { principal, subscriptions: new Map(), alive: true });
      authenticated(true);
    } catch (e) {
      authenticated(false);
      this.sendError(socket, e);
      socket.close(4401, 'authentication failed');
    }
  }

  handleDisconnect(socket: WebSocket): void {
    this.state.delete(socket);
    this.locales.delete(socket);
  }

  onModuleDestroy(): void {
    this.eventsSub?.unsubscribe();
    if (this.heartbeat) clearInterval(this.heartbeat);
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    const st = this.state.get(socket);
    if (!st) return;
    let msg: LiveClientMessage;
    try {
      msg = JSON.parse(raw) as LiveClientMessage;
      if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') throw new Error('not a message');
    } catch {
      this.sendError(socket, 400, t('ws.badMessage', undefined, this.localeOf(socket)));
      return;
    }
    try {
      switch (msg.type) {
        case 'ping':
          this.send(socket, { type: 'pong' });
          return;
        case 'subscribe': {
          if (typeof msg.workspaceId !== 'string' || !msg.workspaceId) {
            this.sendError(socket, 400, t('ws.workspaceRequired', undefined, this.localeOf(socket)));
            return;
          }
          if (!st.subscriptions.has(msg.workspaceId) && st.subscriptions.size >= this.maxSubscriptions) {
            this.sendError(socket, 400, t('ws.subscriptionLimit', { max: this.maxSubscriptions }, this.localeOf(socket)));
            return;
          }
          // Access control: membership check in PG BEFORE the subscription exists.
          await this.access.requireRole(st.principal, msg.workspaceId, 'viewer');
          bindTrace({ workspaceId: msg.workspaceId });
          const tracking: LiveTrackingConfig = {
            events: Array.isArray(msg.tracking?.events) ? msg.tracking.events.filter((e) => typeof e === 'string').slice(0, 64) : undefined,
            documents: Array.isArray(msg.tracking?.documents) ? msg.tracking.documents.filter((d) => typeof d === 'string').slice(0, 256) : undefined,
          };
          st.subscriptions.set(msg.workspaceId, tracking);
          this.send(socket, { type: 'subscribed', workspaceId: msg.workspaceId, tracking });
          return;
        }
        case 'unsubscribe':
          st.subscriptions.delete(msg.workspaceId);
          this.send(socket, { type: 'unsubscribed', workspaceId: msg.workspaceId });
          return;
        default:
          this.sendError(
            socket,
            400,
            t('ws.unknownType', { type: String((msg as { type: unknown }).type).slice(0, 40) }, this.localeOf(socket)),
          );
      }
    } catch (e) {
      this.sendError(socket, e);
      if (e instanceof UnauthorizedException) socket.close(4401, 'authentication failed');
    }
  }

  private async fanOut(event: KnowledgeEvent): Promise<void> {
    if (!this.serverTracked.some((p) => matchesType(p, event.type))) return;
    this.visibility.observe(event);
    const targets: [WebSocket, SocketState][] = [];
    for (const [socket, st] of this.state) {
      const tracking = st.subscriptions.get(event.workspaceId);
      if (!tracking) continue; // not subscribed to this workspace → never delivered
      // An addressed frame (notification.created) belongs to one person; on a
      // workspace-wide bus, delivering it to the rest would broadcast who is
      // being notified about what (docs/features/22).
      if (event.userId && event.userId !== st.principal.userId) continue;
      if (tracking.events?.length && !tracking.events.some((p) => matchesType(p, event.type))) continue;
      if (tracking.documents?.length && (!event.documentId || !tracking.documents.includes(event.documentId))) continue;
      targets.push([socket, st]);
    }
    if (targets.length === 0) return;
    // Page restrictions (#76): a frame about a page reaches only those who can open it.
    const allowed = await this.visibility.allows(event, targets.map(([, st]) => st.principal));
    targets.forEach(([socket], i) => {
      if (allowed[i]) this.send(socket, { type: 'event', event });
    });
  }

  private localeOf(socket: WebSocket): Locale {
    return this.locales.get(socket) ?? DEFAULT_LOCALE;
  }

  private send(socket: WebSocket, message: LiveServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  private sendError(socket: WebSocket, statusOrError: number | unknown, message?: string): void {
    let payload: ApiErrorPayload;
    if (typeof statusOrError === 'number') {
      payload = this.errorPayload(statusOrError, message ?? 'Error');
    } else if (statusOrError instanceof HttpException) {
      payload = this.errorPayload(statusOrError.getStatus(), statusOrError.message);
    } else {
      this.logger.error(`Live gateway error: ${(statusOrError as Error)?.message ?? String(statusOrError)}`);
      payload = this.errorPayload(500, t('error.internal', undefined, this.localeOf(socket)));
    }
    this.send(socket, { type: 'error', error: payload });
  }

  private errorPayload(statusCode: number, message: string): ApiErrorPayload {
    return {
      statusCode,
      code: errorCodeForStatus(statusCode),
      message,
      path: '/v1/events/ws',
      timestamp: new Date().toISOString(),
      requestId: '',
    };
  }
}
