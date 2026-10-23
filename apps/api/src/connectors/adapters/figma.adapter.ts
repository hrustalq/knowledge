import { Injectable } from '@nestjs/common';
import { FIGMA_ALLOWLIST_CONFIG_KEY, parseFigmaAllowlist, type ConnectorCapabilities, type ConnectorKind } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import type { ConnectorAdapter, ConnectorContext, ExternalDocument, ExternalRef } from './connector.types.js';
import { figmaAllowedFiles, figmaGet } from './figma.js';

/**
 * Figma (#470, docs/features/64), an **embed** connector: no content moves
 * either way — `pull` and `push` are false, so `list` and `fetch` are never
 * called. It holds the token every Figma call is made with and the allowlist
 * of teams and projects whose frames may be embedded.
 */
@Injectable()
export class FigmaAdapter implements ConnectorAdapter {
  readonly kind: ConnectorKind = 'figma';
  readonly capabilities: ConnectorCapabilities = { pull: false, push: false, webhook: false, tree: false, embeds: true };

  /** The token's owner, then how far the allowlist reaches — the two things a wrong setup gets wrong. */
  async testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }> {
    const me = await figmaGet<{ handle?: string; email?: string }>(ctx, '/v1/me');
    const allowlist = parseFigmaAllowlist(String(ctx.config[FIGMA_ALLOWLIST_CONFIG_KEY] ?? ''));
    if (allowlist.invalid.length) {
      return { ok: false, detail: t('error.connector.figmaAllowlistInvalid', { entries: allowlist.invalid.join(', ') }) };
    }
    const files = await figmaAllowedFiles(ctx);
    const projects = new Set(files.map((f) => f.projectId)).size;
    return {
      ok: true,
      detail: [me.handle ?? me.email, t('connector.figmaReach', { projects, files: files.length })].filter(Boolean).join(' · '),
    };
  }

  // eslint-disable-next-line require-yield
  async *list(): AsyncIterable<ExternalRef> {
    return;
  }

  fetch(): Promise<ExternalDocument> {
    return Promise.reject(new Error(t('error.connector.pullNotSupported', { kind: 'Figma' })));
  }
}
