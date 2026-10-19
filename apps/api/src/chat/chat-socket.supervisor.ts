import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatIntegration } from '@prisma/client';
import { Redis } from 'ioredis';
import WebSocket from 'ws';
import type { Env } from '../config/env.js';
import { guardedLookup } from '../common/safe-fetch.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChatAdapterRegistry } from './adapters/chat-adapter.registry.js';
import { ChatAnswersService } from './chat-answers.service.js';
import { ChatIntegrationsService } from './chat-integrations.service.js';

/** Reconnect delays after a drop, in ms; the last one repeats. Reset by the server's `hello`. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
/** We ping this often; a socket that has said nothing at all for {@link SILENCE_MS} is presumed dead. */
const PING_MS = 30_000;
const SILENCE_MS = 75_000;
const HANDSHAKE_MS = 15_000;
/** How long a post id stays claimed. Any replica that sees it later is late by far less. */
const CLAIM_TTL_SEC = 3_600;
const CLAIM_PREFIX = 'chat:time:posted:';

/** The part of a websocket the supervisor uses — what a spec's fake implements. */
export interface ChatSocket {
  on(event: 'open' | 'close' | 'pong' | 'ping', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'unexpected-response', listener: (req: unknown, res: { statusCode?: number }) => void): unknown;
  ping(): void;
  terminate(): void;
  removeAllListeners(): unknown;
}

export type ChatSocketFactory = (url: string, token: string) => ChatSocket;
/** DI tokens for substitutes (specs); production dials with `ws` and claims in Redis. */
export const CHAT_SOCKET_FACTORY = Symbol('CHAT_SOCKET_FACTORY');
export const CHAT_INBOX_CLAIMS = Symbol('CHAT_INBOX_CLAIMS');

/** First-come claim of a delivered post, shared by every API replica. */
export interface ChatInboxClaims {
  /** True for exactly one caller per key within the TTL. */
  claim(key: string): Promise<boolean>;
}

interface Connection {
  row: ChatIntegration;
  /** What, if it changes, means a different bot or server: reconnect. */
  fingerprint: string;
  socket: ChatSocket | null;
  attempt: number;
  retry: NodeJS.Timeout | null;
  alive: NodeJS.Timeout | null;
  lastHeard: number;
  /** The last status written to `webhookError`, so a flapping socket does not write on every drop. */
  status: string | null | undefined;
  closed: boolean;
}

/**
 * The second inbound path (issue #71, phase 4): Time delivers a bot's messages
 * over the bot's own websocket rather than to a webhook, so the API holds one
 * open socket per enabled Time bot and hands each `posted` event (and each
 * 📌 `reaction_added`, #82) to
 * {@link ChatAnswersService.receive} exactly as the webhook hands a Telegram
 * update — the same claim, the same refusals, the same reaper.
 *
 * A long-lived connection, not a schedule: the tick only compares the sockets
 * held with the bots enabled (a bot saved, switched off, given a new token or
 * moved to another server is picked up within CHAT_SOCKET_SYNC_MS). A dropped
 * socket reconnects on its own with backoff, and its last failure is written
 * where the settings page already shows a deaf bot's reason (`webhookError`).
 *
 * Every replica holds every socket, and Time sends each of them every message.
 * A post is therefore claimed in Redis before anything is done with it, so a
 * link instruction or a help reply goes out once, not once per replica; an
 * answer is held to one by its `chat_answers` row besides. If Redis is down
 * the claim is skipped (answers stay single through their row, notices may
 * repeat) rather than the bot going silent.
 *
 * A message sent while no socket is open is not seen: Time documents no
 * catch-up for a reconnecting client. The bot answers what it hears.
 */
