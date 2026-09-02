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
 * subscription exists — same deny-by-default stance as GraphService) and
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
  private eventsSub?: Subscription;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    config: ConfigService<Env, true>,
    private readonly tokenAuth: TokenAuthService,
    private readonly access: AccessService,
    private readonly events: EventsSubscriber,
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
    this.eventsSub = this.events.all().subscribe((event) => this.fanOut(event));
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
    if (!this.enabled) {
      this.sendError(socket, 503, 'Live updates are disabled (LIVE_WS_ENABLED=false)');
      socket.close(4503, 'live updates disabled');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    const header = request.headers['authorization'];
    const bearer = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : undefined;
    const token = bearer ?? (url.searchParams.get('token') || undefined);
    try {
      const principal = await this.tokenAuth.resolve(token);
      this.state.set(socket, { principal, subscriptions: new Map(), alive: true });
    } catch (e) {
      this.sendError(socket, e);
      socket.close(4401, 'authentication failed');
      return;
    }
    socket.on('pong', () => {
      const st = this.state.get(socket);
      if (st) st.alive = true;
    });
    // Raw protocol (contracts LiveClientMessage) — @SubscribeMessage's
    // {event,data} envelope is skipped on purpose so browser clients can
    // speak plain JSON.
    socket.on('message', (raw) => void this.handleMessage(socket, raw.toString()));
  }

  handleDisconnect(socket: WebSocket): void {
    this.state.delete(socket);
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
      this.sendError(socket, 400, `Malformed live message: ${raw.slice(0, 120)}`);
      return;
    }
    try {
      switch (msg.type) {
        case 'ping':
          this.send(socket, { type: 'pong' });
          return;
        case 'subscribe': {
          if (typeof msg.workspaceId !== 'string' || !msg.workspaceId) {
            this.sendError(socket, 400, 'subscribe requires a workspaceId');
            return;
          }
          if (!st.subscriptions.has(msg.workspaceId) && st.subscriptions.size >= this.maxSubscriptions) {
            this.sendError(socket, 400, `Subscription limit reached (${this.maxSubscriptions})`);
            return;
          }
          // Access control: membership check in PG BEFORE the subscription exists.
          await this.access.requireRole(st.principal, msg.workspaceId, 'viewer');
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
          this.sendError(socket, 400, `Unknown live message type: ${String((msg as { type: unknown }).type).slice(0, 40)}`);
      }
    } catch (e) {
      this.sendError(socket, e);
      if (e instanceof UnauthorizedException) socket.close(4401, 'authentication failed');
    }
  }

  private fanOut(event: KnowledgeEvent): void {
    if (!this.serverTracked.some((p) => matchesType(p, event.type))) return;
    for (const [socket, st] of this.state) {
      const tracking = st.subscriptions.get(event.workspaceId);
      if (!tracking) continue; // not subscribed to this workspace → never delivered
      if (tracking.events?.length && !tracking.events.some((p) => matchesType(p, event.type))) continue;
      if (tracking.documents?.length && (!event.documentId || !tracking.documents.includes(event.documentId))) continue;
      this.send(socket, { type: 'event', event });
    }
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
      payload = this.errorPayload(500, 'Internal server error');
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
