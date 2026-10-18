import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { Subscription } from 'rxjs';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import { Hocuspocus, type Document as DraftDocument, type beforeHandleAwarenessPayload, type onAuthenticatePayload } from '@hocuspocus/server';
import { Redis } from '@hocuspocus/extension-redis';
import {
  COLLAB_DISABLED_CLOSE_CODE,
  collabDocName,
  parseCollabDocName,
  type CollabDenyReason,
  type CollabUser,
} from '@knowledge/contracts';
import { TokenAuthService } from '../auth/token-auth.service.js';
import type { Principal } from '../auth/principal.js';
import type { Env } from '../config/env.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { EventsSubscriber } from '../events/events.subscriber.js';
import { PermissionService } from '../permissions/permission.service.js';
import { CollabDraftTooLargeError, CollabDraftsService, snapshotOf, type LoadedDraft } from './collab-drafts.service.js';

/** What a document connection carries once `onAuthenticate` accepted it. */
interface CollabContext {
  /** As the ticket was minted; `isCurrent` re-asks whether it still stands. */
  principal: Principal;
  /** Resolved from the document in PG, never taken from the doc name. */
  workspaceId: string;
  documentId: string;
}

type ClientConnection = ReturnType<Hocuspocus['handleConnection']>;
type Access = 'none' | 'read' | 'write';

/** Hocuspocus answers a thrown `{ reason }` with a per-document `permission-denied`. */
const deny = (reason: CollabDenyReason) => ({ reason });
/** A per-document close. The provider sees `{ code: 1000, reason }`: only the reason arrives. */
const closing = (reason: CollabDenyReason) => ({ reason }) as CloseEvent;

