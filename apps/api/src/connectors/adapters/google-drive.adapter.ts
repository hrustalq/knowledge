import { createHash, createSign } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { importFormatFor, type ConnectorCapabilities, type ConnectorKind } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import { ParserRegistry } from '../../import/parsers/parser.registry.js';
import { stripLeadingTitle } from '../../import/parsers/parser.types.js';
import {
  connectorFetch,
  optionalConfig,
  requireConfig,
  type ConnectorAdapter,
  type ConnectorContext,
  type ExternalAcl,
  type ExternalChanges,
  type ExternalDocument,
  type ExternalGroupMember,
  type ExternalPrincipal,
  type ExternalRef,
} from './connector.types.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1';
/**
 * Fixed rather than read from the key's `token_uri`: the key is pasted by an
 * admin, and a URL inside it is a URL this server would dial with a signed
 * assertion. Every Google service account key names this one.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const GROUPS_SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.member.readonly';

const FOLDER = 'application/vnd.google-apps.folder';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const PAGE_SIZE = 200;
/** Past this a file is skipped and reported rather than downloaded into the worker's memory. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** A feed this far behind is read in instalments: the cursor left at the cap resumes there. */
const MAX_CHANGE_PAGES = 20;
const CHANGE_PAGE_SIZE = 1000;
const GROUP_PAGE = 200;
/** Past this a group is cut short, which narrows a page rather than widening it. */
const MAX_GROUP_MEMBERS = 5_000;
/** Ancestry is walked to decide whether a changed file is in scope; deeper than this is outside. */
const MAX_DEPTH = 32;
/** How long a folder's identity (name, shared drive) is trusted within a run. */
const ROOT_TTL_MS = 5 * 60_000;

const FILE_FIELDS = 'id,name,mimeType,version,webViewLink,parents,size,trashed';
const EDIT_ROLES = new Set(['owner', 'organizer', 'fileOrganizer', 'writer']);

/**
 * Google-native files have no bytes of their own; each is exported to a format
 * a feature-16 parser already reads. Sheets go out as CSV, which Drive limits
 * to the first sheet — said on the page rather than discovered later.
 */
const EXPORTS: Record<string, { mimeType: string; ext: string; firstSheetOnly?: boolean }> = {
  'application/vnd.google-apps.document': { mimeType: DOCX, ext: '.docx' },
  'application/vnd.google-apps.presentation': { mimeType: PPTX, ext: '.pptx' },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'text/csv', ext: '.csv', firstSheetOnly: true },
};

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  version?: string;
  webViewLink?: string;
  parents?: string[];
  /** Absent on Google-native files. A string: the API sends int64 as text. */
  size?: string;
  trashed?: boolean;
  driveId?: string;
}

export interface DrivePermission {
  id?: string;
  type: 'user' | 'group' | 'domain' | 'anyone';
  role: string;
  emailAddress?: string;
  displayName?: string;
  deleted?: boolean;
}

interface DriveRoot {
  id: string;
  name: string;
  /** Set when the folder lives in a shared drive; listing and the change feed must name it. */
  driveId?: string;
}

export type FilePlan =
  | { kind: 'folder' }
  | { kind: 'export'; filename: string; contentType: string; exportType: string; firstSheetOnly: boolean }
  | { kind: 'download'; filename: string; contentType: string }
  | { kind: 'skip'; reason: 'unsupported' | 'oversize' };

/**
 * What becomes of one Drive file. The format routing is feature 16's
 * `importFormatFor`, so a file this connector imports is exactly a file the
 * upload wizard would accept — except images: their parser is OCR, which bills
 * a model per file, and an unattended sync must not run up a bill by finding
 * a folder of screenshots.
 */