@Injectable()
export class ChatSocketSupervisor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ChatSocketSupervisor.name);
  private readonly connections = new Map<string, Connection>();
  private readonly enabled: boolean;
  private readonly syncMs: number;
  private readonly allowPrivate: boolean;
  private readonly connect: ChatSocketFactory;
  private readonly claims: ChatInboxClaims;
  private redis: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChatAdapterRegistry,
    private readonly integrations: ChatIntegrationsService,
    private readonly answers: ChatAnswersService,
    config: ConfigService<Env, true>,
    @Optional() @Inject(CHAT_SOCKET_FACTORY) connect?: ChatSocketFactory,
    @Optional() @Inject(CHAT_INBOX_CLAIMS) claims?: ChatInboxClaims,
  ) {
    this.enabled = config.get('CHAT_ENABLED', { infer: true });
    this.syncMs = config.get('CHAT_SOCKET_SYNC_MS', { infer: true });
    this.allowPrivate = config.get('CHAT_ALLOW_PRIVATE_URLS', { infer: true });
    this.connect = connect ?? ((url, token) => this.dial(url, token));
    this.claims = claims ?? this.redisClaims(config.get('REDIS_URL', { infer: true }));
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    void this.sync();
    this.timer = setInterval(() => void this.sync(), this.syncMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    for (const id of [...this.connections.keys()]) this.close(id);
    void this.redis?.quit().catch(() => undefined);
  }

  /** Open what is enabled and not held, close what is held and no longer enabled, reopen what changed. */
  async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const rows = await this.prisma.chatIntegration.findMany({ where: { kind: 'time', enabled: true } });
      const wanted = new Map(rows.map((r) => [r.id, r]));
      for (const [id, conn] of this.connections) {
        const row = wanted.get(id);
        if (!row || fingerprint(row) !== conn.fingerprint) this.close(id);
        // Same bot, same server: only the settings around it moved (name, agent, locale).
        else conn.row = row;
      }
      for (const row of rows) if (!this.connections.has(row.id)) this.open(row);
    } catch (err) {
      this.logger.warn({ msg: 'chat socket sync failed', error: String(err) });
    } finally {
      this.syncing = false;
    }
  }

  /** Bots with a socket open and greeted — for specs and diagnostics. */
  connectedIds(): string[] {
    return [...this.connections.values()].filter((c) => c.status === null && c.socket).map((c) => c.row.id);
  }

  private open(row: ChatIntegration): void {
    const conn: Connection = {
      row,
      fingerprint: fingerprint(row),
      socket: null,
      attempt: 0,
      retry: null,
      alive: null,
      lastHeard: Date.now(),
      status: undefined,
      closed: false,
    };
    this.connections.set(row.id, conn);
    this.dialConnection(conn);
  }

  private dialConnection(conn: Connection): void {
    if (conn.closed) return;
    const ctx = this.integrations.context(conn.row);
    if (!ctx?.serverUrl) {
      void this.setStatus(conn, 'websocket: the bot token cannot be read (SETTINGS_ENCRYPTION_KEY)');
      return;
    }
    let socket: ChatSocket;
    try {
      socket = this.connect(this.registry.time.socketUrl(ctx.serverUrl), ctx.token);
    } catch (err) {
      return this.dropped(conn, `websocket: ${errorText(err)}`);
    }
    conn.socket = socket;
    conn.lastHeard = Date.now();
    let reason: string | null = null;

    socket.on('unexpected-response', (_req, res) => {
      reason = `websocket: the server answered HTTP ${res.statusCode ?? '?'}${res.statusCode === 401 ? ' (token refused)' : ''}`;
      socket.terminate();
    });
    socket.on('error', (err) => {
      reason ??= `websocket: ${errorText(err)}`;
    });
    socket.on('pong', () => (conn.lastHeard = Date.now()));
    socket.on('ping', () => (conn.lastHeard = Date.now()));
    socket.on('message', (data) => {
      conn.lastHeard = Date.now();
      void this.onFrame(conn, String(data));
    });
    socket.on('open', () => {
      conn.alive = setInterval(() => {
        if (Date.now() - conn.lastHeard > SILENCE_MS) {
          reason = 'websocket: no answer from the server';
          socket.terminate();
          return;
        }
        try {
          socket.ping();
        } catch {
          // A socket that cannot ping is closing; its close handler reconnects.
        }
      }, PING_MS);
      conn.alive.unref();
    });
    socket.on('close', () => {
      if (conn.alive) clearInterval(conn.alive);
      conn.alive = null;
      socket.removeAllListeners();
      if (conn.socket === socket) conn.socket = null;
      this.dropped(conn, reason ?? 'websocket: closed by the server');
    });
  }

  private dropped(conn: Connection, reason: string): void {
    if (conn.closed) return;
    void this.setStatus(conn, reason);
    const delay = BACKOFF_MS[Math.min(conn.attempt, BACKOFF_MS.length - 1)];
    conn.attempt++;
    this.logger.warn({ msg: 'chat socket dropped', integrationId: conn.row.id, reason, retryInMs: delay });
    conn.retry = setTimeout(() => {
      conn.retry = null;
      this.dialConnection(conn);
    }, delay);
    conn.retry.unref();
  }

  private close(id: string): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    conn.closed = true;
    this.connections.delete(id);
    if (conn.retry) clearTimeout(conn.retry);
    if (conn.alive) clearInterval(conn.alive);
    conn.socket?.removeAllListeners();
    conn.socket?.terminate();
  }

  private async onFrame(conn: Connection, raw: string): Promise<void> {
    let frame: { event?: string; data?: { post?: string } };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    if (frame.event === 'hello') {
      conn.attempt = 0;
      await this.setStatus(conn, null);
      return;
    }
    if (frame.event !== 'posted' && frame.event !== 'reaction_added') return;
    const inbound = this.registry.time.parseInbound({ headers: {}, body: raw }, conn.row.botUsername);
    if (!inbound.length) return;
    // A pin is claimed apart from its post, per person: the same person pinning
    // again within the claim's hour is the same request.
    const [first] = inbound;
    const key = first.harvestReaction ? `${first.messageId}:pin:${first.externalUserId}` : first.messageId;
    if (!(await this.claim(`${conn.row.id}:${key}`))) return;
    for (const message of inbound) await this.answers.receive(conn.row, message);
  }

  private async claim(key: string): Promise<boolean> {
    try {
      return await this.claims.claim(CLAIM_PREFIX + key);
    } catch (err) {
      this.logger.warn({ msg: 'chat inbox claim unavailable; handling anyway', error: String(err) });
      return true;
    }
  }

  /** `webhookError` = why the bot is deaf, or null once the server greeted us. Written only on change. */
  private async setStatus(conn: Connection, status: string | null): Promise<void> {
    if (conn.status === status) return;
    conn.status = status;
    try {
      await this.prisma.chatIntegration.updateMany({
        where: { id: conn.row.id },
        data: { webhookError: status?.slice(0, 500) ?? null },
      });
    } catch (err) {
      this.logger.warn({ msg: 'chat socket status not saved', integrationId: conn.row.id, error: String(err) });
    }
  }

  private dial(url: string, token: string): ChatSocket {
    return new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
      handshakeTimeout: HANDSHAKE_MS,
      // The server is an address an admin typed: resolve it through the SSRF guard, like every call to it.
      ...(this.allowPrivate ? {} : { lookup: guardedLookup as never }),
    }) as unknown as ChatSocket;
  }

  private redisClaims(url: string): ChatInboxClaims {
    return {
      claim: async (key) => {
        // Opened by the first message, not at boot: with CHAT_ENABLED off nothing dials Redis.
        this.redis ??= new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000 });
        return (await this.redis.set(key, '1', 'EX', CLAIM_TTL_SEC, 'NX')) === 'OK';
      },
    };
  }
}

function fingerprint(row: ChatIntegration): string {
  return `${row.serverUrl}\n${row.credential ?? ''}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
