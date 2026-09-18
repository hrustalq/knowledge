import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConnectorCapabilities, ConnectorKind } from '@knowledge/contracts';
import { safeJson } from '../webhook-payload.js';
import {
  connectorFetch,
  optionalConfig,
  type ConnectorAdapter,
  type ConnectorContext,
  type ExternalDocument,
  type ExternalRef,
  type OutboundDocument,
} from './connector.types.js';

const API = 'https://api.notion.com/v1';
/** Pinned: Notion's API is versioned by date and unversioned requests are refused. */
const NOTION_VERSION = '2022-06-28';
const PAGE_SIZE = 100;
/** Blocks nest arbitrarily; markdown does not. Deep trees flatten past this. */
const MAX_DEPTH = 3;

/**
 * Notion (docs/features/19).
 *
 * Notion has no markdown on the wire in either direction: a page is a tree of
 * typed blocks. So this adapter owns a converter both ways, and — the important
 * part — it reports every construct it could not carry rather than dropping it
 * silently. A synced database or a linked view arriving as a blank page with no
 * explanation is exactly the failure this feature exists to prevent.
 */
@Injectable()
export class NotionAdapter implements ConnectorAdapter {
  readonly kind: ConnectorKind = 'notion';
  readonly capabilities: ConnectorCapabilities = { pull: true, push: true, webhook: true, tree: false };

  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    const me = (await (
      await connectorFetch(`${API}/users/me`, { headers: this.headers(ctx), signal: ctx.signal }, ctx)
    ).json()) as { name?: string; bot?: { workspace_name?: string } };
    return { ok: true, detail: me.bot?.workspace_name ?? me.name ?? 'connected' };
  }

  async *list(ctx: ConnectorContext): AsyncIterable<ExternalRef> {
    const databaseId = optionalConfig(ctx.config, 'databaseId');
    let cursor: string | undefined;

    do {
      const url = databaseId ? `${API}/databases/${databaseId}/query` : `${API}/search`;
      const body: Record<string, unknown> = { page_size: PAGE_SIZE };
      if (cursor) body.start_cursor = cursor;
      if (!databaseId) body.filter = { property: 'object', value: 'page' };

      const res = (await (
        await connectorFetch(url, {
          method: 'POST',
          headers: { ...this.headers(ctx), 'content-type': 'application/json' },
          signal: ctx.signal,
          body: JSON.stringify(body),
        }, ctx)
      ).json()) as NotionList;

      for (const page of res.results ?? []) {
        if (page.object !== 'page' || page.archived) continue;
        yield {
          externalId: page.id,
          title: pageTitle(page) ?? 'Untitled',
          url: page.url,
          // last_edited_time is Notion's only version handle.
          version: page.last_edited_time,
        };
      }
      cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
  }

  async fetch(ctx: ConnectorContext, ref: ExternalRef): Promise<ExternalDocument> {
    const page = (await (
      await connectorFetch(`${API}/pages/${ref.externalId}`, {
        headers: this.headers(ctx),
        signal: ctx.signal,
      }, ctx)
    ).json()) as NotionPage;

    const warnings: string[] = [];
    const unsupported = new Set<string>();
    const lines = await this.blocksToMarkdown(ctx, ref.externalId, 0, unsupported);

    if (unsupported.size > 0) {
      warnings.push(
        `These Notion blocks have no markdown equivalent and were left out: ${[...unsupported].sort().join(', ')}.`,
      );
    }

    return {
      ref: { ...ref, version: page.last_edited_time ?? ref.version },
      title: pageTitle(page) ?? ref.title,
      markdown: lines.join('\n\n').trim(),
      frontmatter: page.url ? { source: page.url } : undefined,
      warnings,
    };
  }

  async push(ctx: ConnectorContext, doc: OutboundDocument): Promise<ExternalRef> {
    const blocks = markdownToBlocks(doc.markdown);

    if (!doc.ref) {
      const parentId = optionalConfig(ctx.config, 'databaseId');
      if (!parentId) throw new Error('a database id is required to create Notion pages');
      const created = (await (
        await connectorFetch(`${API}/pages`, {
          method: 'POST',
          headers: { ...this.headers(ctx), 'content-type': 'application/json' },
          signal: ctx.signal,
          body: JSON.stringify({
            parent: { database_id: parentId },
            properties: { title: { title: [{ text: { content: doc.title.slice(0, 2000) } }] } },
            children: blocks.slice(0, 100),
          }),
        }, ctx)
      ).json()) as NotionPage;
      return {
        externalId: created.id,
        title: doc.title,
        url: created.url,
        version: created.last_edited_time,
      };
    }

    // Notion has no "replace body" call: children are deleted one by one and
    // appended fresh. Archiving rather than hard-deleting is Notion's own
    // delete, and it is what keeps the operation undoable on their side.
    const existing = (await (
      await connectorFetch(`${API}/blocks/${doc.ref.externalId}/children?page_size=${PAGE_SIZE}`, {
        headers: this.headers(ctx),
        signal: ctx.signal,
      }, ctx)
    ).json()) as NotionList;
    for (const block of existing.results ?? []) {
      await connectorFetch(
        `${API}/blocks/${block.id}`,
        { method: 'DELETE', headers: this.headers(ctx), signal: ctx.signal },
        ctx,
      ).catch(() => undefined);
    }

    await connectorFetch(
      `${API}/blocks/${doc.ref.externalId}/children`,
      {
        method: 'PATCH',
        headers: { ...this.headers(ctx), 'content-type': 'application/json' },
        signal: ctx.signal,
        body: JSON.stringify({ children: blocks.slice(0, 100) }),
      },
      ctx,
    );

    const updated = (await (
      await connectorFetch(`${API}/pages/${doc.ref.externalId}`, {
        method: 'PATCH',
        headers: { ...this.headers(ctx), 'content-type': 'application/json' },
        signal: ctx.signal,
        body: JSON.stringify({
          properties: { title: { title: [{ text: { content: doc.title.slice(0, 2000) } }] } },
        }),
      }, ctx)
    ).json()) as NotionPage;

    return {
      externalId: doc.ref.externalId,
      title: doc.title,
      url: updated.url ?? doc.ref.url,
      version: updated.last_edited_time,
    };
  }

  /**
   * Notion signs webhooks with HMAC-SHA256 over the raw body in
   * `x-notion-signature: v0=<hex>`. The verification-token handshake arrives as
   * an unsigned body carrying `verification_token`, which is answered with an
   * empty ref list (verified, nothing to sync) so the run is never created.
   */
  verifyWebhook(ctx: ConnectorContext, headers: Record<string, string>, rawBody: string): ExternalRef[] | null {
    const payload = safeJson(rawBody);
    if (payload?.verification_token) return [];

    const secret = ctx.webhookSecret;
    if (!secret) return null;
    const sent = (headers['x-notion-signature'] ?? '').replace(/^v0=/, '');
    if (!sent) return null;
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const a = Buffer.from(sent, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const id = payload?.entity?.id ?? payload?.page?.id;
    return id ? [{ externalId: String(id), title: '' }] : [];
  }

  private headers(ctx: ConnectorContext): Record<string, string> {
    return {
      authorization: `Bearer ${ctx.credential ?? ''}`,
      'Notion-Version': NOTION_VERSION,
      accept: 'application/json',
    };
  }

  private async blocksToMarkdown(
    ctx: ConnectorContext,
    blockId: string,
    depth: number,
    unsupported: Set<string>,
  ): Promise<string[]> {
    if (depth > MAX_DEPTH) return [];
    const out: string[] = [];
    let cursor: string | undefined;

    do {
      const url = new URL(`${API}/blocks/${blockId}/children`);
      url.searchParams.set('page_size', String(PAGE_SIZE));
      if (cursor) url.searchParams.set('start_cursor', cursor);
      const res = (await (
        await connectorFetch(url.toString(), { headers: this.headers(ctx), signal: ctx.signal }, ctx)
      ).json()) as NotionList;

      for (const block of res.results ?? []) {
        const rendered = renderBlock(block, unsupported);
        if (rendered !== null) out.push(rendered);
        if (block.has_children && rendered !== null) {
          const nested = await this.blocksToMarkdown(ctx, block.id, depth + 1, unsupported);
          // Nested content is indented under its parent when the parent is a
          // list item, and promoted to its own paragraph otherwise.
          const indent = isListBlock(block) ? '  ' : '';
          out.push(...nested.map((line) => (indent ? indent + line.replace(/\n/g, `\n${indent}`) : line)));
        }
      }
      cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);

    return out;
  }
}

// --- block conversion ---

function richText(rt: NotionRichText[] | undefined): string {
  if (!rt?.length) return '';
  return rt
    .map((r) => {
      let text = r.plain_text ?? r.text?.content ?? '';
      const a = r.annotations;
      if (a?.code) text = `\`${text}\``;
      if (a?.bold) text = `**${text}**`;
      if (a?.italic) text = `*${text}*`;
      if (a?.strikethrough) text = `~~${text}~~`;
      const href = r.href ?? r.text?.link?.url;
      return href ? `[${text}](${href})` : text;
    })
    .join('');
}

function isListBlock(block: NotionBlock): boolean {
  return block.type === 'bulleted_list_item' || block.type === 'numbered_list_item' || block.type === 'to_do';
}

/** Returns null for a block with no markdown equivalent, recording its type. */
function renderBlock(block: NotionBlock, unsupported: Set<string>): string | null {
  const type = block.type;
  const data = (block as unknown as Record<string, { rich_text?: NotionRichText[] } | undefined>)[type];
  const text = richText(data?.rich_text);

  switch (type) {
    case 'paragraph':
      return text;
    case 'heading_1':
      return `# ${text}`;
    case 'heading_2':
      return `## ${text}`;
    case 'heading_3':
      return `### ${text}`;
    case 'bulleted_list_item':
      return `- ${text}`;
    case 'numbered_list_item':
      return `1. ${text}`;
    case 'to_do':
      return `- [${(block.to_do?.checked ?? false) ? 'x' : ' '}] ${text}`;
    case 'quote':
      return `> ${text}`;
    case 'callout':
      return `> ${text}`;
    case 'code':
      return `\`\`\`${block.code?.language ?? ''}\n${text}\n\`\`\``;
    case 'divider':
      return '---';
    case 'image': {
      const url = block.image?.external?.url ?? block.image?.file?.url;
      return url ? `![${richText(block.image?.caption) || 'image'}](${url})` : null;
    }
    case 'bookmark':
      return block.bookmark?.url ? `[${block.bookmark.url}](${block.bookmark.url})` : null;
    case 'toggle':
      // Rendered as its summary; children are appended by the caller.
      return text;
    case 'table_of_contents':
    case 'breadcrumb':
      // Navigation chrome, not content — deliberately dropped without a warning.
      return null;
    default:
      unsupported.add(type);
      return null;
  }
}

/**
 * Markdown → Notion blocks, covering the same constructs `renderBlock` reads.
 * Anything richer (tables, nested lists past one level) is emitted as a
 * paragraph so the text survives even when the structure does not.
 */
export function markdownToBlocks(markdown: string): NotionBlockInput[] {
  const blocks: NotionBlockInput[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  const para = (text: string, type = 'paragraph'): NotionBlockInput => ({
    object: 'block',
    type,
    [type]: { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }] },
  });

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      i += 1;
      continue;
    }
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i += 1;
      blocks.push({
        object: 'block',
        type: 'code',
        code: {
          language: notionLanguage(fence[1]),
          rich_text: [{ type: 'text', text: { content: body.join('\n').slice(0, 2000) } }],
        },
      });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(para(heading[2], `heading_${heading[1].length}`));
      i += 1;
      continue;
    }
    const todo = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (todo) {
      blocks.push({
        object: 'block',
        type: 'to_do',
        to_do: {
          checked: todo[1].toLowerCase() === 'x',
          rich_text: [{ type: 'text', text: { content: todo[2].slice(0, 2000) } }],
        },
      });
      i += 1;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push(para(bullet[1], 'bulleted_list_item'));
      i += 1;
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      blocks.push(para(numbered[1], 'numbered_list_item'));
      i += 1;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push(para(quote[1], 'quote'));
      i += 1;
      continue;
    }

    // Everything else folds into one paragraph up to the next blank line.
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3}\s|```|[-*]\s|>\s?|\d+[.)]\s)/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    blocks.push(para(buf.join(' ')));
  }

  return blocks;
}

/** Notion rejects unknown `code.language` values outright. */
const NOTION_LANGUAGES = new Set([
  'bash', 'c', 'c#', 'c++', 'css', 'diff', 'docker', 'go', 'graphql', 'html', 'java', 'javascript',
  'json', 'kotlin', 'less', 'lua', 'makefile', 'markdown', 'nginx', 'objective-c', 'php', 'plain text',
  'powershell', 'python', 'ruby', 'rust', 'sass', 'scala', 'scss', 'shell', 'sql', 'swift', 'typescript',
  'xml', 'yaml',
]);
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript', ts: 'typescript', sh: 'shell', zsh: 'shell', yml: 'yaml',
  md: 'markdown', py: 'python', rb: 'ruby', rs: 'rust', kt: 'kotlin', dockerfile: 'docker',
};
function notionLanguage(raw: string): string {
  const lang = (LANGUAGE_ALIASES[raw.toLowerCase()] ?? raw).toLowerCase();
  return NOTION_LANGUAGES.has(lang) ? lang : 'plain text';
}

function pageTitle(page: NotionPage): string | undefined {
  for (const value of Object.values(page.properties ?? {})) {
    if (value?.type === 'title') return richText(value.title) || undefined;
  }
  return undefined;
}

// --- upstream shapes (only the fields actually read) ---

interface NotionList {
  results?: Array<NotionPage & NotionBlock>;
  has_more?: boolean;
  next_cursor?: string | null;
}
interface NotionPage {
  id: string;
  object?: string;
  url?: string;
  archived?: boolean;
  last_edited_time?: string;
  properties?: Record<string, { type?: string; title?: NotionRichText[] } | undefined>;
}
interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  to_do?: { checked?: boolean };
  code?: { language?: string };
  image?: {
    caption?: NotionRichText[];
    external?: { url?: string };
    file?: { url?: string };
  };
  bookmark?: { url?: string };
}
interface NotionRichText {
  plain_text?: string;
  href?: string;
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean };
  text?: { content?: string; link?: { url?: string } };
}
export interface NotionBlockInput {
  object: 'block';
  type: string;
  [key: string]: unknown;
}
