import { parseFigmaAllowlist, FIGMA_ALLOWLIST_CONFIG_KEY } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import { ConnectorRequestError, connectorFetch, type ConnectorContext } from './connector.types.js';

/**
 * The Figma REST client (#470, docs/features/64). Plain `fetch` through
 * `connectorFetch`, like every adapter: the SSRF guard runs at the dial, and
 * the token never leaves the API — the picker's calls are proxied here too.
 */
export const FIGMA_API = 'https://api.figma.com';

/** Attempts per call when Figma answers 429, and the longest wait between them. */
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 30_000;

type FigmaContext = Pick<ConnectorContext, 'credential' | 'bearer' | 'renewCredential' | 'debug' | 'allowPrivate' | 'signal'>;

/**
 * GET a Figma endpoint as JSON. A 429 waits for `Retry-After` (capped) and
 * retries; after the last attempt it throws like any other refusal, so the
 * caller gives up for this tick and the next one tries again. An OAuth
 * connector sends a bearer token, and a 401 on one renews it once (#557).
 */
export async function figmaGet<T>(ctx: FigmaContext, path: string, query: Record<string, string> = {}): Promise<T> {
  const url = `${FIGMA_API}${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`;
  let renewed = false;
  for (let attempt = 1; ; attempt++) {
    const auth: Record<string, string> = ctx.bearer
      ? { Authorization: `Bearer ${ctx.credential ?? ''}` }
      : { 'X-Figma-Token': ctx.credential ?? '' };
    try {
      const res = await connectorFetch(url, { headers: { ...auth, Accept: 'application/json' }, signal: ctx.signal }, ctx);
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof ConnectorRequestError && err.status === 401 && ctx.renewCredential && !renewed) {
        renewed = true;
        const next = await ctx.renewCredential(ctx.credential ?? '');
        if (next) {
          // Kept on the context, so the rest of this sweep uses the new token.
          ctx.credential = next;
          continue;
        }
      }
      if (!(err instanceof ConnectorRequestError) || err.status !== 429 || attempt >= MAX_ATTEMPTS) throw err;
      const wait = Math.min(MAX_WAIT_MS, (Number(err.retryAfter) || 2 ** attempt) * 1000);
      ctx.debug('figma 429', { attempt, waitMs: wait });
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export interface FigmaFileEntry {
  fileKey: string;
  name: string;
  /**
   * The folder the allowlist reached this file through (the allowlisted one, or
   * the team's top-level one), not the subfolder it sits in, so
   * `embedFileAllowed` answers from the allowlist alone.
   */
  projectId: string;
  teamId: string | null;
}

/**
 * Every file the connector's allowlist reaches: teams expand to their
 * top-level folders, every folder to its subfolders (Figma nests them now, and
 * a team listing stops at the top level), and every folder to its files.
 * Figma's file metadata does not name a file's folder, so membership can only
 * be answered by listing. A folder is what Figma used to call a project, with
 * the same id, so the `project:` entries stand (#549).
 */
export async function figmaAllowedFiles(ctx: FigmaContext & Pick<ConnectorContext, 'config'>): Promise<FigmaFileEntry[]> {
  const allowlist = parseFigmaAllowlist(String(ctx.config[FIGMA_ALLOWLIST_CONFIG_KEY] ?? ''));
  type Reached = { folderId: string; projectId: string; teamId: string | null };
  const queue: Reached[] = [];
  for (const teamId of allowlist.teams) {
    const { folders } = await listing<FolderList>(ctx, `/v2/teams/${teamId}/folders`, `team:${teamId}`);
    for (const f of folders ?? []) queue.push({ folderId: String(f.id), projectId: String(f.id), teamId });
  }
  for (const id of allowlist.projects) queue.push({ folderId: id, projectId: id, teamId: null });
  // Also the visited set: a folder reached twice is walked once, the first way.
  const walked = new Map<string, Reached>();
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (walked.has(next.folderId)) continue;
    walked.set(next.folderId, next);
    const { folders } = await listing<FolderList>(ctx, `/v2/folders/${next.folderId}/folders`, `project:${next.folderId}`);
    for (const f of folders ?? []) queue.push({ ...next, folderId: String(f.id) });
  }
  const files: FigmaFileEntry[] = [];
  for (const { folderId, projectId, teamId } of walked.values()) {
    const { files: listed } = await listing<{ files?: { key: string; name: string }[] }>(ctx, `/v2/folders/${folderId}/files`, `project:${folderId}`);
    for (const f of listed ?? []) files.push({ fileKey: f.key, name: f.name, projectId, teamId });
  }
  return files;
}

type FolderList = { folders?: { id: string | number }[] };

/**
 * One allowlist listing. Figma answers a bad token with 401, so a 403 here is
 * a token without `folders:read` or an owner who cannot open the entry. The
 * message names the entry and carries Figma's own `err`, the one clue that
 * tells those two apart (#545, #549).
 */
async function listing<T>(ctx: FigmaContext, path: string, entry: string): Promise<T> {
  try {
    return await figmaGet<T>(ctx, path);
  } catch (err) {
    if (err instanceof ConnectorRequestError && err.status === 403) {
      throw new Error(t('error.connector.figmaListRefused', { entry, scope: 'folders:read', reason: figmaReason(err.body) }));
    }
    throw err;
  }
}

/** Figma's reason from an error body (`{ status, err }`, sometimes `message`), else the body itself. */
function figmaReason(body: string): string {
  let reason = body;
  try {
    const parsed = JSON.parse(body) as { err?: unknown; message?: unknown };
    reason = String(parsed.err ?? parsed.message ?? body);
  } catch {
    // not JSON: the body is the reason
  }
  return reason.trim().slice(0, 200) || 'Forbidden';
}
