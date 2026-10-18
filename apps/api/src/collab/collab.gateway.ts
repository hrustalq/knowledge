// SPIKE (#80 phase 0) — throwaway. Hocuspocus embedded behind a Nest WS gateway.
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnGatewayConnection, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket, Server } from 'ws';
import { Hocuspocus } from '@hocuspocus/server';
import { Redis as RedisExt } from '@hocuspocus/extension-redis';
import * as Y from 'yjs';
import { Redis as IORedis } from 'ioredis';
import { AccessService } from '../auth/access.service.js';
import { TokenAuthService } from '../auth/token-auth.service.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** In-memory "PG" for the spike; counts stores to measure the write rate. */
export const spikeStore = new Map<string, Uint8Array>();
export const spikeStats = { stores: 0, storeBytes: 0, loads: 0, seeds: 0 };

@WebSocketGateway({ path: '/v1/collab' })
export class CollabGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(CollabGateway.name);
  readonly hocuspocus: Hocuspocus;
  private readonly redis: IORedis;
  private readonly conns = new Map<WebSocket, ReturnType<Hocuspocus["handleConnection"]>>();

  constructor(
    config: ConfigService<Env, true>,
    private readonly tokenAuth: TokenAuthService,
    private readonly access: AccessService,
    private readonly prisma: PrismaService,
  ) {
    const redisUrl = new URL(config.get('REDIS_URL', { infer: true }));
    this.redis = new IORedis(config.get('REDIS_URL', { infer: true }));
    this.hocuspocus = new Hocuspocus({
      name: `api-${process.env.PORT ?? 3000}`,
      debounce: Number(process.env.COLLAB_STORE_DEBOUNCE_MS ?? 2000),
      maxDebounce: Number(process.env.COLLAB_STORE_MAX_DEBOUNCE_MS ?? 10000),
      quiet: true,
      extensions: [new RedisExt({ host: redisUrl.hostname, port: Number(redisUrl.port || 6379), prefix: 'kn:collab' })],
      onAuthenticate: async ({ token, documentName, connectionConfig }) => {
        if (token === 'deny') throw { reason: 'forbidden' };
        const principal = await this.tokenAuth.resolve(undefined);
        const [, documentId] = documentName.split(':').slice(1); // collab:{ws}:{doc}:{branch}
        const doc = await this.prisma.document.findUnique({ where: { id: documentId }, select: { workspaceId: true } });
        if (!doc) throw new Error('not found');
        await this.access.requireRole(principal, doc.workspaceId, 'viewer');
        const writer = await this.access
          .requireRole(principal, doc.workspaceId, 'editor')
          .then(() => true, () => false);
        connectionConfig.readOnly = !writer || token === 'ro';
        return { userId: principal.userId, workspaceId: doc.workspaceId };
      },
      onLoadDocument: async ({ documentName, document }) => {
        spikeStats.loads++;
        // Stand-in for PG `INSERT … ON CONFLICT DO NOTHING` + re-read, shared by both instances.
        const key = `kn:collab-spike:state:${documentName}`;
        const existing = await this.redis.getBuffer(key);
        if (existing) { Y.applyUpdate(document, new Uint8Array(existing)); return document; }
        const seeded = new Y.Doc();
        await new Promise((r) => setTimeout(r, Number(process.env.SPIKE_SEED_DELAY_MS ?? 0)));
        seeded.getText('probe').insert(0, 'SEED;');
        const won = await this.redis.set(key, Buffer.from(Y.encodeStateAsUpdate(seeded)), 'NX');
        spikeStats.seeds += won ? 1 : 0;
        const winner = won ? Y.encodeStateAsUpdate(seeded) : new Uint8Array((await this.redis.getBuffer(key))!);
        Y.applyUpdate(document, winner);
        return document;
      },
      onStoreDocument: async ({ documentName, document }) => {
        const state = Y.encodeStateAsUpdate(document);
        spikeStats.stores++;
        spikeStats.storeBytes += state.byteLength;
        spikeStore.set(documentName, state);
        await this.redis.set(`kn:collab-spike:state:${documentName}`, Buffer.from(state));
      },
    });
  }

  afterInit(_server: Server): void {
    this.logger.log('collab gateway up on /v1/collab');
    setInterval(() => {
      const m = process.memoryUsage();
      this.logger.log(`SPIKE stats ${JSON.stringify({ ...spikeStats, docs: this.hocuspocus.getDocumentsCount(), conns: this.hocuspocus.getConnectionsCount(), rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576) })}`);
    }, 10_000).unref();
  }

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers)) if (typeof v === 'string') headers.set(k, v);
    const req = new Request(`http://localhost${request.url ?? '/'}`, { headers });
    const conn = this.hocuspocus.handleConnection(socket, req, {});
    this.conns.set(socket, conn);
    socket.on('message', (data: Buffer) => conn.handleMessage(new Uint8Array(data)));
    socket.on('close', (code: number, reason: Buffer) => {
      conn.handleClose({ code, reason: reason.toString() } as CloseEvent);
      this.conns.delete(socket);
    });
    socket.on('pong', () => conn.touch());
  }
}