export function planFile(file: Pick<DriveFile, 'name' | 'mimeType' | 'size'>): FilePlan {
  if (file.mimeType === FOLDER) return { kind: 'folder' };
  const exported = EXPORTS[file.mimeType];
  if (exported) {
    return {
      kind: 'export',
      filename: `${file.name}${exported.ext}`,
      contentType: exported.mimeType,
      exportType: exported.mimeType,
      firstSheetOnly: exported.firstSheetOnly === true,
    };
  }
  const format = importFormatFor(file.name, file.mimeType);
  if (!format || format.parser === 'ocr') return { kind: 'skip', reason: 'unsupported' };
  if (Number(file.size ?? 0) > MAX_FILE_BYTES) return { kind: 'skip', reason: 'oversize' };
  const hasExtension = format.extensions.some((ext) => file.name.toLowerCase().endsWith(ext));
  return {
    kind: 'download',
    // A parser that routes by extension needs one; Drive names need not have it.
    filename: hasExtension ? file.name : `${file.name}${format.extensions[0]}`,
    contentType: file.mimeType,
  };
}

/** The page title: the name people see in Drive, without the extension of an uploaded file. */
export function titleOf(file: Pick<DriveFile, 'name' | 'mimeType'>): string {
  if (file.mimeType === FOLDER || EXPORTS[file.mimeType]) return file.name;
  const format = importFormatFor(file.name, file.mimeType);
  const ext = format?.extensions.find((e) => file.name.toLowerCase().endsWith(e));
  return (ext ? file.name.slice(0, -ext.length) : file.name).trim() || file.name;
}

/**
 * A Drive ACL as one restriction (#76).
 *
 * Drive already folds inheritance into a file's own list — a folder's sharing
 * appears on every file inside it, a shared drive's members on every item — so
 * there is one layer and nothing to intersect. Anyone-with-the-link and
 * whole-domain sharing read as `source-wide`. People and groups are keyed by
 * lower-cased email: it is the one identifier the Drive and Directory APIs
 * agree on, and what identity mapping matches anyway. The service account
 * itself is left out — it is the reader, not an audience.
 */
export function drivePermissionsToAcl(permissions: DrivePermission[], serviceAccount: string): ExternalAcl {
  const self = serviceAccount.toLowerCase();
  const byKey = new Map<string, ExternalPrincipal>();
  for (const p of permissions) {
    if (p.deleted) continue;
    if (p.type === 'anyone' || p.type === 'domain') return { audience: 'source-wide', principals: [] };
    if (!p.emailAddress) continue;
    const email = p.emailAddress.toLowerCase();
    if (p.type === 'user' && email === self) continue;
    const level = EDIT_ROLES.has(p.role) ? 'edit' : 'view';
    const key = `${p.type}:${email}`;
    const prior = byKey.get(key);
    if (prior && prior.level === 'edit') continue;
    byKey.set(key, { type: p.type, externalId: email, email, level, ...(p.displayName ? { name: p.displayName } : {}) });
  }
  return { audience: 'restricted', principals: [...byKey.values()] };
}

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
}

/** The two fields of a service account JSON key that sign anything. */
export function parseServiceAccountKey(raw: string | null): ServiceAccountKey {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw ?? '') as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const email = parsed?.client_email;
  const key = parsed?.private_key;
  if (typeof email !== 'string' || typeof key !== 'string' || !key.includes('-----BEGIN')) {
    throw new Error(t('error.connector.googleDrive.badKey'));
  }
  return { clientEmail: email, privateKey: key.replace(/\\n/g, '\n') };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * The signed JWT a service account trades for an access token (RFC 7523).
 * `sub` is domain-wide delegation: the person whose Drive is read. RS256 over
 * two segments is three lines of `node:crypto`; no Google SDK, the house rule.
 */
