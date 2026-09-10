import { Module } from '@nestjs/common';
import { ConfluenceAdapter } from './confluence.adapter.js';
import { ConfluenceServerAdapter } from './confluence-server.adapter.js';
import { ConnectorRegistry } from './connector.registry.js';
import { JiraAdapter } from './jira.adapter.js';
import { MarkdownGitAdapter } from './markdown-git.adapter.js';
import { NotionAdapter } from './notion.adapter.js';

/**
 * The adapters and their registry. No controllers and no auth dependencies, so
 * both the API (Test connection) and the worker (sync runs) can import it.
 */
@Module({
  providers: [
    ConfluenceAdapter,
    ConfluenceServerAdapter,
    JiraAdapter,
    NotionAdapter,
    MarkdownGitAdapter,
    ConnectorRegistry,
  ],
  exports: [ConnectorRegistry],
})
export class ConnectorAdaptersModule {}
