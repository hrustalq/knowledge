import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import { Hocuspocus, type onAuthenticatePayload } from '@hocuspocus/server';
import { Redis } from '@hocuspocus/extension-redis';
import { COLLAB_CLOSE_CODES, parseCollabDocName, type CollabDenyReason } from '@knowledge/contracts';
import { TokenAuthService } from '../auth/token-auth.service.js';
import type { Principal } from '../auth/principal.js';
import type { Env } from '../config/env.js';
import { PermissionService } from '../permissions/permission.service.js';
import { CollabDraftTooLargeError, CollabDraftsService } from './collab-drafts.service.js';

/** What a document connection carries once `onAuthenticate` accepted it. */
interface CollabContext {
  userId: string;
}

type ClientConnection = ReturnType<Hocuspocus['handleConnection']>;

/** Hocuspocus answers a thrown `{ reason }` with a per-document `permission-denied`. */
const deny = (reason: CollabDenyReason) => ({ reason });

/**
 * Shared drafts over Yjs (#80, docs/features/56): Hocuspocus embedded as a
 * library behind a second gateway on the same `WsAdapter` and port as
 * `/v1/events/ws`. Hocuspocus multiplexes documents over one socket, so
 * access is decided per document in `onAuthenticate`, from the page
 * permissions every REST route asks (feature 48): view to join, edit to
 * write. A refused document gets a reason, never its title.
 *
 * Instances share updates and awareness through `@hocuspocus/extension-redis`,
 * on its own connections — CRDT traffic never rides the best-effort
 * `knowledge:events` bus. API-only: worker and MCP never load it.
 */
@WebSocketGateway({ path: '/v1/collab' })
export class CollabGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(CollabGateway.name);
  /** Null while COLLAB_ENABLED is off: nothing is constructed and nothing connects to Redis. */
  readonly hocuspocus: Hocuspocus<CollabContext> | null;
  private readonly sockets = new Map<WebSocket, { client: ClientConnection; alive: boolean }>();
  private heartbeat?: NodeJS.Timeout;

  constructor(
    config: ConfigService<Env, true>,
    private readonly tokenAuth: TokenAuthService,
    private readonly permissions: PermissionService,
    private readonly drafts: CollabDraftsService,
  ) {
    if (!config.get('COLLAB_ENABLED', { infer: true })) {
      this.hocuspocus = null;
      return;
    }
    const redis = new URL(config.get('REDIS_URL', { infer: true }));
    this.hocuspocus = new Hocuspocus<CollabContext>({
      quiet: true,
      debounce: config.get('COLLAB_STORE_DEBOUNCE_MS', { infer: true }),
      maxDebounce: config.get('COLLAB_STORE_MAX_DEBOUNCE_MS', { infer: true }),
      extensions: [
        new Redis({
          host: redis.hostname,
          port: Number(redis.port || 6379),
          options: {
            username: decodeURIComponent(redis.username) || undefined,
            password: decodeURIComponent(redis.password) || undefined,
            db: Number(redis.pathname.slice(1)) || 0,
          },
          prefix: 'kn:collab',
        }),
      ],
      onAuthenticate: (payload) => this.authenticate(payload),
      onLoadDocument: async ({ documentName, document }) => {
        // onAuthenticate has already proven the name parses and the pair exists.
        const { workspaceId, documentId, branchId } = parseCollabDocName(documentName)!;
        Y.applyUpdate(document, await this.drafts.load(workspaceId, documentId, branchId));
      },
      // Runs only on the instance an edit arrived at: updates relayed over
      // Redis skip the store hooks, so N instances do not write N times.
      onStoreDocument: async ({ documentName, document, lastContext }) => {
        const { documentId, branchId } = parseCollabDocName(documentName)!;
        try {
          await this.drafts.store(documentId, branchId, Y.encodeStateAsUpdate(document), lastContext?.userId);
        } catch (e) {
          if (!(e instanceof CollabDraftTooLargeError)) throw e;
          // The last stored state stays; the edits since are lost with the peers.
          this.logger.warn(`Draft ${documentName} is over COLLAB_MAX_DOC_BYTES; closing its peers`);
          for (const connection of document.getConnections()) {
            connection.close({ code: COLLAB_CLOSE_CODES.tooLarge, reason: 'too-large' } as CloseEvent);
          }
        }
      },
    });
  }

  afterInit(): void {
    if (!this.hocuspocus) return;
    // Hocuspocus drops a connection idle past its timeout but never pings, so
    // a quiet, healthy reader would be cut off. Same 30 s beat as LiveGateway.
    this.heartbeat = setInterval(() => {
      for (const [socket, st] of this.sockets) {
        if (!st.alive) {
          socket.terminate();
          continue;
        }
        st.alive = false;
        socket.ping();
      }
    }, 30_000);
    this.heartbeat.unref();
  }

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    if (!this.hocuspocus) {
      socket.close(COLLAB_CLOSE_CODES.disabled, 'collab disabled');
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(key, value);
    }
    const client = this.hocuspocus.handleConnection(socket, new Request(`http://localhost${request.url ?? '/'}`, { headers }));
    const st = { client, alive: true };
    this.sockets.set(socket, st);
    socket.on('message', (data: Buffer) => client.handleMessage(new Uint8Array(data)));
    socket.on('pong', () => {
      st.alive = true;
      client.touch();
    });
    socket.on('close', (code: number, reason: Buffer) =>
      client.handleClose({ code, reason: reason.toString() } as CloseEvent),
    );
  }

  handleDisconnect(socket: WebSocket): void {
    this.sockets.delete(socket);
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    // Starts every debounced store now rather than losing up to
    // COLLAB_STORE_MAX_DEBOUNCE_MS of edits to a restart.
    this.hocuspocus?.flushPendingStores();
  }

  /**
   * One document's admission. The workspace in the name is a hint and is
   * checked against PG; the branch must belong to the document. Edit access
   * decides `readOnly`, which Hocuspocus enforces server-side by dropping the
   * connection's updates — a read-only API key lands here too.
   */
  private async authenticate({ token, documentName, connectionConfig }: onAuthenticatePayload<CollabContext>): Promise<CollabContext> {
    const name = parseCollabDocName(documentName);
    if (!name) throw deny('forbidden');

    let principal: Principal;
    try {
      principal = await this.tokenAuth.resolve(token || undefined);
    } catch {
      throw deny('unauthorized');
    }
    if (this.tokenAuth.blocksUnverified(principal)) throw deny('unauthorized');

    const workspaceId = await this.drafts.workspaceOfBranch(name.documentId, name.branchId);
    if (!workspaceId || workspaceId !== name.workspaceId) throw deny('forbidden');
    const resource = { type: 'document' as const, id: name.documentId };
    const allows = (role: 'viewer' | 'editor') =>
      this.permissions.requireResource(principal, workspaceId, resource, role, false).then(
        () => true,
        () => false,
      );
    if (!(await allows('viewer'))) throw deny('forbidden');
    connectionConfig.readOnly = !(await allows('editor'));
    return { userId: principal.userId };
  }
}
