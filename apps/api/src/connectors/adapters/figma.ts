import { parseFigmaAllowlist, FIGMA_ALLOWLIST_CONFIG_KEY } from '@knowledge/contracts';
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

type FigmaContext = Pick<ConnectorContext, 'credential' | 'debug' | 'allowPrivate' | 'signal'>;

/**
 * GET a Figma endpoint as JSON. A 429 waits for `Retry-After` (capped) and
 * retries; after the last attempt it throws like any other refusal, so the
 * caller gives up for this tick and the next one tries again.
 */
export async function figmaGet<T>(ctx: FigmaContext, path: string, query: Record<string, string> = {}): Promise<T> {
  const url = `${FIGMA_API}${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await connectorFetch(
        url,
        { headers: { 'X-Figma-Token': ctx.credential ?? '', Accept: 'application/json' }, signal: ctx.signal },
        ctx,
      );
      return (await res.json()) as T;
    } catch (err) {
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
  projectId: string;
  teamId: string | null;
}

/**
 * Every file the connector's allowlist reaches: teams expand to their
 * projects, projects to their files. Figma's file metadata does not name a
 * file's project, so membership can only be answered by listing.
 */
export async function figmaAllowedFiles(ctx: FigmaContext & Pick<ConnectorContext, 'config'>): Promise<FigmaFileEntry[]> {
  const allowlist = parseFigmaAllowlist(String(ctx.config[FIGMA_ALLOWLIST_CONFIG_KEY] ?? ''));
  const projects = new Map<string, string | null>(allowlist.projects.map((id) => [id, null]));
  for (const teamId of allowlist.teams) {
    const { projects: listed } = await figmaGet<{ projects?: { id: string | number }[] }>(ctx, `/v1/teams/${teamId}/projects`);
    for (const p of listed ?? []) projects.set(String(p.id), teamId);
  }
  const files: FigmaFileEntry[] = [];
  for (const [projectId, teamId] of projects) {
    const { files: listed } = await figmaGet<{ files?: { key: string; name: string }[] }>(ctx, `/v1/projects/${projectId}/files`);
    for (const f of listed ?? []) files.push({ fileKey: f.key, name: f.name, projectId, teamId });
  }
  return files;
}
