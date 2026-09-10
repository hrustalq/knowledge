import { Injectable } from '@nestjs/common';
import type { ConnectorKind } from '@knowledge/contracts';
import { ConfluenceAdapter } from './confluence.adapter.js';
import { ConfluenceServerAdapter } from './confluence-server.adapter.js';
import { JiraAdapter } from './jira.adapter.js';
import { MarkdownGitAdapter } from './markdown-git.adapter.js';
import { NotionAdapter } from './notion.adapter.js';
import type { ConnectorAdapter } from './connector.types.js';

/**
 * Kind -> adapter. Deliberately the `ParserRegistry` shape (feature 16): a DI
 * map built in the constructor, so adding an adapter is one provider and one
 * entry, and the compiler enforces that the catalogue in contracts is covered.
 */
@Injectable()
export class ConnectorRegistry {
  private readonly byKind: Record<ConnectorKind, ConnectorAdapter>;

  constructor(
    confluence: ConfluenceAdapter,
    confluenceServer: ConfluenceServerAdapter,
    jira: JiraAdapter,
    notion: NotionAdapter,
    markdownGit: MarkdownGitAdapter,
  ) {
    this.byKind = { confluence, 'confluence-server': confluenceServer, jira, notion, 'markdown-git': markdownGit };
  }

  /** Null when the kind is not one we ship — the caller turns that into a 400. */
  resolve(kind: string): ConnectorAdapter | null {
    return this.byKind[kind as ConnectorKind] ?? null;
  }

  all(): ConnectorAdapter[] {
    return Object.values(this.byKind);
  }
}