/**
 * Shared drafts over Yjs (#80, docs/features/56): Hocuspocus embedded as a
 * library behind a second gateway on the same `WsAdapter` and port as
 * `/v1/events/ws`. Hocuspocus multiplexes documents over one socket, so
 * access is decided per document in `onAuthenticate`, from the page
 * permissions every REST route asks (feature 48): view to join, edit to
 * write. A refused document gets a reason, never its title.
 *
 * Admission takes a single-use `kt_` ticket (`POST /v1/auth/url-ticket`)
 * and nothing longer-lived. A connection outlives its ticket, so it is
 * re-judged on `acl.changed` for its workspace and on every
 * COLLAB_REAUTH_INTERVAL_SECONDS (the only path that sees a plain role
 * change). A peer's awareness `user` is overwritten from its principal, so
 * a caret's name is the server's word, not the client's.
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
  private readonly reauthMs: number;
  private readonly sockets = new Map<WebSocket, { client: ClientConnection; alive: boolean }>();
  private heartbeat?: NodeJS.Timeout;
  private reauth?: NodeJS.Timeout;
  private eventsSub?: Subscription;
  /** Workspaces waiting for a re-check, or every one. Coalesced: one sweep runs at a time. */
  private pending: Set<string> | 'all' | null = null;
  private sweeping = false;
  /** Which row (and which reset of it) each loaded doc came from: a store is refused against any other. */
  private readonly loaded = new WeakMap<Y.Doc, Omit<LoadedDraft, 'state'>>();
  /** Docs closed out by a reset or a refused store, until they unload: never served to a rejoining peer. */
  private readonly stale = new WeakSet<Y.Doc>();

  constructor(
    config: ConfigService<Env, true>,
    private readonly tokenAuth: TokenAuthService,
    private readonly permissions: PermissionService,
    private readonly drafts: CollabDraftsService,
    private readonly events: EventsSubscriber,
    private readonly publisher: EventsPublisher,
  ) {
    this.reauthMs = config.get('COLLAB_REAUTH_INTERVAL_SECONDS', { infer: true }) * 1000;
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
      beforeHandleAwareness: async (payload) => this.attest(payload),
      onLoadDocument: async ({ documentName, document }) => {
        // onAuthenticate has already proven the name parses and the pair exists.
        const { workspaceId, documentId, branchId } = parseCollabDocName(documentName)!;
        const { state, ...row } = await this.drafts.load(workspaceId, documentId, branchId);
        Y.applyUpdate(document, state);
        this.loaded.set(document, row);
      },
      // Runs only on the instance an edit arrived at: updates relayed over
      // Redis skip the store hooks, so N instances do not write N times.
      onStoreDocument: async ({ documentName, document, lastContext }) => {
        const row = this.loaded.get(document);
        if (!row) return;
        try {
          const stored = await this.drafts.store(row, {
            state: Y.encodeStateAsUpdate(document),
            snapshot: snapshotOf(document),
            userId: lastContext?.principal.userId,
          });
          // Reset or dropped since this doc loaded: whatever it holds is not the draft any more.
          if (!stored) this.closeDraft(document, 'reset');
        } catch (e) {
          if (!(e instanceof CollabDraftTooLargeError)) throw e;
          // The last stored state stays; the edits since are lost with the peers.
          this.logger.warn(`Draft ${documentName} is over COLLAB_MAX_DOC_BYTES; closing its peers`);
          this.closeDraft(document, 'too-large');
        }
      },
      // Who has a draft open changed: the "N editing" badges re-ask.
      connected: async ({ documentName }) => this.announce(documentName),
      onDisconnect: async ({ documentName }) => this.announce(documentName),
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
    this.reauth = setInterval(() => this.recheck(), this.reauthMs);
    this.reauth.unref();
    // acl.changed names only its workspace (it leaks nothing), which is all a re-check needs.
    this.eventsSub = this.events.all().subscribe((event) => {
      if (event.type === 'acl.changed' && event.workspaceId) this.recheck(event.workspaceId);
      // A discard on any instance reaches every instance's peers this way:
      // Hocuspocus's Redis relay carries updates, not closes.
      if (event.type === 'draft.reset' && event.documentId && event.subjectId) {
        const document = this.hocuspocus?.documents.get(collabDocName(event.workspaceId, event.documentId, event.subjectId));
        if (document) this.closeDraft(document, 'reset');
      }
    });
  }

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    if (!this.hocuspocus) {
      socket.close(COLLAB_DISABLED_CLOSE_CODE, 'collab disabled');
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

  /**
   * Distinct people with a branch's draft open, as this instance sees them:
   * its own peers plus the awareness relayed from other instances that have
   * the doc loaded too.
   */
  peersOf(workspaceId: string, documentId: string, branchId: string): number {
    const document = this.hocuspocus?.documents.get(collabDocName(workspaceId, documentId, branchId));
    if (!document) return 0;
    const people = new Set<string>();
    for (const state of document.awareness.getStates().values()) {
      const userId = (state as { user?: { userId?: unknown } }).user?.userId;
      if (typeof userId === 'string') people.add(userId);
    }
    return people.size;
  }

  handleDisconnect(socket: WebSocket): void {
    this.sockets.delete(socket);
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reauth) clearInterval(this.reauth);
    this.eventsSub?.unsubscribe();
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
      principal = await this.tokenAuth.resolveTicket(token || undefined);
    } catch {
      throw deny('unauthorized');
    }
    if (this.tokenAuth.blocksUnverified(principal)) throw deny('unauthorized');

    const workspaceId = await this.drafts.workspaceOfBranch(name.documentId, name.branchId);
    if (!workspaceId || workspaceId !== name.workspaceId) throw deny('forbidden');
    const access = await this.accessTo(principal, workspaceId, name.documentId);
    if (access === 'none') throw deny('forbidden');
    connectionConfig.readOnly = access === 'read';
    await this.settled(documentName);
    return { principal, workspaceId, documentId: name.documentId };
  }

  /**
   * A peer closed by a reset rejoins at once, and the doc it was closed out
   * of may still be storing (refused) on its way out. Admission waits for it
   * to unload, so the rejoin loads the reseeded row instead of the old doc.
   */
  private async settled(documentName: string): Promise<void> {
    // ponytail: polls for up to 2 s; a hook on Hocuspocus's own unload would replace it.
    for (let i = 0; i < 100; i++) {
      const document = this.hocuspocus!.documents.get(documentName);
      if (!document || !this.stale.has(document)) return;
      await this.hocuspocus!.unloadDocument(document);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** What the page's permissions let the principal do with it now (feature 48). */
  private async accessTo(principal: Principal, workspaceId: string, documentId: string): Promise<Access> {
    const resource = { type: 'document' as const, id: documentId };
    const allows = (role: 'viewer' | 'editor') =>
      this.permissions.requireResource(principal, workspaceId, resource, role, false).then(
        () => true,
        () => false,
      );
    if (!(await allows('viewer'))) return 'none';
    return (await allows('editor')) ? 'write' : 'read';
  }

  /**
   * The server roster: every awareness state a connection sends gets its
   * `user` identity fields from that connection's principal. Updates relayed
   * from another instance carry no connection here; that instance attested
   * them already.
   */
  private attest({ context, states }: beforeHandleAwarenessPayload<CollabContext>): void {
    if (!context) return;
    const { principal } = context;
    const user: CollabUser = { userId: principal.userId, name: principal.displayName, avatarUrl: principal.avatarUrl };
    for (const state of states.values()) {
      state.user = { ...(typeof state.user === 'object' && state.user !== null ? state.user : {}), ...user };
    }
  }

  /**
   * Close every peer of one draft with `reason`, then drop this instance's
   * copy, so a peer that rejoins at once loads the row rather than the doc
   * it was just closed out of.
   */
  private closeDraft(document: DraftDocument, reason: CollabDenyReason): void {
    if (reason === 'reset') this.stale.add(document);
    for (const connection of document.getConnections()) connection.close(closing(reason));
    void this.hocuspocus?.unloadDocument(document);
  }

  private announce(documentName: string): void {
    const name = parseCollabDocName(documentName);
    if (!name) return;
    void this.publisher.publish({ type: 'draft.changed', workspaceId: name.workspaceId, documentId: name.documentId, subjectId: name.branchId });
  }

  /** Queue a re-check of one workspace's connections, or of all of them. */
  private recheck(workspaceId?: string): void {
    this.pending = !workspaceId || this.pending === 'all' ? 'all' : (this.pending ?? new Set()).add(workspaceId);
    if (this.sweeping) return;
    this.sweeping = true;
    void (async () => {
      try {
        while (this.pending) {
          const scope = this.pending;
          this.pending = null;
          await this.sweep(scope);
        }
      } finally {
        this.sweeping = false;
      }
    })();
  }

  /**
   * Re-judge open connections the way `authenticate` judged them. A
   * credential that no longer stands, or a page that can no longer be
   * opened, closes that document. Gaining or losing edit closes it with
   * `access-changed`: the client rejoins with a fresh ticket and learns its
   * new scope from the handshake, rather than typing into a connection whose
   * writes are silently dropped.
   */
  private async sweep(scope: Set<string> | 'all'): Promise<void> {
    for (const document of this.hocuspocus!.documents.values()) {
      for (const connection of document.getConnections()) {
        const { principal, workspaceId, documentId } = connection.context;
        if (scope !== 'all' && !scope.has(workspaceId)) continue;
        try {
          let reason: CollabDenyReason | null = null;
          if (!(await this.tokenAuth.isCurrent(principal))) reason = 'unauthorized';
          else {
            const access = await this.accessTo(principal, workspaceId, documentId);
            if (access === 'none') reason = 'forbidden';
            else if ((access === 'read') !== connection.readOnly) reason = 'access-changed';
          }
          if (reason) connection.close(closing(reason));
        } catch (e) {
          // ponytail: a failed read keeps the connection until the next tick; fail closed if PG blips prove to matter.
          this.logger.warn(`Collab re-check failed: ${(e as Error)?.message ?? String(e)}`);
        }
      }
    }
  }
}