export function serviceAccountAssertion(
  key: ServiceAccountKey,
  scope: string,
  subject: string | undefined,
  now = Date.now(),
): string {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: key.clientEmail, scope, aud: TOKEN_URL, iat, exp: iat + 3600, ...(subject ? { sub: subject } : {}) }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).end().sign(key.privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

/** Drive ids are URL-safe base64-ish; anything else is a typo, and must never reach a `q=` query. */
function driveId(raw: string): string {
  const id = raw.trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error(t('error.connector.googleDrive.badId', { id: id.slice(0, 80) }));
  return id;
}

/**
 * Google Drive (#338).
 *
 * A folder — or a whole shared drive — walked as a tree. Folders become pages
 * so the hierarchy survives the trip, files become pages through the same
 * parsers the upload wizard uses (Docs, Slides and Sheets exported to DOCX,
 * PPTX and CSV first), and whatever no parser reads is skipped and named on
 * the run, once per folder.
 *
 * Authentication is a service account: its JSON key is the credential, stored
 * through `secret-box.ts` like every other one, and traded for a one-hour
 * token per scope. No OAuth app to register. `subject` turns on domain-wide
 * delegation, which is also what reading Google Groups needs.
 *
 * Pull only, and no webhook: change detection is the Changes API, read from a
 * cursor at the start of every run (`changes()`).
 */
@Injectable()
export class GoogleDriveAdapter implements ConnectorAdapter {
  readonly kind: ConnectorKind = 'google-drive';
  readonly capabilities: ConnectorCapabilities = { pull: true, push: false, webhook: false, tree: true, acl: true };

  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly roots = new Map<string, { root: DriveRoot; at: number }>();

  constructor(private readonly parsers: ParserRegistry) {}

  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    const root = await this.root(ctx, true);
    const detail = root.driveId === root.id ? t('connector.googleDrive.sharedDrive', { name: root.name }) : root.name;
    return { ok: true, detail };
  }

  /** Every item in scope, breadth first. Only the orphan repair asks for it; the walk uses `children()`. */
  async *list(ctx: ConnectorContext): AsyncIterable<ExternalRef> {
    const root = await this.root(ctx);
    const queue = [root.id];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const folderId = queue.shift()!;
      for await (const ref of this.listFolder(ctx, root, folderId, null)) {
        yield ref;
        if (ref.hasChildren && !seen.has(ref.externalId)) {
          seen.add(ref.externalId);
          queue.push(ref.externalId);
        }
      }
    }
  }

  async *children(ctx: ConnectorContext, parent: ExternalRef | null): AsyncIterable<ExternalRef> {
    const root = await this.root(ctx);
    yield* this.listFolder(ctx, root, parent ? driveId(parent.externalId) : root.id, parent?.title ?? root.name);
  }

  /**
   * One folder's direct children. `report` names the folder for the skipped
   * warning, or is null to stay quiet — `list()` re-reads folders the walk
   * already reported on.
   */
  private async *listFolder(
    ctx: ConnectorContext,
    root: DriveRoot,
    folderId: string,
    report: string | null,
  ): AsyncIterable<ExternalRef> {
    const skipped: string[] = [];
    let pageToken: string | undefined;
    do {
      const params = this.scoped(root, {
        q: `'${folderId}' in parents and trashed = false`,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: String(PAGE_SIZE),
        orderBy: 'folder,name',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const body = (await this.get(ctx, `${DRIVE}/files?${params}`)) as { files?: DriveFile[]; nextPageToken?: string };
      const files = body.files ?? [];
      ctx.debug('drive: folder', { folder: folderId, count: files.length });
      for (const file of files) {
        const plan = planFile(file);
        if (plan.kind === 'skip') {
          skipped.push(plan.reason === 'oversize' ? t('connector.warning.googleDrive.oversizeName', { name: file.name }) : file.name);
          continue;
        }
        yield this.toRef(file, folderId === root.id ? undefined : folderId);
      }
      pageToken = body.nextPageToken;
    } while (pageToken);

    if (report !== null && skipped.length > 0) {
      ctx.warn?.(
        t('connector.warning.googleDrive.skipped', {
          count: skipped.length,
          folder: report,
          names: skipped.slice(0, 5).join(', ') + (skipped.length > 5 ? ', …' : ''),
        }),
      );
    }
  }

  async fetch(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    const id = driveId(ref.externalId);
    const file = (await this.get(ctx, `${DRIVE}/files/${id}?${this.flags({ fields: FILE_FIELDS })}`)) as DriveFile;
    const title = titleOf(file);
    const out: ExternalRef = { ...ref, title, url: file.webViewLink ?? ref.url, version: file.version ?? ref.version };
    const frontmatter = file.webViewLink ? { source: file.webViewLink } : undefined;

    const plan = planFile(file);
    // A folder is a page so its files have somewhere to hang; it has no body.
    if (plan.kind === 'folder') return { ref: out, title, markdown: '', frontmatter, warnings: [] };
    if (plan.kind === 'skip') {
      throw new Error(t('error.connector.googleDrive.unsupported', { name: file.name, type: file.mimeType }));
    }

    const url =
      plan.kind === 'export'
        ? `${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(plan.exportType)}`
        : `${DRIVE}/files/${id}?${this.flags({ alt: 'media' })}`;
    const res = await connectorFetch(url, { headers: await this.headers(ctx, DRIVE_SCOPE), signal: ctx.signal }, ctx);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error(t('error.connector.googleDrive.tooLarge', { name: file.name }));
    }

    const parser = this.parsers.resolve(plan.filename, plan.contentType);
    if (!parser) throw new Error(t('error.connector.googleDrive.unsupported', { name: file.name, type: file.mimeType }));
    const parsed = await parser.parse(bytes, {
      workspaceId: ctx.workspaceId,
      importId: `connector-${ctx.connectorId}`,
      userId: ctx.userId ?? '',
      filename: plan.filename,
      contentType: plan.contentType,
      // The run's own stage line ("Fetching …") is the one worth reading.
      onStage: async () => undefined,
    });

    // Images are not pulled yet (docs/features/19, deferrals). The parser has
    // pointed them at an import's staging area, which a connector page has
    // not got, so they are taken out and counted rather than left broken.
    const images = parsed.images?.length ?? 0;
    const imagesAttached = images > 0 ? t('import.warning.imagesAttached', { count: images }) : null;
    const markdown = (
      images > 0 ? parsed.markdown.replace(/!\[[^\]]*\]\(\/v1\/imports\/[^)\s]+\)\n?/g, '') : parsed.markdown
    ).trim();
    const warnings = parsed.warnings.filter((w) => w !== imagesAttached);
    if (images > 0) warnings.push(t('connector.warning.googleDrive.imagesDropped', { count: images }));
    if (plan.kind === 'export' && plan.firstSheetOnly) warnings.push(t('connector.warning.googleDrive.firstSheetOnly'));

    return { ref: out, title, markdown: stripLeadingTitle(markdown, title), frontmatter, warnings };
  }

  /**
   * Who may open a file (#76): its own permission list, which already carries
   * everything inherited from its folders and its shared drive.
   */
  async permissions(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalAcl> {
    const id = driveId(ref.externalId);
    const all: DrivePermission[] = [];
    let pageToken: string | undefined;
    do {
      const params = this.flags({
        pageSize: '100',
        fields: 'nextPageToken,permissions(id,type,role,emailAddress,displayName,deleted)',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const body = (await this.get(ctx, `${DRIVE}/files/${id}/permissions?${params}`)) as {
        permissions?: DrivePermission[];
        nextPageToken?: string;
      };
      all.push(...(body.permissions ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return drivePermissionsToAcl(all, parseServiceAccountKey(ctx.credential).clientEmail);
  }

  /**
   * A Google Group's people, from the Admin SDK Directory API. Drive cannot
   * say; the Directory API can only be read as an admin, which is what
   * `subject` is. Nested groups are not expanded: a group cut short narrows a
   * page, it never widens one.
   */
  async groupMembers(ctx: ConnectorContext, group: ExternalPrincipal): Promise<ExternalGroupMember[]> {
    if (!optionalConfig(ctx.config, 'subject')) throw new Error(t('error.connector.googleDrive.groupsNeedSubject'));
    const key = encodeURIComponent(group.email ?? group.externalId);
    const out: ExternalGroupMember[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ maxResults: String(GROUP_PAGE) });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await connectorFetch(
        `${DIRECTORY}/groups/${key}/members?${params}`,
        { headers: await this.headers(ctx, GROUPS_SCOPE), signal: ctx.signal },
        ctx,
      );
      const body = (await res.json()) as {
        members?: Array<{ email?: string; type?: string; status?: string }>;
        nextPageToken?: string;
      };
      for (const m of body.members ?? []) {
        if (m.type && m.type !== 'USER') continue;
        if (!m.email) continue;
        const email = m.email.toLowerCase();
        out.push({ externalId: email, email });
      }
      pageToken = body.nextPageToken;
    } while (pageToken && out.length < MAX_GROUP_MEMBERS);
    return out.slice(0, MAX_GROUP_MEMBERS);
  }

  /**
   * The Changes API from `cursor` (#338), or a fresh bookmark when it is null.
   *
   * The feed covers everything the account can see, so each changed file is
   * kept only if its ancestry reaches the connector's folder (memoised per
   * call: a burst of edits in one folder costs one walk up). A file trashed,
   * deleted, unshared or moved out of the folder is `removed` — the feed cannot
   * always tell those apart, and the caller only cares about the ones linked.
   */
  async changes(ctx: ConnectorContext, cursor: string | null): Promise<ExternalChanges> {
    const root = await this.root(ctx);
    if (!cursor) {
      const body = (await this.get(
        ctx,
        `${DRIVE}/changes/startPageToken?${this.flags(root.driveId ? { driveId: root.driveId } : {})}`,
      )) as { startPageToken?: string };
      if (!body.startPageToken) throw new Error(t('error.connector.googleDrive.noStartToken'));
      return { cursor: body.startPageToken, changed: [], removed: [] };
    }

    const scope = new Map<string, boolean>([[root.id, true]]);
    const latest = new Map<string, { ref: ExternalRef } | { removed: 'trashed' | 'removed' }>();
    let pageToken = cursor;
    for (let page = 0; page < MAX_CHANGE_PAGES; page += 1) {
      // `changes.list` names a shared drive by `driveId` alone; it has no `corpora`.
      const params = this.flags({
        pageToken,
        pageSize: String(CHANGE_PAGE_SIZE),
        includeRemoved: 'true',
        includeItemsFromAllDrives: 'true',
        fields: `nextPageToken,newStartPageToken,changes(changeType,removed,fileId,file(${FILE_FIELDS}))`,
        ...(root.driveId ? { driveId: root.driveId } : {}),
      });
      const body = (await this.get(ctx, `${DRIVE}/changes?${params}`)) as {
        changes?: Array<{ changeType?: string; removed?: boolean; fileId?: string; file?: DriveFile }>;
        nextPageToken?: string;
        newStartPageToken?: string;
      };

      for (const change of body.changes ?? []) {
        if (change.changeType && change.changeType !== 'file') continue;
        const id = change.fileId ?? change.file?.id;
        if (!id || id === root.id) continue;
        // Later entries win: the feed may name one file more than once.
        latest.delete(id);
        if (change.removed || !change.file) {
          latest.set(id, { removed: 'removed' });
        } else if (change.file.trashed) {
          latest.set(id, { removed: 'trashed' });
        } else {
          const parent = change.file.parents?.[0];
          if (!parent || !(await this.inScope(ctx, parent, scope))) {
            latest.set(id, { removed: 'removed' });
          } else if (planFile(change.file).kind !== 'skip') {
            latest.set(id, { ref: this.toRef(change.file, parent === root.id ? undefined : parent) });
          }
        }
      }

      ctx.debug('drive: changes page', { page, count: body.changes?.length ?? 0 });
      if (body.newStartPageToken) return collect(body.newStartPageToken, latest);
      if (!body.nextPageToken) return collect(pageToken, latest);
      pageToken = body.nextPageToken;
    }
    // Far behind: stop here and let the next run carry on from this page.
    return collect(pageToken, latest);
  }

  // --- helpers ---

  /** Whether a folder sits under the connector's root. Unreadable means outside. */
  private async inScope(ctx: ConnectorContext, folderId: string, memo: Map<string, boolean>): Promise<boolean> {
    const chain: string[] = [];
    let current: string | undefined = folderId;
    let answer = false;
    for (let hops = 0; current && hops < MAX_DEPTH; hops += 1) {
      const known = memo.get(current);
      if (known !== undefined) {
        answer = known;
        break;
      }
      chain.push(current);
      let parents: string[] | undefined;
      try {
        const meta = (await this.get(ctx, `${DRIVE}/files/${driveId(current)}?${this.flags({ fields: 'id,parents,trashed' })}`)) as DriveFile;
        parents = meta.trashed ? undefined : meta.parents;
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        parents = undefined;
      }
      current = parents?.[0];
    }
    for (const id of chain) memo.set(id, answer);
    return answer;
  }

  private toRef(file: DriveFile, parentExternalId: string | undefined): ExternalRef {
    return {
      externalId: file.id,
      title: titleOf(file),
      ...(file.webViewLink ? { url: file.webViewLink } : {}),
      ...(file.version ? { version: file.version } : {}),
      ...(parentExternalId ? { parentExternalId } : {}),
      hasChildren: file.mimeType === FOLDER,
    };
  }

  /**
   * The connector's folder: proves the token reads it, says whether it is a
   * shared drive, and is remembered briefly so a walk does not ask per folder.
   */
  private async root(ctx: ConnectorContext, fresh = false): Promise<DriveRoot> {
    const id = driveId(requireConfig(ctx.config, 'folderId'));
    const cacheKey = `${ctx.connectorId}:${id}`;
    const cached = this.roots.get(cacheKey);
    if (!fresh && cached && Date.now() - cached.at < ROOT_TTL_MS) return cached.root;

    const file = (await this.get(ctx, `${DRIVE}/files/${id}?${this.flags({ fields: 'id,name,mimeType,driveId' })}`)) as DriveFile;
    if (file.mimeType !== FOLDER) throw new Error(t('error.connector.googleDrive.notAFolder', { name: file.name }));
    let name = file.name;
    // A shared drive's root folder is the drive, and its own name is the drive's.
    if (file.driveId && file.driveId === file.id) {
      const drive = (await this.get(ctx, `${DRIVE}/drives/${id}?fields=name`)) as { name?: string };
      name = drive.name ?? name;
    }
    const root: DriveRoot = { id: file.id, name, ...(file.driveId ? { driveId: file.driveId } : {}) };
    this.roots.set(cacheKey, { root, at: Date.now() });
    if (this.roots.size > 1_000) this.roots.clear();
    return root;
  }

  /** Query flags every call needs to see shared drives at all. */
  private flags(extra: Record<string, string>): URLSearchParams {
    return new URLSearchParams({ supportsAllDrives: 'true', ...extra });
  }

  /** `flags`, plus the corpus: a shared drive's items are listed only when the drive is named. */
  private scoped(root: DriveRoot, extra: Record<string, string>): URLSearchParams {
    const params = this.flags({ includeItemsFromAllDrives: 'true', ...extra });
    if (root.driveId) {
      params.set('corpora', 'drive');
      params.set('driveId', root.driveId);
    }
    return params;
  }

  private async get(ctx: ConnectorContext, url: string): Promise<unknown> {
    const res = await connectorFetch(url, { headers: await this.headers(ctx, DRIVE_SCOPE), signal: ctx.signal }, ctx);
    return res.json();
  }

  private async headers(ctx: ConnectorContext, scope: string): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.token(ctx, scope)}`, accept: 'application/json' };
  }

  /**
   * An access token for `scope`, minted from the key and kept until shortly
   * before it expires. Keyed by connector *and* key: two connectors naming
   * the same service account must not share a token unless they hold the
   * same private key — the email alone is not a secret.
   */
  private async token(ctx: ConnectorContext, scope: string): Promise<string> {
    const key = parseServiceAccountKey(ctx.credential);
    const subject = optionalConfig(ctx.config, 'subject');
    const cacheKey = createHash('sha256')
      .update([ctx.connectorId, key.clientEmail, key.privateKey, subject ?? '', scope].join('\n'))
      .digest('hex');
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    let assertion: string;
    try {
      assertion = serviceAccountAssertion(key, scope, subject);
    } catch {
      throw new Error(t('error.connector.googleDrive.badKey'));
    }
    const res = await connectorFetch(
      TOKEN_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        signal: ctx.signal,
      },
      ctx,
    );
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error(t('error.connector.googleDrive.noToken'));
    // A minute early, so a token never expires between the check and the call.
    this.tokens.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 });
    if (this.tokens.size > 1_000) this.tokens.clear();
    return body.access_token;
  }
}

function collect(
  cursor: string,
  latest: Map<string, { ref: ExternalRef } | { removed: 'trashed' | 'removed' }>,
): ExternalChanges {
  const changed: ExternalRef[] = [];
  const removed: ExternalChanges['removed'] = [];
  for (const [externalId, entry] of latest) {
    if ('ref' in entry) changed.push(entry.ref);
    else removed.push({ externalId, reason: entry.removed });
  }
  return { cursor, changed, removed };
}
